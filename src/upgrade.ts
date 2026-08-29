import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { cp } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { DshAdapter } from './adapters/dsh.js'
import { parseGitHubReference } from './adapters/git.js'
import { PnpmAdapter } from './adapters/pnpm.js'
import { DshRuntimeController, type RuntimeController, type RuntimeSpec } from './adapters/runtime.js'
import { runCommand } from './adapters/process.js'
import { readInstalledManifest } from './adapters/profiles.js'
import type { AssessmentReceipt } from './core/types.js'

const PROFILE_COPY_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml'] as const
const PROMOTED_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'] as const

export interface UpgradeChange {
  profile: string
  package: string
  from: string
  to: string
  integrity: string
}

export interface StagedProfile {
  name: string
  livePath: string
  stagedPath: string
  changes: UpgradeChange[]
}

export interface UpgradePlan {
  transactionId: string
  dshHome: string
  stagingRoot: string
  profiles: StagedProfile[]
  changes: UpgradeChange[]
}

export interface StageOptions {
  env?: NodeJS.ProcessEnv
  onProgress?: (message: string) => void
  installProfile?: (profilePath: string) => Promise<void>
  checkProfile?: (stagingHome: string, profile: string) => Promise<boolean>
  transactionId?: string
}

export interface ApplyResult {
  transactionId: string
  transactionPath: string
  restarted: Array<{ profile: string; port: number }>
}

export interface ApplyOptions {
  env?: NodeJS.ProcessEnv
  onProgress?: (message: string) => void
  runtime?: RuntimeController
  checkProfile?: (dshHome: string, profile: string) => Promise<boolean>
}

interface ProfileJournal {
  name: string
  livePath: string
  stagedPath: string
  backupPath: string
  files: Array<{ name: string; existed: boolean }>
}

interface TransactionJournal {
  schemaVersion: 1
  id: string
  state: 'prepared' | 'stopping' | 'promoting' | 'validating' | 'restarting' | 'committed' | 'rolling-back' | 'rolled-back' | 'rollback-failed'
  createdAt: string
  updatedAt: string
  profiles: ProfileJournal[]
  runtimes: RuntimeSpec[]
  error?: string
}

interface PreservedGitDependency {
  name: string
  requested: string
  stagingSpecifier: string
  installedVersion: string
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

function safeCopyTree(source: string, target: string): void {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error(`隔离输入不允许符号链接: ${basename(source)}`)
  if (stat.isFile()) {
    copyFileSync(source, target)
    return
  }
  if (!stat.isDirectory()) throw new Error(`隔离输入类型不受支持: ${basename(source)}`)
  ensurePrivateDirectory(target)
  for (const entry of readdirSync(source)) safeCopyTree(join(source, entry), join(target, entry))
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

function collectChanges(receipt: AssessmentReceipt): UpgradeChange[] {
  return receipt.profiles.flatMap(profile => profile.dependencies.flatMap(dependency => {
    if (dependency.status !== 'upgrade' || dependency.recommended === null || dependency.installedVersion === null) return []
    if (dependency.recommended.integrity === null) throw new Error(`${dependency.name}@${dependency.recommended.version} 缺少 integrity`)
    return [{
      profile: profile.name,
      package: dependency.name,
      from: dependency.installedVersion,
      to: dependency.recommended.version,
      integrity: dependency.recommended.integrity,
    }]
  }))
}

async function cloneDependencyTree(source: string, target: string): Promise<void> {
  if (process.platform === 'darwin') {
    const result = await runCommand('cp', ['-cR', source, target], { timeoutMs: 2 * 60_000, discardOutput: true }).catch(() => null)
    if (result !== null && result.code === 0 && !result.timedOut) return
    rmSync(target, { recursive: true, force: true })
  }
  await cp(source, target, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
  })
}

async function prepareStagedProfile(
  profilePath: string,
  stagedPath: string,
  changes: readonly UpgradeChange[],
  preservedGit: readonly PreservedGitDependency[],
): Promise<void> {
  ensurePrivateDirectory(stagedPath)
  for (const name of PROFILE_COPY_FILES) {
    const source = join(profilePath, name)
    if (existsSync(source)) safeCopyTree(source, join(stagedPath, name))
  }
  const patches = join(profilePath, 'patches')
  if (existsSync(patches)) safeCopyTree(patches, join(stagedPath, 'patches'))
  const liveModules = join(profilePath, 'node_modules')
  if (!existsSync(liveModules)) throw new Error(`profile 缺少 node_modules: ${profilePath}`)
  await cloneDependencyTree(liveModules, join(stagedPath, 'node_modules'))
  const manifestPath = join(stagedPath, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`profile 缺少 package.json: ${profilePath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
  if (manifest.dependencies === undefined) throw new Error(`profile 没有 dependencies: ${profilePath}`)
  for (const change of changes) {
    if (manifest.dependencies[change.package] === undefined) throw new Error(`profile 中找不到 ${change.package}`)
    manifest.dependencies[change.package] = change.to
  }
  for (const dependency of preservedGit) {
    if (manifest.dependencies[dependency.name] !== dependency.requested) {
      throw new Error(`${dependency.name} 的 Git 声明在检查后发生变化`)
    }
    manifest.dependencies[dependency.name] = dependency.stagingSpecifier
  }
  writeJsonAtomic(manifestPath, manifest)
}

function restorePreservedGit(stagedPath: string, dependencies: readonly PreservedGitDependency[]): void {
  if (dependencies.length === 0) return
  const manifestPath = join(stagedPath, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
  if (manifest.dependencies === undefined) throw new Error('隔离 package.json 缺少 dependencies')
  let lock = readFileSync(join(stagedPath, 'pnpm-lock.yaml'), 'utf8')
  for (const dependency of dependencies) {
    if (manifest.dependencies[dependency.name] !== dependency.stagingSpecifier) {
      throw new Error(`${dependency.name} 的 staging 来源发生变化`)
    }
    manifest.dependencies[dependency.name] = dependency.requested
    const plain = `specifier: ${dependency.stagingSpecifier}`
    const quoted = `specifier: '${dependency.stagingSpecifier}'`
    if (lock.includes(plain)) lock = lock.replace(plain, `specifier: ${dependency.requested}`)
    else if (lock.includes(quoted)) lock = lock.replace(quoted, `specifier: ${dependency.requested}`)
    else throw new Error(`${dependency.name} 的 lockfile staging 声明无法恢复`)
  }
  writeJsonAtomic(manifestPath, manifest)
  writeFileSync(join(stagedPath, 'pnpm-lock.yaml'), lock, { mode: 0o600 })
}

function verifyCandidateIntegrity(stagedPath: string, changes: readonly UpgradeChange[]): void {
  const lock = readFileSync(join(stagedPath, 'pnpm-lock.yaml'), 'utf8')
  for (const change of changes) {
    if (!lock.includes(`integrity: ${change.integrity}`)) {
      throw new Error(`${change.package}@${change.to} 的 lockfile integrity 与候选证据不一致`)
    }
  }
}

export async function stageUpgrade(receipt: AssessmentReceipt, options: StageOptions = {}): Promise<UpgradePlan | null> {
  const changes = collectChanges(receipt)
  if (changes.length === 0) return null
  const id = options.transactionId ?? randomUUID()
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error('无效事务编号')
  const stagingBase = join(receipt.dshHome, 'dshctl', 'staging')
  const stagingRoot = join(stagingBase, id)
  if (!pathInside(stagingBase, stagingRoot)) throw new Error('无效隔离目录')
  if (existsSync(stagingRoot)) throw new Error(`隔离事务已存在: ${id}`)
  ensurePrivateDirectory(join(stagingRoot, 'profiles'))
  const env = { ...(options.env ?? process.env), DSH_HOME: stagingRoot }
  const pnpm = new PnpmAdapter(env)
  const dsh = new DshAdapter(env)
  const installProfile = options.installProfile ?? (path => pnpm.install(path, { offline: true }))
  const checkProfile = options.checkProfile ?? (async (_home, profile) => (await dsh.checkConfig(profile)).ok)

  try {
    if (options.installProfile === undefined) {
      options.onProgress?.(`正在缓存 ${new Set(changes.map(change => `${change.package}@${change.to}`)).size} 个推荐包及其依赖`)
      await pnpm.addToStore(changes.map(change => ({ name: change.package, version: change.to })))
    }
    const profiles: StagedProfile[] = []
    for (const profile of receipt.profiles) {
      const profileChanges = changes.filter(change => change.profile === profile.name)
      if (profileChanges.length === 0) continue
      const liveLock = readFileSync(join(profile.path, 'pnpm-lock.yaml'), 'utf8')
      const preservedGit = profile.dependencies.flatMap(dependency => {
        if (dependency.source !== 'github' || dependency.installedVersion === null) return []
        const reference = parseGitHubReference(dependency.requested)
        if (reference === null || !reference.exact || reference.ref === null) return []
        const stagingSpecifier = `https://codeload.github.com/${reference.owner}/${reference.repository}/tar.gz/${reference.ref}`
        const cachedResolution = liveLock.includes(stagingSpecifier)
        if (!cachedResolution && dependency.git?.error !== null && dependency.git?.error !== undefined) {
          throw new Error(`${dependency.name} 远端不可达且没有可复用的同一 commit 缓存`)
        }
        if (!cachedResolution) return []
        return [{
          name: dependency.name,
          requested: dependency.requested,
          stagingSpecifier,
          installedVersion: dependency.installedVersion,
        }]
      })
      const stagedPath = join(stagingRoot, 'profiles', profile.name)
      options.onProgress?.(`正在复制 ${profile.name} 的当前依赖树到隔离区`)
      await prepareStagedProfile(profile.path, stagedPath, profileChanges, preservedGit)
      options.onProgress?.(`正在隔离安装 ${profile.name} 的 ${profileChanges.length} 项更新`)
      await installProfile(stagedPath)
      restorePreservedGit(stagedPath, preservedGit)
      verifyCandidateIntegrity(stagedPath, profileChanges)
      for (const change of profileChanges) {
        const installed = readInstalledManifest(stagedPath, change.package)?.version
        if (installed !== change.to) throw new Error(`${profile.name} 未解析到预期的 ${change.package}@${change.to}`)
      }
      for (const dependency of preservedGit) {
        const installed = readInstalledManifest(stagedPath, dependency.name)?.version
        if (installed !== dependency.installedVersion) {
          throw new Error(`${profile.name} 未保留 ${dependency.name}@${dependency.installedVersion}`)
        }
      }
      options.onProgress?.(`正在验证 ${profile.name} 的配置合成`)
      if (!await checkProfile(stagingRoot, profile.name)) throw new Error(`${profile.name} 隔离配置验证失败`)
      profiles.push({ name: profile.name, livePath: profile.path, stagedPath, changes: profileChanges })
    }
    return { transactionId: id, dshHome: receipt.dshHome, stagingRoot, profiles, changes }
  } catch (error) {
    discardStage({ dshHome: receipt.dshHome, stagingRoot })
    throw error
  }
}

export function discardStage(plan: Pick<UpgradePlan, 'dshHome' | 'stagingRoot'>): void {
  const stagingBase = join(plan.dshHome, 'dshctl', 'staging')
  if (!pathInside(stagingBase, plan.stagingRoot)) throw new Error('拒绝清理非隔离目录')
  rmSync(plan.stagingRoot, { recursive: true, force: true })
}

function saveJournal(path: string, journal: TransactionJournal): void {
  journal.updatedAt = new Date().toISOString()
  writeJsonAtomic(path, journal)
}

function replaceFromStage(source: string, target: string, id: string): void {
  const temporary = join(dirname(target), `.dshctl-${id}-${basename(target)}`)
  copyFileSync(source, temporary)
  renameSync(temporary, target)
}

function restoreProfile(profile: ProfileJournal, transactionId: string): void {
  const backupModules = join(profile.backupPath, 'node_modules')
  const liveModules = join(profile.livePath, 'node_modules')
  if (existsSync(backupModules)) {
    if (existsSync(liveModules)) {
      const failedModules = join(profile.backupPath, `failed-node_modules-${transactionId}`)
      if (existsSync(failedModules)) rmSync(failedModules, { recursive: true, force: true })
      renameSync(liveModules, failedModules)
    }
    renameSync(backupModules, liveModules)
  }
  for (const file of profile.files) {
    const live = join(profile.livePath, file.name)
    const backup = join(profile.backupPath, file.name)
    if (file.existed && existsSync(backup)) replaceFromStage(backup, live, transactionId)
    else if (!file.existed && existsSync(live)) rmSync(live)
  }
}

export async function applyUpgrade(plan: UpgradePlan, options: ApplyOptions = {}): Promise<ApplyResult> {
  const runtime = options.runtime ?? new DshRuntimeController(options.env, {
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  })
  const dshCheck = options.checkProfile ?? (async (home, profile) => {
    const dsh = new DshAdapter({ ...(options.env ?? process.env), DSH_HOME: home })
    return (await dsh.checkConfig(profile)).ok
  })
  const runtimeSpecs: RuntimeSpec[] = []
  for (const profile of plan.profiles) {
    const matches = await runtime.inspect(profile.name)
    if (matches.length > 1) throw new Error(`${profile.name} 有多个运行实例，无法安全自动重启`)
    if (matches[0]?.port === null) throw new Error(`${profile.name} 正在交互终端中运行；请先退出后再升级`)
    if (matches[0] !== undefined) runtimeSpecs.push(matches[0])
  }

  const transactionsRoot = join(plan.dshHome, 'dshctl', 'transactions')
  const transactionPath = join(transactionsRoot, plan.transactionId)
  if (!pathInside(transactionsRoot, transactionPath)) throw new Error('无效事务目录')
  if (existsSync(transactionPath)) throw new Error(`事务已存在: ${plan.transactionId}`)
  ensurePrivateDirectory(transactionPath)
  const profiles: ProfileJournal[] = plan.profiles.map(profile => {
    const backupPath = join(transactionPath, 'profiles', profile.name)
    ensurePrivateDirectory(backupPath)
    const files = PROMOTED_FILES.map(name => ({ name, existed: existsSync(join(profile.livePath, name)) }))
    for (const file of files) if (file.existed) copyFileSync(join(profile.livePath, file.name), join(backupPath, file.name))
    if (!existsSync(join(profile.livePath, 'node_modules'))) throw new Error(`${profile.name} 缺少当前 node_modules，拒绝切换`)
    if (!existsSync(join(profile.stagedPath, 'node_modules'))) throw new Error(`${profile.name} 隔离 node_modules 不完整`)
    return { name: profile.name, livePath: profile.livePath, stagedPath: profile.stagedPath, backupPath, files }
  })
  const now = new Date().toISOString()
  const journal: TransactionJournal = {
    schemaVersion: 1,
    id: plan.transactionId,
    state: 'prepared',
    createdAt: now,
    updatedAt: now,
    profiles,
    runtimes: runtimeSpecs,
  }
  const journalPath = join(transactionPath, 'transaction.json')
  saveJournal(journalPath, journal)
  const restarted: RuntimeSpec[] = []
  const stopped: RuntimeSpec[] = []
  try {
    journal.state = 'stopping'
    saveJournal(journalPath, journal)
    for (const service of runtimeSpecs) {
      options.onProgress?.(`正在停止 ${service.profile}`)
      await runtime.stop(service)
      stopped.push(service)
    }

    journal.state = 'promoting'
    saveJournal(journalPath, journal)
    for (const profile of profiles) {
      options.onProgress?.(`正在切换 ${profile.name}`)
      renameSync(join(profile.livePath, 'node_modules'), join(profile.backupPath, 'node_modules'))
      renameSync(join(profile.stagedPath, 'node_modules'), join(profile.livePath, 'node_modules'))
      for (const file of profile.files) {
        const staged = join(profile.stagedPath, file.name)
        const live = join(profile.livePath, file.name)
        if (existsSync(staged)) replaceFromStage(staged, live, plan.transactionId)
      }
    }

    journal.state = 'validating'
    saveJournal(journalPath, journal)
    for (const profile of profiles) {
      options.onProgress?.(`正在复核 ${profile.name} 的实际配置`)
      if (!await dshCheck(plan.dshHome, profile.name)) throw new Error(`${profile.name} 切换后的配置验证失败`)
    }

    journal.state = 'restarting'
    saveJournal(journalPath, journal)
    for (const service of runtimeSpecs) {
      options.onProgress?.(`正在启动并检查 ${service.profile}`)
      restarted.push(await runtime.start(service, plan.dshHome))
    }
    journal.state = 'committed'
    saveJournal(journalPath, journal)
    discardStage(plan)
    return {
      transactionId: plan.transactionId,
      transactionPath,
      restarted: restarted.flatMap(item => item.port === null ? [] : [{ profile: item.profile, port: item.port }]),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    journal.state = 'rolling-back'
    journal.error = message
    saveJournal(journalPath, journal)
    try {
      for (const service of restarted.reverse()) await runtime.stop(service).catch(() => undefined)
      for (const profile of [...profiles].reverse()) restoreProfile(profile, plan.transactionId)
      for (const service of stopped) await runtime.start(service, plan.dshHome)
      journal.state = 'rolled-back'
      saveJournal(journalPath, journal)
      try {
        discardStage(plan)
      } catch {
        // The live generation is already restored. A cleanup failure must not
        // misreport the rollback itself as failed; the journal retains paths.
      }
    } catch (rollbackError) {
      journal.state = 'rollback-failed'
      journal.error = `${message}; rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      saveJournal(journalPath, journal)
      throw new Error(`升级失败且自动恢复未完成：${journal.error}；事务 ${transactionPath}`)
    }
    throw new Error(`升级未生效，已自动恢复原版本：${message}`)
  }
}
