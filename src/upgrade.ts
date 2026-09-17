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
import { translate, type Locale } from './i18n.js'

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
  locale?: Locale
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
  locale?: Locale
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

function safeCopyTree(source: string, target: string, locale: Locale): void {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error(translate(locale, 'error.symlinkInput', { name: basename(source) }))
  if (stat.isFile()) {
    copyFileSync(source, target)
    return
  }
  if (!stat.isDirectory()) throw new Error(translate(locale, 'error.unsupportedInput', { name: basename(source) }))
  ensurePrivateDirectory(target)
  for (const entry of readdirSync(source)) safeCopyTree(join(source, entry), join(target, entry), locale)
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

function collectChanges(receipt: AssessmentReceipt, locale: Locale): UpgradeChange[] {
  return receipt.profiles.flatMap(profile => profile.dependencies.flatMap(dependency => {
    if (dependency.status !== 'upgrade' || dependency.recommended === null || dependency.installedVersion === null) return []
    if (dependency.recommended.integrity === null) throw new Error(translate(locale, 'error.candidateIntegrityMissing', { package: dependency.name, version: dependency.recommended.version }))
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
  locale: Locale,
): Promise<void> {
  ensurePrivateDirectory(stagedPath)
  for (const name of PROFILE_COPY_FILES) {
    const source = join(profilePath, name)
    if (existsSync(source)) safeCopyTree(source, join(stagedPath, name), locale)
  }
  const patches = join(profilePath, 'patches')
  if (existsSync(patches)) safeCopyTree(patches, join(stagedPath, 'patches'), locale)
  const liveModules = join(profilePath, 'node_modules')
  if (!existsSync(liveModules)) throw new Error(translate(locale, 'error.profileModulesMissing', { path: profilePath }))
  await cloneDependencyTree(liveModules, join(stagedPath, 'node_modules'))
  const manifestPath = join(stagedPath, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(translate(locale, 'error.profileManifestMissing', { path: profilePath }))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
  if (manifest.dependencies === undefined) throw new Error(translate(locale, 'error.profileDependenciesMissing', { path: profilePath }))
  for (const change of changes) {
    if (manifest.dependencies[change.package] === undefined) throw new Error(translate(locale, 'error.profilePackageMissing', { package: change.package }))
    manifest.dependencies[change.package] = change.to
  }
  for (const dependency of preservedGit) {
    if (manifest.dependencies[dependency.name] !== dependency.requested) {
      throw new Error(translate(locale, 'error.gitDeclarationChanged', { package: dependency.name }))
    }
    manifest.dependencies[dependency.name] = dependency.stagingSpecifier
  }
  writeJsonAtomic(manifestPath, manifest)
}

function restorePreservedGit(stagedPath: string, dependencies: readonly PreservedGitDependency[], locale: Locale): void {
  if (dependencies.length === 0) return
  const manifestPath = join(stagedPath, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
  if (manifest.dependencies === undefined) throw new Error(translate(locale, 'error.stagedDependenciesMissing'))
  let lock = readFileSync(join(stagedPath, 'pnpm-lock.yaml'), 'utf8')
  for (const dependency of dependencies) {
    if (manifest.dependencies[dependency.name] !== dependency.stagingSpecifier) {
      throw new Error(translate(locale, 'error.stagedSourceChanged', { package: dependency.name }))
    }
    manifest.dependencies[dependency.name] = dependency.requested
    const plain = `specifier: ${dependency.stagingSpecifier}`
    const quoted = `specifier: '${dependency.stagingSpecifier}'`
    if (lock.includes(plain)) lock = lock.replace(plain, `specifier: ${dependency.requested}`)
    else if (lock.includes(quoted)) lock = lock.replace(quoted, `specifier: ${dependency.requested}`)
    else throw new Error(translate(locale, 'error.lockRestoreFailed', { package: dependency.name }))
  }
  writeJsonAtomic(manifestPath, manifest)
  writeFileSync(join(stagedPath, 'pnpm-lock.yaml'), lock, { mode: 0o600 })
}

function verifyCandidateIntegrity(stagedPath: string, changes: readonly UpgradeChange[], locale: Locale): void {
  const lock = readFileSync(join(stagedPath, 'pnpm-lock.yaml'), 'utf8')
  for (const change of changes) {
    if (!lock.includes(`integrity: ${change.integrity}`)) {
      throw new Error(translate(locale, 'error.integrityMismatch', { package: change.package, version: change.to }))
    }
  }
}

export async function stageUpgrade(receipt: AssessmentReceipt, options: StageOptions = {}): Promise<UpgradePlan | null> {
  const locale = options.locale ?? 'en'
  const changes = collectChanges(receipt, locale)
  if (changes.length === 0) return null
  const id = options.transactionId ?? randomUUID()
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error(translate(locale, 'error.invalidTransactionId'))
  const stagingBase = join(receipt.dshHome, 'dsh-keeper', 'staging')
  const stagingRoot = join(stagingBase, id)
  if (!pathInside(stagingBase, stagingRoot)) throw new Error(translate(locale, 'error.invalidStagingDirectory'))
  if (existsSync(stagingRoot)) throw new Error(translate(locale, 'error.stagingExists', { id }))
  ensurePrivateDirectory(join(stagingRoot, 'profiles'))
  const env = { ...(options.env ?? process.env), DSH_HOME: stagingRoot }
  const pnpm = new PnpmAdapter(env, locale)
  const dsh = new DshAdapter(env)
  const installProfile = options.installProfile ?? (path => pnpm.install(path))
  const checkProfile = options.checkProfile ?? (async (_home, profile) => (await dsh.checkConfig(profile)).ok)

  try {
    if (options.installProfile === undefined) {
      options.onProgress?.(translate(locale, 'progress.cachePackages', { count: new Set(changes.map(change => `${change.package}@${change.to}`)).size }))
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
          throw new Error(translate(locale, 'error.gitRemoteNoCache', { package: dependency.name }))
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
      options.onProgress?.(translate(locale, 'progress.copyProfile', { profile: profile.name }))
      await prepareStagedProfile(profile.path, stagedPath, profileChanges, preservedGit, locale)
      options.onProgress?.(translate(locale, 'progress.installProfile', { profile: profile.name, count: profileChanges.length }))
      await installProfile(stagedPath)
      restorePreservedGit(stagedPath, preservedGit, locale)
      verifyCandidateIntegrity(stagedPath, profileChanges, locale)
      for (const change of profileChanges) {
        const installed = readInstalledManifest(stagedPath, change.package)?.version
        if (installed !== change.to) throw new Error(translate(locale, 'error.resolutionMismatch', { profile: profile.name, package: change.package, version: change.to }))
      }
      for (const dependency of preservedGit) {
        const installed = readInstalledManifest(stagedPath, dependency.name)?.version
        if (installed !== dependency.installedVersion) {
          throw new Error(translate(locale, 'error.preservedGitMismatch', { profile: profile.name, package: dependency.name, version: dependency.installedVersion }))
        }
      }
      options.onProgress?.(translate(locale, 'progress.validateProfile', { profile: profile.name }))
      if (!await checkProfile(stagingRoot, profile.name)) throw new Error(translate(locale, 'error.isolationConfigFailed', { profile: profile.name }))
      profiles.push({ name: profile.name, livePath: profile.path, stagedPath, changes: profileChanges })
    }
    return { transactionId: id, dshHome: receipt.dshHome, stagingRoot, profiles, changes }
  } catch (error) {
    discardStage({ dshHome: receipt.dshHome, stagingRoot }, locale)
    throw error
  }
}

export function discardStage(plan: Pick<UpgradePlan, 'dshHome' | 'stagingRoot'>, locale: Locale = 'en'): void {
  const stagingBase = join(plan.dshHome, 'dsh-keeper', 'staging')
  if (!pathInside(stagingBase, plan.stagingRoot)) throw new Error(translate(locale, 'error.refuseCleanup'))
  rmSync(plan.stagingRoot, { recursive: true, force: true })
}

function saveJournal(path: string, journal: TransactionJournal): void {
  journal.updatedAt = new Date().toISOString()
  writeJsonAtomic(path, journal)
}

function replaceFromStage(source: string, target: string, id: string): void {
  const temporary = join(dirname(target), `.dsh-keeper-${id}-${basename(target)}`)
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
  const locale = options.locale ?? 'en'
  const runtime = options.runtime ?? new DshRuntimeController(options.env, {
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    locale,
  })
  const dshCheck = options.checkProfile ?? (async (home, profile) => {
    const dsh = new DshAdapter({ ...(options.env ?? process.env), DSH_HOME: home })
    return (await dsh.checkConfig(profile)).ok
  })
  const runtimeSpecs: RuntimeSpec[] = []
  for (const profile of plan.profiles) {
    const matches = await runtime.inspect(profile.name)
    if (matches.length > 1) throw new Error(translate(locale, 'error.multipleRuntimes', { profile: profile.name }))
    if (matches[0]?.port === null) throw new Error(translate(locale, 'error.interactiveRunning', { profile: profile.name }))
    if (matches[0] !== undefined) runtimeSpecs.push(matches[0])
  }

  const transactionsRoot = join(plan.dshHome, 'dsh-keeper', 'transactions')
  const transactionPath = join(transactionsRoot, plan.transactionId)
  if (!pathInside(transactionsRoot, transactionPath)) throw new Error(translate(locale, 'error.invalidTransactionDirectory'))
  if (existsSync(transactionPath)) throw new Error(translate(locale, 'error.transactionExists', { id: plan.transactionId }))
  ensurePrivateDirectory(transactionPath)
  const profiles: ProfileJournal[] = plan.profiles.map(profile => {
    const backupPath = join(transactionPath, 'profiles', profile.name)
    ensurePrivateDirectory(backupPath)
    const files = PROMOTED_FILES.map(name => ({ name, existed: existsSync(join(profile.livePath, name)) }))
    for (const file of files) if (file.existed) copyFileSync(join(profile.livePath, file.name), join(backupPath, file.name))
    if (!existsSync(join(profile.livePath, 'node_modules'))) throw new Error(translate(locale, 'error.liveModulesMissing', { profile: profile.name }))
    if (!existsSync(join(profile.stagedPath, 'node_modules'))) throw new Error(translate(locale, 'error.stagedModulesMissing', { profile: profile.name }))
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
      options.onProgress?.(translate(locale, 'progress.stopProfile', { profile: service.profile }))
      await runtime.stop(service)
      stopped.push(service)
    }

    journal.state = 'promoting'
    saveJournal(journalPath, journal)
    for (const profile of profiles) {
      options.onProgress?.(translate(locale, 'progress.switchProfile', { profile: profile.name }))
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
      options.onProgress?.(translate(locale, 'progress.revalidateProfile', { profile: profile.name }))
      if (!await dshCheck(plan.dshHome, profile.name)) throw new Error(translate(locale, 'error.liveConfigFailed', { profile: profile.name }))
    }

    journal.state = 'restarting'
    saveJournal(journalPath, journal)
    for (const service of runtimeSpecs) {
      options.onProgress?.(translate(locale, 'progress.restartProfile', { profile: service.profile }))
      restarted.push(await runtime.start(service, plan.dshHome))
    }
    journal.state = 'committed'
    saveJournal(journalPath, journal)
    discardStage(plan, locale)
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
        discardStage(plan, locale)
      } catch {
        // The live generation is already restored. A cleanup failure must not
        // misreport the rollback itself as failed; the journal retains paths.
      }
    } catch (rollbackError) {
      journal.state = 'rollback-failed'
      journal.error = `${message}; rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      saveJournal(journalPath, journal)
      throw new Error(translate(locale, 'error.rollbackFailed', { message: journal.error, path: transactionPath }))
    }
    throw new Error(translate(locale, 'error.upgradeRecovered', { message }))
  }
}
