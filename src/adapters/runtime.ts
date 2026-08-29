import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'

import { runCommand } from './process.js'

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

async function waitForPort(pid: number, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processExists(pid)) return false
    if (await portListens(port)) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

export class DshRuntimeController implements RuntimeController {
  readonly #binary: string
  readonly #env: NodeJS.ProcessEnv

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#binary = env.DSH_BIN?.trim() || 'dsh'
    this.#env = { ...env }
  }

  async inspect(profile: string): Promise<RuntimeSpec[]> {
    const result = await runCommand('ps', ['-ax', '-o', 'pid=,command='], { timeoutMs: 10_000, env: this.#env })
    if (result.code !== 0 || result.timedOut) throw new Error('无法读取正在运行的 DSH 进程')
    const escaped = escapeRegExp(profile)
    const profilePattern = new RegExp(`(?:--profile(?:=|\\s+))${escaped}(?:\\s|$)`)
    const matches: RuntimeSpec[] = []
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line)
      if (match === null) continue
      const pid = Number(match[1])
      const command = match[2] ?? ''
      if (!profilePattern.test(command) || !/(?:^|[\s/])dsh(?:\s|$)/.test(command) || command.includes('dshctl')) continue
      const portMatch = /(?:--port(?:=|\s+))(\d+)(?:\s|$)/.exec(command)
      const cwdResult = await runCommand('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        timeoutMs: 5_000,
        env: this.#env,
      }).catch(() => null)
      const cwd = cwdResult?.stdout.split('\n').find(value => value.startsWith('n'))?.slice(1) || process.cwd()
      matches.push({ profile, pid, port: portMatch === null ? null : Number(portMatch[1]), cwd })
    }
    return matches
  }

  async stop(runtime: RuntimeSpec): Promise<void> {
    if (!processExists(runtime.pid)) return
    process.kill(runtime.pid, 'SIGINT')
    if (await waitForExit(runtime.pid, 10_000)) return
    process.kill(runtime.pid, 'SIGTERM')
    if (await waitForExit(runtime.pid, 5_000)) return
    throw new Error(`${runtime.profile} 进程 ${runtime.pid} 未能优雅退出`)
  }

  async start(runtime: RuntimeSpec, dshHome: string): Promise<RuntimeSpec> {
    if (runtime.port === null) throw new Error(`${runtime.profile} 是交互式进程，无法自动恢复`)
    if (await portListens(runtime.port)) throw new Error(`端口 ${runtime.port} 已被占用，拒绝启动 ${runtime.profile}`)
    const logPath = join(dshHome, `dsh-${runtime.profile}.log`)
    const pidPath = join(dshHome, 'run', `dsh-${runtime.profile}-${runtime.port}.pid`)
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
    mkdirSync(dirname(pidPath), { recursive: true, mode: 0o700 })
    const logFd = openSync(logPath, 'a', 0o600)
    const child = spawn(this.#binary, ['--profile', runtime.profile, '--port', String(runtime.port)], {
      cwd: runtime.cwd,
      env: { ...this.#env, DSH_HOME: dshHome },
      detached: true,
      shell: false,
      stdio: ['ignore', logFd, logFd],
    })
    closeSync(logFd)
    if (child.pid === undefined) throw new Error(`无法启动 ${runtime.profile}`)
    child.unref()
    if (!await waitForPort(child.pid, runtime.port, 15_000)) {
      if (processExists(child.pid)) process.kill(child.pid, 'SIGTERM')
      throw new Error(`${runtime.profile} 启动后未在 ${runtime.port} 端口就绪；请查看 ${logPath}`)
    }
    writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 })
    return { ...runtime, pid: child.pid }
  }
}
