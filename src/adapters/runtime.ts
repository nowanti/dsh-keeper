import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'

import { translate, type Locale } from '../i18n.js'
import { runCommand, type CommandResult } from './process.js'

export interface RuntimeSpec {
  profile: string
  pid: number
  port: number | null
  cwd: string
}

export interface RuntimeController {
  inspect(profile: string): Promise<RuntimeSpec[]>
  stop(runtime: RuntimeSpec): Promise<void>
  start(runtime: RuntimeSpec, dshHome: string): Promise<RuntimeSpec>
}

export interface RuntimeControllerOptions {
  interruptGraceMs?: number
  terminateGraceMs?: number
  forceGraceMs?: number
  onProgress?: (message: string) => void
  locale?: Locale
  platform?: NodeJS.Platform
  runCommand?: typeof runCommand
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function windowsServiceCommandLine(binary: string, profile: string, port: number): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(profile) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) return null
  // cmd.exe expands these characters even when callers expect a single path
  // token. Reject uncommon custom paths instead of attempting fragile escaping.
  if (binary.trim() === '' || /["\r\n%&|<>^!]/.test(binary)) return null
  return `"${binary}" --profile ${profile} --port ${port}`
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return !processExists(pid)
}

async function portListens(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function waitForPort(pid: number, port: number, timeoutMs: number, requireLauncher: boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (requireLauncher && !processExists(pid)) return false
    if (await portListens(port)) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

export class DshRuntimeController implements RuntimeController {
  readonly #binary: string
  readonly #env: NodeJS.ProcessEnv
  readonly #interruptGraceMs: number
  readonly #terminateGraceMs: number
  readonly #forceGraceMs: number
  readonly #onProgress: ((message: string) => void) | undefined
  readonly #locale: Locale
  readonly #platform: NodeJS.Platform
  readonly #runCommand: typeof runCommand
  readonly #windowsLaunchers = new Map<number, number>()

  constructor(env: NodeJS.ProcessEnv = process.env, options: RuntimeControllerOptions = {}) {
    this.#binary = env.DSH_BIN?.trim() || 'dsh'
    this.#env = { ...env }
    this.#interruptGraceMs = options.interruptGraceMs ?? 10_000
    this.#terminateGraceMs = options.terminateGraceMs ?? 5_000
    this.#forceGraceMs = options.forceGraceMs ?? 3_000
    this.#onProgress = options.onProgress
    this.#locale = options.locale ?? 'en'
    this.#platform = options.platform ?? process.platform
    this.#runCommand = options.runCommand ?? runCommand
  }

  async inspect(profile: string): Promise<RuntimeSpec[]> {
    const result = this.#platform === 'win32'
      ? await this.#runCommand('powershell.exe', [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$items = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; command = [string]$_.CommandLine } }; @($items) | ConvertTo-Json -Compress",
        ], { timeoutMs: 15_000, env: this.#env, platform: this.#platform })
      : await this.#runCommand('ps', ['-ax', '-o', 'pid=,command='], { timeoutMs: 10_000, env: this.#env, platform: this.#platform })
    if (result.code !== 0 || result.timedOut) throw new Error(translate(this.#locale, 'error.processList'))
    const escaped = escapeRegExp(profile)
    const profilePattern = new RegExp(`(?:--profile(?:=|\\s+))${escaped}(?:\\s|$)`)
    const rows = this.#platform === 'win32' ? windowsProcessRows(result) : posixProcessRows(result)
    const matches: RuntimeSpec[] = []
    for (const { pid, command } of rows) {
      const isDsh = /(?:^|[\s/\\])dsh(?:\.cmd|\.exe)?(?:\s|$)/i.test(command)
        || /[\\/]@deepseek-ai[\\/]dsh[\\/]/i.test(command)
        || /[\\/]dsh[\\/][^\s"']+\.(?:m?js|cjs)(?:["']?\s|$)/i.test(command)
      if (!profilePattern.test(command) || !isDsh || /\b(?:dshk|dsh-keeper)\b/i.test(command)) continue
      const portMatch = /(?:--port(?:=|\s+))(\d+)(?:\s|$)/.exec(command)
      const cwdResult = this.#platform === 'win32' ? null : await this.#runCommand('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        timeoutMs: 5_000, env: this.#env, platform: this.#platform,
      }).catch(() => null)
      const cwd = cwdResult?.stdout.split('\n').find(value => value.startsWith('n'))?.slice(1) || process.cwd()
      matches.push({ profile, pid, port: portMatch === null ? null : Number(portMatch[1]), cwd })
    }
    return matches
  }

  async #windowsListenerPid(port: number): Promise<number | null> {
    const result = await this.#runCommand('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$connection = Get-NetTCPConnection -State Listen -LocalPort ([int]$env:DSH_KEEPER_TARGET_PORT) -ErrorAction SilentlyContinue | Select-Object -First 1; if ($null -ne $connection) { [Console]::Out.Write($connection.OwningProcess) }',
    ], {
      timeoutMs: 10_000,
      env: { ...this.#env, DSH_KEEPER_TARGET_PORT: String(port) },
      platform: this.#platform,
    })
    if (result.code !== 0 || result.timedOut) return null
    const pid = Number(result.stdout.trim())
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  }

  async #cleanupWindowsLauncher(servicePid: number): Promise<void> {
    const launcherPid = this.#windowsLaunchers.get(servicePid)
    this.#windowsLaunchers.delete(servicePid)
    if (launcherPid === undefined || launcherPid === servicePid || !processExists(launcherPid)) return
    await this.#runCommand('taskkill.exe', ['/PID', String(launcherPid), '/T', '/F'], {
      timeoutMs: this.#forceGraceMs,
      env: this.#env,
      platform: this.#platform,
    }).catch(() => undefined)
    await waitForExit(launcherPid, this.#forceGraceMs)
  }

  async stop(runtime: RuntimeSpec): Promise<void> {
    if (!processExists(runtime.pid)) {
      if (this.#platform === 'win32') await this.#cleanupWindowsLauncher(runtime.pid)
      return
    }
    if (this.#platform !== 'win32') {
      process.kill(runtime.pid, 'SIGINT')
      if (await waitForExit(runtime.pid, this.#interruptGraceMs)) return
    }
    process.kill(runtime.pid, 'SIGTERM')
    if (await waitForExit(runtime.pid, this.#terminateGraceMs)) {
      if (this.#platform === 'win32') await this.#cleanupWindowsLauncher(runtime.pid)
      return
    }
    if (runtime.port === null || await portListens(runtime.port)) {
      throw new Error(translate(this.#locale, 'error.processStillListening', { profile: runtime.profile, pid: runtime.pid }))
    }
    this.#onProgress?.(translate(this.#locale, 'progress.cleanupProcess', { profile: runtime.profile }))
    try {
      if (this.#platform === 'win32') {
        const result = await this.#runCommand('taskkill.exe', ['/PID', String(runtime.pid), '/T', '/F'], {
          timeoutMs: this.#forceGraceMs,
          env: this.#env,
          platform: this.#platform,
        })
        if (result.code !== 0 && processExists(runtime.pid)) throw new Error('taskkill failed')
      } else process.kill(runtime.pid, 'SIGKILL')
    } catch {
      if (!processExists(runtime.pid)) return
      throw new Error(translate(this.#locale, 'error.processForceFailed', { profile: runtime.profile, pid: runtime.pid }))
    }
    if (await waitForExit(runtime.pid, this.#forceGraceMs)) {
      if (this.#platform === 'win32') await this.#cleanupWindowsLauncher(runtime.pid)
      return
    }
    throw new Error(translate(this.#locale, 'error.processForceSurvived', { profile: runtime.profile, pid: runtime.pid }))
  }

  async start(runtime: RuntimeSpec, dshHome: string): Promise<RuntimeSpec> {
    if (runtime.port === null) throw new Error(translate(this.#locale, 'error.interactiveCannotRestore', { profile: runtime.profile }))
    if (await portListens(runtime.port)) throw new Error(translate(this.#locale, 'error.portInUse', { port: runtime.port, profile: runtime.profile }))
    const logPath = join(dshHome, `dsh-${runtime.profile}.log`)
    const pidPath = join(dshHome, 'run', `dsh-${runtime.profile}-${runtime.port}.pid`)
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
    mkdirSync(dirname(pidPath), { recursive: true, mode: 0o700 })
    const logFd = openSync(logPath, 'a', 0o600)
    const childOptions: SpawnOptions = {
      cwd: runtime.cwd,
      env: { ...this.#env, DSH_HOME: dshHome },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    }
    let child: ChildProcess
    if (this.#platform === 'win32') {
      const commandLine = windowsServiceCommandLine(this.#binary, runtime.profile, runtime.port)
      if (commandLine === null) throw new Error(translate(this.#locale, 'error.startFailed', { profile: runtime.profile }))
      // Windows needs cmd.exe to open npm's .cmd shim. Pass one strictly
      // validated command line and no args, avoiding Node's unsafe
      // shell-plus-args path.
      child = spawn(commandLine, { ...childOptions, shell: true })
    } else {
      child = spawn(this.#binary, ['--profile', runtime.profile, '--port', String(runtime.port)], { ...childOptions, shell: false })
    }
    closeSync(logFd)
    if (child.pid === undefined) throw new Error(translate(this.#locale, 'error.startFailed', { profile: runtime.profile }))
    child.unref()
    if (!await waitForPort(child.pid, runtime.port, 15_000, this.#platform !== 'win32')) {
      if (processExists(child.pid)) {
        if (this.#platform === 'win32') {
          await this.#runCommand('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeoutMs: 5_000, env: this.#env, platform: this.#platform }).catch(() => undefined)
        } else process.kill(child.pid, 'SIGTERM')
      }
      throw new Error(translate(this.#locale, 'error.portNotReady', { profile: runtime.profile, port: runtime.port, log: logPath }))
    }
    let servicePid = child.pid
    if (this.#platform === 'win32') {
      // The shell and .cmd shim are only launchers. Resolve the process that
      // actually owns the newly opened service port instead of guessing from
      // wrapper command lines.
      const listenerPid = await this.#windowsListenerPid(runtime.port)
      if (listenerPid === null) {
        await this.#runCommand('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeoutMs: 5_000, env: this.#env, platform: this.#platform }).catch(() => undefined)
        throw new Error(translate(this.#locale, 'error.startFailed', { profile: runtime.profile }))
      }
      servicePid = listenerPid
      this.#windowsLaunchers.set(servicePid, child.pid)
    }
    writeFileSync(pidPath, `${servicePid}\n`, { mode: 0o600 })
    return { ...runtime, pid: servicePid }
  }
}

interface ProcessRow {
  pid: number
  command: string
}

function posixProcessRows(result: CommandResult): ProcessRow[] {
  return result.stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    return match === null ? [] : [{ pid: Number(match[1]), command: match[2] ?? '' }]
  })
}

function windowsProcessRows(result: CommandResult): ProcessRow[] {
  if (result.stdout.trim() === '') return []
  try {
    const parsed = JSON.parse(result.stdout) as unknown
    const values = Array.isArray(parsed) ? parsed : [parsed]
    return values.flatMap(value => {
      if (value === null || typeof value !== 'object') return []
      const candidate = value as { pid?: unknown; command?: unknown }
      return typeof candidate.pid === 'number' && typeof candidate.command === 'string'
        ? [{ pid: candidate.pid, command: candidate.command }]
        : []
    })
  } catch {
    return []
  }
}
