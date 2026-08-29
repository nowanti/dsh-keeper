import { spawn } from 'node:child_process'

export interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxOutputBytes?: number
  discardOutput?: boolean
  platform?: NodeJS.Platform
}
export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

interface CommandInvocation {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

const WINDOWS_RUNNER = [
  "$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DSH_KEEPER_COMMAND_PAYLOAD)) | ConvertFrom-Json",
  'Remove-Item Env:\\DSH_KEEPER_COMMAND_PAYLOAD',
  '$arguments = @($payload.args)',
  '& $payload.command @arguments',
  'exit $LASTEXITCODE',
].join('; ')

/**
 * Windows package-manager shims are commonly .cmd files and cannot be spawned
 * directly by Node. Transfer the command and arguments as JSON in the child
 * environment so no user-controlled value is interpolated into shell source.
 */
export function commandInvocation(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): CommandInvocation {
  if (platform !== 'win32' || /\.(?:exe|com)$/i.test(command)) {
    return { command, args: [...args], env }
  }
  const payload = Buffer.from(JSON.stringify({ command, args }), 'utf8').toString('base64')
  return {
    command: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_RUNNER],
    env: { ...env, DSH_KEEPER_COMMAND_PAYLOAD: payload },
  }
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024
  const invocation = commandInvocation(
    command,
    args,
    options.env ?? process.env,
    options.platform ?? process.platform,
  )

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: invocation.env,
      shell: false,
      windowsHide: true,
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
