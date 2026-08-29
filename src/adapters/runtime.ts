import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'

import { translate, type Locale } from '../i18n.js'
import { commandInvocation, runCommand, type CommandResult } from './process.js'

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
      if (!profilePattern.test(command) || !isDsh || /dshkeeper/i.test(command)) continue
      const portMatch = /(?:--port(?:=|\s+))(\d+)(?:\s|$)/.exec(command)
      const cwdResult = this.#platform === 'win32' ? null : await this.#runCommand('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        timeoutMs: 5_000, env: this.#env, platform: this.#platform,
      }).catch(() => null)
      const cwd = cwdResult?.stdout.split('\n').find(value => value.startsWith('n'))?.slice(1) || process.cwd()
      matches.push({ profile, pid, port: portMatch === null ? null : Number(portMatch[1]), cwd })
    }
    return matches
  }

  async stop(runtime: RuntimeSpec): Promise<void> {
    if (!processExists(runtime.pid)) return
    if (this.#platform !== 'win32') {
      process.kill(runtime.pid, 'SIGINT')
      if (await waitForExit(runtime.pid, this.#interruptGraceMs)) return
    }
    process.kill(runtime.pid, 'SIGTERM')
    if (await waitForExit(runtime.pid, this.#terminateGraceMs)) return
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
    if (await waitForExit(runtime.pid, this.#forceGraceMs)) return
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
    const invocation = commandInvocation(
      this.#binary,
      ['--profile', runtime.profile, '--port', String(runtime.port)],
      { ...this.#env, DSH_HOME: dshHome },
      this.#platform,
    )
    const child = spawn(invocation.command, invocation.args, {
      cwd: runtime.cwd,
      env: invocation.env,
      detached: true,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    })
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
      const matches = await this.inspect(runtime.profile)
      const service = matches.find(item => item.port === runtime.port)
      if (service === undefined) {
        await this.#runCommand('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeoutMs: 5_000, env: this.#env, platform: this.#platform }).catch(() => undefined)
        throw new Error(translate(this.#locale, 'error.startFailed', { profile: runtime.profile }))
      }
      servicePid = service.pid
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
