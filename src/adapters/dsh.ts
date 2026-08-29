import { runCommand } from './process.js'

export interface ConfigProbe {
  ok: boolean
  timedOut: boolean
}

export class DshAdapter {
  readonly binary: string
  readonly #env: NodeJS.ProcessEnv

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.binary = env.DSH_BIN?.trim() || 'dsh'
    this.#env = { ...env }
  }

  async version(): Promise<string | null> {
    try {
      const result = await runCommand(this.binary, ['--version'], { timeoutMs: 10_000, env: this.#env })
      if (result.code !== 0 || result.timedOut) return null
      const value = result.stdout.trim().split(/\s+/)[0]
      return value && /^\d+\.\d+\.\d+/.test(value) ? value : null
    } catch {
      return null
    }
  }

  async checkConfig(profile: string): Promise<ConfigProbe> {
    try {
      const result = await runCommand(this.binary, ['--profile', profile, '--dump-config'], {
        timeoutMs: 30_000,
        discardOutput: true,
        env: this.#env,
      })
      return { ok: result.code === 0 && !result.timedOut, timedOut: result.timedOut }
    } catch {
      return { ok: false, timedOut: false }
    }
  }
}
