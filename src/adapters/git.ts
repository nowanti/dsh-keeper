import { runCommand } from './process.js'

export interface GitHubReference {
  owner: string
  repository: string
  ref: string | null
  exact: boolean
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPOSITORY = /^[A-Za-z0-9._-]+$/

export function parseGitHubReference(spec: string): GitHubReference | null {
  let match = /^github:([^/#\s]+)\/([^#\s]+)(?:#([^\s]+))?$/.exec(spec)
  if (match === null) {
    match = /^git\+https:\/\/github\.com\/([^/#\s]+)\/([^#\s]+?)(?:\.git)?(?:#([^\s]+))?$/.exec(spec)
  }
  if (match === null) return null
  const owner = match[1]
  const repository = match[2]?.replace(/\.git$/, '')
  const ref = match[3] ?? null
  if (owner === undefined || repository === undefined || !OWNER.test(owner) || !REPOSITORY.test(repository)) return null
  return {
    owner,
    repository,
    ref,
    exact: ref !== null && /^[0-9a-fA-F]{40}$/.test(ref),
  }
}

export class GitAdapter {
  readonly binary: string
  readonly #headCache = new Map<string, Promise<string | null>>()
  readonly #env: NodeJS.ProcessEnv

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.binary = env.GIT_BIN?.trim() || 'git'
    this.#env = { ...env }
  }

  head(reference: GitHubReference): Promise<string | null> {
    const key = `${reference.owner}/${reference.repository}`
    const existing = this.#headCache.get(key)
    if (existing !== undefined) return existing
    const pending = this.#readHead(reference)
    this.#headCache.set(key, pending)
    return pending
  }

  async #readHead(reference: GitHubReference): Promise<string | null> {
    const url = `https://github.com/${reference.owner}/${reference.repository}.git`
    const result = await runCommand(this.binary, ['ls-remote', url, 'HEAD'], {
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      env: this.#env,
    })
    if (result.code !== 0 || result.timedOut) return null
    const commit = result.stdout.trim().split(/\s+/)[0]
    return commit && /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : null
  }
}
