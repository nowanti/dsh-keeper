import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

import { scanNodeModulesVersions } from './profiles.js'
import { runCommand } from './process.js'

export interface ConfigProbe {
  ok: boolean
  timedOut: boolean
}

export interface DshInstallation {
  path: string
  versions: ReadonlyMap<string, string>
}

function executablePath(binary: string, env: NodeJS.ProcessEnv): string | null {
  const direct = isAbsolute(binary) || binary.includes('/') || binary.includes('\\')
    ? [resolve(binary)]
    : (env.PATH ?? '').split(delimiter).filter(Boolean).flatMap(directory => {
        if (process.platform !== 'win32') return [join(directory, binary)]
        const extensions = (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
        return extensions.map(extension => join(directory, `${binary}${extension.toLowerCase()}`))
      })
  for (const candidate of direct) {
    try {
      accessSync(candidate, constants.X_OK)
      return realpathSync(candidate)
    } catch {
      // Continue through PATH candidates.
    }
  }
  return null
}

function findDshInstallation(binary: string, env: NodeJS.ProcessEnv): DshInstallation | null {
  const entry = executablePath(binary, env)
  if (entry === null) return null
  let directory = dirname(entry)
  for (let depth = 0; depth < 12; depth += 1) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
        if (manifest.name === '@deepseek-ai/dsh') {
          const versions = scanNodeModulesVersions(directory)
          if (typeof manifest.version === 'string') versions.set('@deepseek-ai/dsh', manifest.version)
          return { path: directory, versions }
        }
      } catch {
        // Keep walking to the package root.
      }
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
  return null
}

export class DshAdapter {
  readonly binary: string
  readonly #env: NodeJS.ProcessEnv
  #installation: DshInstallation | null | undefined

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.binary = env.DSH_BIN?.trim() || 'dsh'
    this.#env = { ...env }
  }

  installation(): DshInstallation | null {
    if (this.#installation === undefined) this.#installation = findDshInstallation(this.binary, this.#env)
    return this.#installation
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
