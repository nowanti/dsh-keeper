import { gt, valid } from 'semver'

import { DshAdapter } from './adapters/dsh.js'
import { GitAdapter, parseGitHubReference } from './adapters/git.js'
import { PnpmAdapter, type OutdatedEntry } from './adapters/pnpm.js'
import {
  dependencySource,
  discoverProfiles,
  dshHomeFromEnvironment,
  patchEvidence,
  readInstalledManifest,
  type ProfileInventory,
} from './adapters/profiles.js'
import { evaluateCompatibility } from './core/compatibility.js'
import { diagnostic, type Diagnostic } from './core/diagnostics.js'
import { newerCandidateVersions } from './core/selection.js'
import type {
  AssessmentReceipt,
  AssessmentSummary,
  CompatibilityEvaluation,
  CompatibilityHost,
  CoreAssessment,
  DependencyAssessment,
  NpmCandidate,
  PackageManifest,
  ProfileAssessment,
} from './core/types.js'
import { translate, type Locale } from './i18n.js'

const MAX_VERSION_CANDIDATES = 30

export interface AssessmentOptions {
  command: 'status' | 'upgrade'
  profile?: string
  pluginsOnly: boolean
  preview: boolean
  env?: NodeJS.ProcessEnv
  locale?: Locale
  onProgress?: (message: string) => void
}
interface Adapters {
  dsh: DshAdapter
  pnpm: PnpmAdapter
  git: GitAdapter
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function withCandidateSafety(
  base: CompatibilityEvaluation,
  currentManifest: PackageManifest | null,
  candidateManifest: PackageManifest,
  hasPatch: boolean,
): CompatibilityEvaluation {
  const warnings = [...base.warnings]
  let state = base.state
  const currentScripts = new Set(
    ['preinstall', 'install', 'postinstall'].filter(name => {
      const value = currentManifest?.scripts?.[name]
      return typeof value === 'string' && value.trim() !== ''
    }),
  )
  const addedScripts = base.installScripts.filter(name => !currentScripts.has(name))
  if (addedScripts.length > 0) {
    warnings.push(diagnostic('reason.addedLifecycleScript', { scripts: addedScripts.join(', ') }))
    if (state === 'declared') state = 'unknown'
  }
  if (!sameJson(currentManifest?.dsh?.permissions, candidateManifest.dsh?.permissions)) {
    warnings.push(diagnostic('reason.permissionsChanged'))
    if (state === 'declared') state = 'unknown'
  }
  if (hasPatch) {
    warnings.push(diagnostic('reason.localPatch'))
    if (state === 'declared') state = 'unknown'
  }
  if (candidateManifest.dist?.integrity === undefined) {
    warnings.push(diagnostic('reason.missingIntegrity'))
    if (state === 'declared') state = 'unknown'
  }
  return { ...base, state, warnings }
}

async function mapLimit<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= values.length) return
      const value = values[index]
      if (value !== undefined) output[index] = await mapper(value)
    }
  })
  await Promise.all(workers)
  return output
}

function currentDependency(
  inventory: ProfileInventory,
  name: string,
  requested: string,
): Omit<DependencyAssessment, 'latestVersion' | 'recommended' | 'latestEvaluation' | 'git' | 'checkedCandidates' | 'status' | 'messages'> {
  const installedManifest = readInstalledManifest(inventory.path, name)
  const installedVersion = installedManifest?.version ?? inventory.installedVersions.get(name) ?? null
  return {
    name,
    requested,
    installedVersion,
    source: dependencySource(requested),
    activeBundle: inventory.bundles.has(name),
    patch: patchEvidence(inventory, name, installedVersion),
  }
}

async function assessNpmDependency(
  inventory: ProfileInventory,
  name: string,
  requested: string,
  outdated: OutdatedEntry | undefined,
  dshVersion: string,
  options: AssessmentOptions,
  adapters: Adapters,
  hostVersions: ReadonlyMap<string, string>,
): Promise<DependencyAssessment> {
  const current = currentDependency(inventory, name, requested)
  const messages: Diagnostic[] = []
  if (current.installedVersion === null) {
    return {
      ...current,
      latestVersion: outdated?.latest ?? null,
      recommended: null,
      latestEvaluation: null,
      git: null,
      checkedCandidates: 0,
      status: 'blocked',
      messages: [diagnostic('reason.installedManifestMissing')],
    }
  }

  if (options.command === 'status') {
    return {
      ...current,
      latestVersion: null,
      recommended: null,
      latestEvaluation: null,
      git: null,
      checkedCandidates: 0,
      status: 'current',
      messages,
    }
  }

  const shouldQuery = options.preview || outdated?.latest !== undefined
  if (!shouldQuery) {
    return {
      ...current,
      latestVersion: null,
      recommended: null,
      latestEvaluation: null,
      git: null,
      checkedCandidates: 0,
      status: 'current',
      messages,
    }
  }

  try {
    const versions = await adapters.pnpm.versions(name)
    const candidates = newerCandidateVersions(versions, current.installedVersion, options.preview)
    const latestVersion = candidates[0] ?? outdated?.latest ?? null
    if (candidates.length === 0) {
      return {
        ...current,
        latestVersion,
        recommended: null,
        latestEvaluation: null,
        git: null,
        checkedCandidates: 0,
        status: 'current',
        messages,
      }
    }

    const currentManifest = readInstalledManifest(inventory.path, name)
    const installedVersions = new Map(hostVersions)
    for (const [packageName, version] of inventory.installedVersions) installedVersions.set(packageName, version)
    const host: CompatibilityHost = {
      dshVersion,
      nodeVersion: process.versions.node,
      installedVersions,
    }
    let latestEvaluation: CompatibilityEvaluation | null = null
    let recommended: NpmCandidate | null = null
    let checkedCandidates = 0

    for (const version of candidates.slice(0, MAX_VERSION_CANDIDATES)) {
      const manifest = await adapters.pnpm.manifest(name, version)
      let evaluation = evaluateCompatibility(manifest, host)
      evaluation = withCandidateSafety(evaluation, currentManifest, manifest, current.patch !== null)
      checkedCandidates += 1
      if (latestEvaluation === null) latestEvaluation = evaluation
      if (evaluation.state === 'declared') {
        recommended = {
          version,
          integrity: manifest.dist?.integrity ?? null,
          evaluation,
        }
        break
      }
    }

    if (recommended !== null) {
      messages.push(diagnostic('reason.compatibleCandidate', { version: recommended.version }))
      return {
        ...current,
        latestVersion,
        recommended,
        latestEvaluation,
        git: null,
        checkedCandidates,
        status: 'upgrade',
        messages,
      }
    }

    const latestState = latestEvaluation?.state ?? 'unknown'
    messages.push(
      latestState === 'blocked'
        ? diagnostic('reason.newerBlocked')
        : diagnostic('reason.newerUnknown'),
    )
    if (candidates.length > MAX_VERSION_CANDIDATES) {
      messages.push(diagnostic('reason.candidateLimit', { limit: MAX_VERSION_CANDIDATES }))
    }
    return {
      ...current,
      latestVersion,
      recommended: null,
      latestEvaluation,
      git: null,
      checkedCandidates,
      status: 'hold',
      messages,
    }
  } catch {
    messages.push(diagnostic('reason.npmMetadataUnavailable'))
    return {
      ...current,
      latestVersion: outdated?.latest ?? null,
      recommended: null,
      latestEvaluation: null,
      git: null,
      checkedCandidates: 0,
      status: 'unknown',
      messages,
    }
  }
}

async function assessGitDependency(
  inventory: ProfileInventory,
  name: string,
  requested: string,
  options: AssessmentOptions,
  adapters: Adapters,
): Promise<DependencyAssessment> {
  const current = currentDependency(inventory, name, requested)
  const reference = parseGitHubReference(requested)
  if (reference === null) {
    return {
      ...current,
      latestVersion: null,
      recommended: null,
      latestEvaluation: null,
      git: null,
      checkedCandidates: 0,
      status: 'blocked',
      messages: [diagnostic('reason.githubFormatInvalid')],
    }
  }
  const repository = `${reference.owner}/${reference.repository}`
  if (!reference.exact) {
    return {
      ...current,
      latestVersion: null,
      recommended: null,
      latestEvaluation: null,
      git: {
        repository,
        currentCommit: reference.ref,
        headCommit: null,
        exact: false,
        updateAvailable: false,
        error: diagnostic('reason.githubNotPinned'),
      },
      checkedCandidates: 0,
      status: 'blocked',
      messages: [diagnostic('reason.githubNotPinned')],
    }
  }
  if (options.command === 'status') {
    return {
      ...current,
      latestVersion: null,
      recommended: null,
      latestEvaluation: null,
      git: {
        repository,
        currentCommit: reference.ref,
        headCommit: null,
        exact: true,
        updateAvailable: false,
        error: null,
      },
      checkedCandidates: 0,
      status: current.installedVersion === null ? 'blocked' : 'current',
      messages: current.installedVersion === null ? [diagnostic('reason.gitInstalledManifestMissing')] : [],
    }
  }

  const headCommit = await adapters.git.head(reference)
  const currentCommit = reference.ref?.toLowerCase() ?? null
  const updateAvailable = headCommit !== null && currentCommit !== headCommit
  const error = headCommit === null ? diagnostic('reason.gitRemoteUnavailable') : null
  const messages = error !== null
    ? [error]
    : updateAvailable
      ? [diagnostic('reason.gitHeadChanged')]
      : []
  return {
    ...current,
    latestVersion: null,
    recommended: null,
    latestEvaluation: null,
    git: {
      repository,
      currentCommit,
      headCommit,
      exact: true,
      updateAvailable,
      error,
    },
    checkedCandidates: 0,
    status: error !== null ? 'unknown' : updateAvailable ? 'hold' : 'current',
    messages,
  }
}

async function assessOtherDependency(
  inventory: ProfileInventory,
  name: string,
  requested: string,
): Promise<DependencyAssessment> {
  const current = currentDependency(inventory, name, requested)
  return {
    ...current,
    latestVersion: null,
    recommended: null,
    latestEvaluation: null,
    git: null,
    checkedCandidates: 0,
    status: current.source === 'linked' ? 'unknown' : 'blocked',
    messages: [diagnostic(current.source === 'linked' ? 'reason.linkedNotChecked' : 'reason.sourceUnknown')],
  }
}

async function assessProfile(
  inventory: ProfileInventory,
  dshVersion: string,
  options: AssessmentOptions,
  adapters: Adapters,
  hostVersions: ReadonlyMap<string, string>,
): Promise<ProfileAssessment> {
  const warnings: Diagnostic[] = []
  const locale = options.locale ?? 'en'
  options.onProgress?.(translate(locale, 'progress.profileIndex', { profile: inventory.name }))
  const [configProbe, outdated] = await Promise.all([
    adapters.dsh.checkConfig(inventory.name),
    options.command === 'upgrade'
      ? adapters.pnpm.outdated(inventory.path).catch(() => {
          warnings.push(diagnostic('reason.pnpmOutdatedFailed'))
          return {} as Record<string, OutdatedEntry>
        })
      : Promise.resolve({} as Record<string, OutdatedEntry>),
  ])

  const entries = [...inventory.dependencies.entries()]
  const dependencies = await mapLimit(entries, 6, async ([name, requested]) => {
    options.onProgress?.(translate(locale, 'progress.dependency', { profile: inventory.name, name }))
    const source = dependencySource(requested)
    if (source === 'npm') {
      return assessNpmDependency(inventory, name, requested, outdated[name], dshVersion, options, adapters, hostVersions)
    }
    if (source === 'github') return assessGitDependency(inventory, name, requested, options, adapters)
    return assessOtherDependency(inventory, name, requested)
  })

  return {
    name: inventory.name,
    path: inventory.path,
    config: configProbe.ok ? 'passed' : 'failed',
    dependencyCount: inventory.dependencies.size,
    bundleCount: inventory.bundles.size,
    dependencies: dependencies.sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  }
}

async function assessCore(
  current: string | null,
  options: AssessmentOptions,
  pnpm: PnpmAdapter,
): Promise<CoreAssessment> {
  if (current === null) {
    return { current: null, recommended: null, preview: null, action: 'unknown', reason: diagnostic('reason.dshVersionUnavailable') }
  }
  if (options.command === 'status') {
    return { current, recommended: null, preview: null, action: 'current', reason: diagnostic('reason.statusLocalOnly') }
  }
  if (options.pluginsOnly) {
    return { current, recommended: current, preview: null, action: 'current', reason: diagnostic('reason.pluginsOnly') }
  }
  try {
    options.onProgress?.(translate(options.locale ?? 'en', 'progress.core'))
    const tags = await pnpm.coreTags()
    if (tags.latest === null) {
      return { current, recommended: null, preview: tags.next, action: 'unknown', reason: diagnostic('reason.dshLatestUnavailable') }
    }
    if (valid(current) !== null && valid(tags.latest) !== null && gt(tags.latest, current)) {
      return {
        current,
        recommended: tags.latest,
        preview: tags.next,
        action: 'hold',
        reason: diagnostic('reason.dshUpgradeUnsupported'),
      }
    }
    return {
      current,
      recommended: tags.latest,
      preview: tags.next,
      action: 'current',
      reason: diagnostic(tags.latest === current ? 'reason.dshCurrent' : 'reason.dshNoForwardUpdate'),
    }
  } catch {
    return { current, recommended: null, preview: null, action: 'unknown', reason: diagnostic('reason.dshChannelUnavailable') }
  }
}

function summarize(profiles: readonly ProfileAssessment[]): AssessmentSummary {
  const dependencies = profiles.flatMap(profile => profile.dependencies)
  return {
    profiles: profiles.length,
    dependencies: dependencies.length,
    recommendedUpdates: dependencies.filter(item => item.status === 'upgrade').length,
    heldUpdates: dependencies.filter(item => item.status === 'hold').length,
    unknown: dependencies.filter(item => item.status === 'unknown').length,
    blocked: dependencies.filter(item => item.status === 'blocked').length
      + profiles.filter(profile => profile.config === 'failed').length,
  }
}

export async function assessEnvironment(options: AssessmentOptions): Promise<AssessmentReceipt> {
  const locale = options.locale ?? 'en'
  options.onProgress?.(translate(locale, 'progress.readEnvironment'))
  const env = options.env ?? process.env
  const dshHome = dshHomeFromEnvironment(env)
  const allProfiles = discoverProfiles(dshHome)
  const inventories = options.profile === undefined
    ? allProfiles
    : allProfiles.filter(profile => profile.name === options.profile)
  if (inventories.length === 0) {
    throw new Error(options.profile === undefined
      ? translate(locale, 'error.noProfiles', { home: dshHome })
      : translate(locale, 'error.profileNotFound', { profile: options.profile }))
  }

  const adapters: Adapters = {
    dsh: new DshAdapter(env),
    pnpm: new PnpmAdapter(env, locale),
    git: new GitAdapter(env),
  }
  const currentDsh = await adapters.dsh.version()
  options.onProgress?.(translate(locale, 'progress.readHost'))
  const hostVersions = adapters.dsh.installation()?.versions ?? new Map<string, string>()
  const dshVersionForEvaluation = currentDsh ?? '0.0.0-unknown'
  const [core, profiles] = await Promise.all([
    assessCore(currentDsh, options, adapters.pnpm),
    mapLimit(inventories, 2, inventory => assessProfile(inventory, dshVersionForEvaluation, options, adapters, hostVersions)),
  ])

  options.onProgress?.(translate(locale, 'progress.summarize'))
  return {
    schemaVersion: 2,
    mode: options.command === 'upgrade' ? 'read-only-upgrade' : 'status',
    generatedAt: new Date().toISOString(),
    dshHome,
    core,
    profiles,
    summary: summarize(profiles),
  }
}
