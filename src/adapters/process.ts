import { spawn } from 'node:child_process'

export interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxOutputBytes?: number
  discardOutput?: boolean
}
export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024

  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)

    const collect = (chunks: Buffer[], current: number, chunk: Buffer): number => {
      if (options.discardOutput === true) return current
      const remaining = maxOutputBytes - current
      if (remaining <= 0) return current
      const value = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
      chunks.push(value)
      return current + value.length
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = collect(stdout, stdoutBytes, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = collect(stderr, stderrBytes, chunk)
    })
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      })
    })
  })
}
