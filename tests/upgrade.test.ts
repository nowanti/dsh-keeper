import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { RuntimeController, RuntimeSpec } from '../src/adapters/runtime.js'
import type { AssessmentReceipt } from '../src/core/types.js'
import { diagnostic } from '../src/core/diagnostics.js'
import { applyUpgrade, discardStage, stageUpgrade, type UpgradePlan } from '../src/upgrade.js'

function temporaryDirectory(): string {
  const path = join(tmpdir(), `dsh-keeper-test-${process.pid}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(path, { recursive: true })
  return path
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writeInstalled(profilePath: string, name: string, version: string): void {
  const packagePath = join(profilePath, 'node_modules', ...name.split('@').filter(Boolean).flatMap(part => part.includes('/') ? part.split('/') : [part]))
  mkdirSync(packagePath, { recursive: true })
  writeJson(join(packagePath, 'package.json'), { name, version })
}

function fixtureReceipt(root: string): AssessmentReceipt {
  const profilePath = join(root, 'profiles', 'web')
  mkdirSync(profilePath, { recursive: true })
  writeJson(join(profilePath, 'package.json'), {
    name: 'fixture-web',
    dependencies: { 'example-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['example-plugin'] } },
  })
  writeFileSync(join(profilePath, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(profilePath, 'pnpm-workspace.yaml'), 'packages:\n  - .\nautoInstallPeers: false\n')
  writeFileSync(join(profilePath, 'cordis.yml'), 'plugins: {}\n')
  writeFileSync(join(profilePath, '.credentials.yaml'), 'secret: must-not-copy\n')
  writeInstalled(profilePath, 'example-plugin', '1.0.0')
  return {
    schemaVersion: 2,
    mode: 'read-only-upgrade',
    generatedAt: new Date().toISOString(),
    dshHome: root,
    core: { current: '0.1.0', recommended: '0.1.0', preview: null, action: 'current', reason: diagnostic('reason.dshCurrent') },
    profiles: [{
      name: 'web',
      path: profilePath,
      config: 'passed',
      dependencyCount: 1,
      bundleCount: 1,
      warnings: [],
      dependencies: [{
        name: 'example-plugin', requested: '1.0.0', installedVersion: '1.0.0', source: 'npm', activeBundle: true,
        patch: null, latestVersion: '2.0.0', recommended: {
          version: '2.0.0', integrity: 'sha512-fixture', evaluation: {
            state: 'declared', dshRange: null, nodeRange: null, hostContract: null, blockers: [], warnings: [], installScripts: [],
          },
        },
        latestEvaluation: null, git: null, checkedCandidates: 1, status: 'upgrade', messages: [],
      }],
    }],
    summary: { profiles: 1, dependencies: 1, recommendedUpdates: 1, heldUpdates: 0, unknown: 0, blocked: 0 },
  }
}

class FakeRuntime implements RuntimeController {
  readonly events: string[] = []
  constructor(readonly running: RuntimeSpec[] = []) {}
  async inspect(profile: string): Promise<RuntimeSpec[]> {
    return this.running.filter(item => item.profile === profile)
  }
  async stop(runtime: RuntimeSpec): Promise<void> {
    this.events.push(`stop:${runtime.profile}`)
  }
  async start(runtime: RuntimeSpec): Promise<RuntimeSpec> {
    this.events.push(`start:${runtime.profile}`)
    return { ...runtime, pid: runtime.pid + 1 }
  }
}

async function stagedFixture(root: string, id: string): Promise<UpgradePlan> {
  const receipt = fixtureReceipt(root)
  const plan = await stageUpgrade(receipt, {
    transactionId: id,
    installProfile: async path => {
      writeInstalled(path, 'example-plugin', '2.0.0')
      writeFileSync(join(path, 'pnpm-lock.yaml'), 'lockfileVersion: 9\npackages:\n  example-plugin@2.0.0:\n    resolution: {integrity: sha512-fixture}\n')
    },
    checkProfile: async () => true,
  })
  assert.notEqual(plan, null)
  return plan as UpgradePlan
}

test('staging copies no credentials and pins the exact candidate', async () => {
  const root = temporaryDirectory()
  try {
    const plan = await stagedFixture(root, 'stage-only')
    const staged = plan.profiles[0]?.stagedPath
    assert.ok(staged)
    assert.equal(existsSync(join(staged, '.credentials.yaml')), false)
    const manifest = JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    assert.equal(manifest.dependencies['example-plugin'], '2.0.0')
    discardStage(plan)
    assert.equal(existsSync(plan.stagingRoot), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('staging preserves an unreachable immutable Git dependency without changing its source', async () => {
  const root = temporaryDirectory()
  try {
    const receipt = fixtureReceipt(root)
    const profile = receipt.profiles[0]
    assert.ok(profile)
    const profilePath = profile.path
    const requested = 'github:owner/missing-git#0123456789abcdef0123456789abcdef01234567'
    const manifest = JSON.parse(readFileSync(join(profilePath, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies['missing-git'] = requested
    writeJson(join(profilePath, 'package.json'), manifest)
    writeInstalled(profilePath, 'missing-git', '0.1.0')
    profile.dependencies.push({
      name: 'missing-git', requested, installedVersion: '0.1.0', source: 'github', activeBundle: true,
      patch: null, latestVersion: null, recommended: null, latestEvaluation: null,
      git: { repository: 'owner/missing-git', currentCommit: '0123456789abcdef0123456789abcdef01234567', headCommit: null, exact: true, updateAvailable: false, error: diagnostic('reason.gitRemoteUnavailable') },
      checkedCandidates: 0, status: 'unknown', messages: [diagnostic('reason.gitRemoteUnavailable')],
    })
    profile.dependencyCount = 2
    receipt.summary.dependencies = 2
    receipt.summary.unknown = 1
    const stagingSpecifier = 'https://codeload.github.com/owner/missing-git/tar.gz/0123456789abcdef0123456789abcdef01234567'
    writeFileSync(join(profilePath, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\npackages:\n  missing-git@${stagingSpecifier}:\n    resolution: {tarball: ${stagingSpecifier}}\n`)
    const plan = await stageUpgrade(receipt, {
      transactionId: 'preserve-git',
      installProfile: async path => {
        const staged = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
        assert.equal(staged.dependencies['missing-git'], stagingSpecifier)
        writeInstalled(path, 'example-plugin', '2.0.0')
        writeFileSync(join(path, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      missing-git:\n        specifier: ${stagingSpecifier}\npackages:\n  example-plugin@2.0.0:\n    resolution: {integrity: sha512-fixture}\n`)
      },
      checkProfile: async () => true,
    })
    assert.ok(plan)
    const stagedPath = plan.profiles[0]?.stagedPath
    assert.ok(stagedPath)
    const finalManifest = JSON.parse(readFileSync(join(stagedPath, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    const finalLock = readFileSync(join(stagedPath, 'pnpm-lock.yaml'), 'utf8')
    assert.equal(finalManifest.dependencies['missing-git'], requested)
    assert.match(finalLock, new RegExp(`specifier: ${requested}`))
    assert.doesNotMatch(finalLock, /specifier: https:\/\/codeload/)
    discardStage(plan)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('apply atomically switches the profile and preserves a rollback snapshot', async () => {
  const root = temporaryDirectory()
  try {
    const plan = await stagedFixture(root, 'apply-success')
    const runtime = new FakeRuntime([{ profile: 'web', pid: 10, port: 3080, cwd: root }])
    const result = await applyUpgrade(plan, {
      runtime,
      checkProfile: async (_home, profile) => {
        const manifest = JSON.parse(readFileSync(join(root, 'profiles', profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
        return manifest.dependencies['example-plugin'] === '2.0.0'
      },
    })
    assert.deepEqual(runtime.events, ['stop:web', 'start:web'])
    assert.equal(result.restarted[0]?.port, 3080)
    const live = JSON.parse(readFileSync(join(root, 'profiles', 'web', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    const backup = JSON.parse(readFileSync(join(result.transactionPath, 'profiles', 'web', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    assert.equal(live.dependencies['example-plugin'], '2.0.0')
    assert.equal(backup.dependencies['example-plugin'], '1.0.0')
    assert.equal(existsSync(plan.stagingRoot), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed live validation restores files, node_modules and service', async () => {
  const root = temporaryDirectory()
  try {
    const plan = await stagedFixture(root, 'apply-rollback')
    const runtime = new FakeRuntime([{ profile: 'web', pid: 10, port: 3080, cwd: root }])
    await assert.rejects(
      applyUpgrade(plan, { runtime, checkProfile: async () => false, locale: 'zh-CN' }),
      /已自动恢复原版本/,
    )
    assert.deepEqual(runtime.events, ['stop:web', 'start:web'])
    const live = JSON.parse(readFileSync(join(root, 'profiles', 'web', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    const installed = JSON.parse(readFileSync(join(root, 'profiles', 'web', 'node_modules', 'example-plugin', 'package.json'), 'utf8')) as { version: string }
    assert.equal(live.dependencies['example-plugin'], '1.0.0')
    assert.equal(installed.version, '1.0.0')
    const journal = JSON.parse(readFileSync(join(root, 'dsh-keeper', 'transactions', 'apply-rollback', 'transaction.json'), 'utf8')) as { state: string }
    assert.equal(journal.state, 'rolled-back')
    assert.equal(existsSync(plan.stagingRoot), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
