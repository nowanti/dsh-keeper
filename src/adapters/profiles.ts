import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'

import type { DependencySource, PackageManifest, PatchEvidence } from '../core/types.js'

const MAX_JSON_BYTES = 5 * 1024 * 1024
const MAX_PATCH_BYTES = 10 * 1024 * 1024
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

interface ProfileManifest extends PackageManifest {
  dependencies?: Record<string, string>
  pnpm?: {
    patchedDependencies?: Record<string, string>
  }
  dsh?: PackageManifest['dsh'] & {
    profile?: {
      bundles?: string[]
    }
  }
}

export interface ProfileInventory {
  name: string
  path: string
  manifest: ProfileManifest
  dependencies: ReadonlyMap<string, string>
  bundles: ReadonlySet<string>
  installedVersions: ReadonlyMap<string, string>
}

export function dshHomeFromEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  return resolve(configured && configured !== '' ? configured : join(homedir(), '.dsh'))
}

export function isPackageName(value: string): boolean {
  return PACKAGE_NAME.test(value)
}

function readJson(path: string): PackageManifest {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error(`manifest size is invalid: ${path}`)
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

function installedManifestPath(profileDir: string, name: string): string | null {
  if (!isPackageName(name)) return null
  const path = join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
  return existsSync(path) ? path : null
}

export function readInstalledManifest(profileDir: string, name: string): PackageManifest | null {
  const path = installedManifestPath(profileDir, name)
  if (path === null) return null
  try {
    return readJson(path)
  } catch {
    return null
  }
}

export function scanNodeModulesVersions(packageRoot: string): Map<string, string> {
  const root = join(packageRoot, 'node_modules')
  const versions = new Map<string, string>()
  if (!existsSync(root)) return versions

  const record = (name: string): void => {
    if (!isPackageName(name)) return
    const path = join(root, ...name.split('/'), 'package.json')
    try {
      const manifest = readJson(path)
      if (typeof manifest.version === 'string') versions.set(name, manifest.version)
    } catch {
      // Broken or incomplete package trees are represented by a missing version.
    }
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      const scopePath = join(root, entry.name)
      try {
        for (const child of readdirSync(scopePath, { withFileTypes: true })) {
          record(`${entry.name}/${child.name}`)
        }
      } catch {
        // A broken scope link is represented by the missing version.
      }
    } else {
      record(entry.name)
    }
  }
  return versions
}

export function discoverProfiles(dshHome: string): ProfileInventory[] {
  const profilesRoot = join(dshHome, 'profiles')
  if (!existsSync(profilesRoot)) return []

  const profiles: ProfileInventory[] = []
  for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue
    const profileDir = join(profilesRoot, entry.name)
    const manifestPath = join(profileDir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath) as ProfileManifest
    const dependencies = new Map(Object.entries(manifest.dependencies ?? {}).filter(([name]) => isPackageName(name)))
    const bundles = new Set((manifest.dsh?.profile?.bundles ?? []).filter(isPackageName))
    profiles.push({
      name: basename(profileDir),
      path: resolve(profileDir),
      manifest,
      dependencies,
      bundles,
      installedVersions: scanNodeModulesVersions(profileDir),
    })
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name))
}

export function dependencySource(spec: string): DependencySource {
  if (spec.startsWith('github:') || spec.startsWith('git+https://github.com/')) return 'github'
  if (spec.startsWith('file:') || spec.startsWith('link:') || spec.startsWith('workspace:')) return 'linked'
  if (/^(?:[~^<>=*]|\d)/.test(spec) || /^[A-Za-z][A-Za-z0-9._-]*$/.test(spec)) return 'npm'
  return 'unknown'
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)
}

export function patchEvidence(
  inventory: ProfileInventory,
  dependency: string,
  installedVersion: string | null,
): PatchEvidence | null {
  const patches = inventory.manifest.pnpm?.patchedDependencies ?? {}
  const prefix = `${dependency}@`
  const match = Object.entries(patches).find(([key]) => {
    return installedVersion !== null ? key === `${dependency}@${installedVersion}` : key.startsWith(prefix)
  })
  if (match === undefined) return null
  const patchPath = resolve(inventory.path, match[1])
  const safe = pathInside(inventory.path, patchPath)
  if (!safe || !existsSync(patchPath)) {
    return { path: match[1], exists: false, sha256: null }
  }
  try {
    const stat = lstatSync(patchPath)
    if (!stat.isFile() || stat.size > MAX_PATCH_BYTES) {
      return { path: match[1], exists: false, sha256: null }
    }
    const sha256 = createHash('sha256').update(readFileSync(patchPath)).digest('hex')
    return { path: match[1], exists: true, sha256 }
  } catch {
    return { path: match[1], exists: false, sha256: null }
  }
}
