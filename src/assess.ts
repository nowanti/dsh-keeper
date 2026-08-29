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

const MAX_VERSION_CANDIDATES = 30

export interface AssessmentOptions {
  command: 'status' | 'upgrade'
  profile?: string
  pluginsOnly: boolean
  preview: boolean
  env?: NodeJS.ProcessEnv
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
    warnings.push(`新增 lifecycle script: ${addedScripts.join(', ')}`)
    if (state === 'declared') state = 'unknown'
  }
  if (!sameJson(currentManifest?.dsh?.permissions, candidateManifest.dsh?.permissions)) {
    warnings.push('DSH permissions 声明发生变化')
    if (state === 'declared') state = 'unknown'
  }
  if (hasPatch) {
    warnings.push('当前版本带本地 patch，候选版本尚未验证 patch 可应用')
    if (state === 'declared') state = 'unknown'
  }
  if (candidateManifest.dist?.integrity === undefined) {
    warnings.push('npm 候选缺少 integrity')
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
  const messages: string[] = []
  if (current.installedVersion === null) {
    return {
      ...current,
      latestVersion: outdated?.latest ?? null,
      recommended: null,
      latestEvaluation: null,
      git: null,
      checkedCandidates: 0,
      status: 'blocked',
      messages: ['依赖写在 profile 中，但 node_modules 没有可读的已安装 manifest'],
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
      messages.push(`发现声明兼容候选 ${recommended.version}；尚需隔离安装和运行验证`)
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
        ? '较新版本与当前 DSH/Node/peer contract 冲突，保持当前版本'
        : '较新版本缺少足够兼容证据，保持当前版本',
    )
    if (candidates.length > MAX_VERSION_CANDIDATES) {
      messages.push(`为限制 registry 请求，只检查了前 ${MAX_VERSION_CANDIDATES} 个候选`)
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
    messages.push('无法取得完整 npm 候选元数据，未做升级建议')
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
      messages: ['GitHub dependency 格式无法安全解析'],
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
        error: '依赖没有固定到完整 commit',
      },
      checkedCandidates: 0,
      status: 'blocked',
      messages: ['GitHub dependency 没有固定到完整 commit，拒绝自动更新'],
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
      messages: current.installedVersion === null ? ['固定 Git 依赖没有已安装 manifest'] : [],
    }
  }

  const headCommit = await adapters.git.head(reference)
  const currentCommit = reference.ref?.toLowerCase() ?? null
  const updateAvailable = headCommit !== null && currentCommit !== headCommit
  const error = headCommit === null ? '无法读取远端 HEAD；仓库可能不可达或已删除' : null
  const messages = error !== null
    ? [error]
    : updateAvailable
      ? ['远端 HEAD 已变化，但新 commit 未经过 manifest 和隔离运行验证，保持当前 commit']
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
    messages: [current.source === 'linked' ? '本地依赖不参与 registry 更新' : '无法识别依赖来源'],
  }
}

async function assessProfile(
  inventory: ProfileInventory,
  dshVersion: string,
  options: AssessmentOptions,
  adapters: Adapters,
  hostVersions: ReadonlyMap<string, string>,
): Promise<ProfileAssessment> {
  const warnings: string[] = []
  options.onProgress?.(`正在检查 ${inventory.name} 的配置与更新索引`)
  const [configProbe, outdated] = await Promise.all([
    adapters.dsh.checkConfig(inventory.name),
    options.command === 'upgrade'
      ? adapters.pnpm.outdated(inventory.path).catch(() => {
          warnings.push('pnpm outdated 失败；npm 更新结果不完整')
          return {} as Record<string, OutdatedEntry>
        })
      : Promise.resolve({} as Record<string, OutdatedEntry>),
  ])

  const entries = [...inventory.dependencies.entries()]
  const dependencies = await mapLimit(entries, 6, async ([name, requested]) => {
    options.onProgress?.(`正在检查 ${inventory.name}: ${name}`)
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
    return { current: null, recommended: null, preview: null, action: 'unknown', message: '无法读取 DSH 版本' }
  }
  if (options.command === 'status') {
    return { current, recommended: null, preview: null, action: 'current', message: 'status 不查询远端版本' }
  }
  if (options.pluginsOnly) {
    return { current, recommended: current, preview: null, action: 'current', message: '已按 --plugins-only 固定 DSH' }
  }
  try {
    options.onProgress?.('正在检查 DSH 推荐版本')
    const tags = await pnpm.coreTags()
    if (tags.latest === null) {
      return { current, recommended: null, preview: tags.next, action: 'unknown', message: 'npm 没有可用的 DSH latest tag' }
    }
    if (valid(current) !== null && valid(tags.latest) !== null && gt(tags.latest, current)) {
      return {
        current,
        recommended: tags.latest,
        preview: tags.next,
        action: 'hold',
        message: '发现较新的推荐 DSH；DSH 核心切换尚未纳入本次插件事务，因此保持当前版本',
      }
    }
    return {
      current,
      recommended: tags.latest,
      preview: tags.next,
      action: 'current',
      message: tags.latest === current ? '当前已是 npm 推荐版本' : '推荐通道没有可证明的向前升级',
    }
  } catch {
    return { current, recommended: null, preview: null, action: 'unknown', message: '无法读取 DSH npm 推荐通道' }
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
  options.onProgress?.('正在读取 DSH 与 profiles')
  const env = options.env ?? process.env
  const dshHome = dshHomeFromEnvironment(env)
  const allProfiles = discoverProfiles(dshHome)
  const inventories = options.profile === undefined
    ? allProfiles
    : allProfiles.filter(profile => profile.name === options.profile)
  if (inventories.length === 0) {
    throw new Error(options.profile === undefined ? `没有在 ${dshHome} 发现 DSH profile` : `找不到 profile: ${options.profile}`)
  }

  const adapters: Adapters = {
    dsh: new DshAdapter(env),
    pnpm: new PnpmAdapter(env),
    git: new GitAdapter(env),
  }
  const currentDsh = await adapters.dsh.version()
  options.onProgress?.('正在读取 DSH 宿主依赖')
  const hostVersions = adapters.dsh.installation()?.versions ?? new Map<string, string>()
  const dshVersionForEvaluation = currentDsh ?? '0.0.0-unknown'
  const [core, profiles] = await Promise.all([
    assessCore(currentDsh, options, adapters.pnpm),
    mapLimit(inventories, 2, inventory => assessProfile(inventory, dshVersionForEvaluation, options, adapters, hostVersions)),
  ])

  options.onProgress?.('正在整理检查结论')
  return {
    schemaVersion: 1,
    mode: options.command === 'upgrade' ? 'read-only-upgrade' : 'status',
    generatedAt: new Date().toISOString(),
    dshHome,
    core,
    profiles,
    summary: summarize(profiles),
    notices: [],
  }
}
