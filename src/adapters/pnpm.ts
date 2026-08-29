import type { PackageManifest } from '../core/types.js'
import { isPackageName } from './profiles.js'
import { runCommand } from './process.js'

export interface OutdatedEntry {
  current?: string
  latest?: string
  wanted?: string
  isDeprecated?: boolean
  dependencyType?: string
}

export interface CoreTags {
  latest: string | null
  next: string | null
}

function parseJson<T>(value: string): T {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error('empty JSON output')
  return JSON.parse(trimmed) as T
}

function safeFailureSummary(value: string): string {
  const scrubbed = value
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@')
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
  const lines = scrubbed.split('\n').map(line => line.trim()).filter(Boolean)
  const diagnostic = lines.filter(line => /(?:ERR_|fatal:|Command failed|repository|could not read|not found|permission denied)/i.test(line))
  return (diagnostic.length > 0 ? diagnostic.slice(0, 4) : lines.slice(-4)).map(line => line.slice(0, 300)).join(' | ')
}

export class PnpmAdapter {
  readonly binary: string
  readonly #versionCache = new Map<string, Promise<string[]>>()
  readonly #manifestCache = new Map<string, Promise<PackageManifest>>()
  readonly #env: NodeJS.ProcessEnv

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.binary = env.PNPM_BIN?.trim() || 'pnpm'
    this.#env = { ...env }
  }

  async outdated(profileDir: string): Promise<Record<string, OutdatedEntry>> {
    const result = await runCommand(this.binary, ['outdated', '--format', 'json'], {
      cwd: profileDir,
      timeoutMs: 60_000,
      env: this.#env,
    })
    if (result.stdout.trim() === '' && result.code === 0) return {}
    if (result.code !== 0 && result.code !== 1) throw new Error('pnpm outdated failed')
    const parsed = parseJson<Record<string, OutdatedEntry>>(result.stdout)
    return parsed && typeof parsed === 'object' ? parsed : {}
  }

  async addToStore(packages: ReadonlyArray<{ name: string; version: string }>): Promise<void> {
    const unique = [...new Set(packages.map(item => {
      if (!isPackageName(item.name) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(item.version)) {
        throw new Error(`invalid package candidate: ${item.name}@${item.version}`)
      }
      return `${item.name}@${item.version}`
    }))]
    if (unique.length === 0) return
    const result = await runCommand(this.binary, ['store', 'add', ...unique], {
      timeoutMs: 5 * 60_000,
      env: this.#env,
    })
    if (result.code !== 0 || result.timedOut) {
      if (result.timedOut) throw new Error('pnpm store add 超时')
      const detail = safeFailureSummary(result.stderr || result.stdout)
      throw new Error(detail === '' ? 'pnpm store add 失败' : `pnpm store add 失败：${detail}`)
    }
  }

  async install(profileDir: string, options: { offline?: boolean } = {}): Promise<void> {
    const args = ['install', '--no-frozen-lockfile']
    if (options.offline === true) args.push('--offline')
    const result = await runCommand(this.binary, args, {
      cwd: profileDir,
      timeoutMs: 5 * 60_000,
      env: this.#env,
    })
    if (result.code !== 0 || result.timedOut) {
      if (result.timedOut) throw new Error('pnpm install 超时')
      const detail = safeFailureSummary(result.stderr || result.stdout)
      throw new Error(detail === '' ? 'pnpm install 失败' : `pnpm install 失败：${detail}`)
    }
  }

  async coreTags(): Promise<CoreTags> {
    const result = await runCommand(this.binary, ['view', '@deepseek-ai/dsh', 'dist-tags', '--json'], {
      timeoutMs: 30_000,
      env: this.#env,
    })
    if (result.code !== 0 || result.timedOut) throw new Error('cannot read DSH dist-tags')
    const parsed = parseJson<Record<string, unknown>>(result.stdout)
    return {
      latest: typeof parsed.latest === 'string' ? parsed.latest : null,
      next: typeof parsed.next === 'string' ? parsed.next : null,
    }
  }

  versions(name: string): Promise<string[]> {
    const existing = this.#versionCache.get(name)
    if (existing !== undefined) return existing
    const pending = this.#readVersions(name)
    this.#versionCache.set(name, pending)
    return pending
  }

  manifest(name: string, version: string): Promise<PackageManifest> {
    const key = `${name}@${version}`
    const existing = this.#manifestCache.get(key)
    if (existing !== undefined) return existing
    const pending = this.#readManifest(name, version)
    this.#manifestCache.set(key, pending)
    return pending
  }

  async #readVersions(name: string): Promise<string[]> {
    if (!isPackageName(name)) throw new Error(`invalid package name: ${name}`)
    const result = await runCommand(this.binary, ['view', name, 'versions', '--json'], {
      timeoutMs: 30_000,
      env: this.#env,
    })
    if (result.code !== 0 || result.timedOut) throw new Error(`cannot read versions for ${name}`)
    const parsed = parseJson<unknown>(result.stdout)
    if (typeof parsed === 'string') return [parsed]
    if (!Array.isArray(parsed) || !parsed.every(value => typeof value === 'string')) {
      throw new Error(`invalid version list for ${name}`)
    }
    return parsed
  }

  async #readManifest(name: string, version: string): Promise<PackageManifest> {
    if (!isPackageName(name) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`invalid package candidate: ${name}@${version}`)
    }
    const result = await runCommand(this.binary, ['view', `${name}@${version}`, '--json'], {
      timeoutMs: 30_000,
      env: this.#env,
    })
    if (result.code !== 0 || result.timedOut) throw new Error(`cannot read manifest for ${name}@${version}`)
    const parsed = parseJson<PackageManifest>(result.stdout)
    if (parsed === null || typeof parsed !== 'object') throw new Error(`invalid manifest for ${name}@${version}`)
    return parsed
  }
}
