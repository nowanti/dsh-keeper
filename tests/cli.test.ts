import assert from 'node:assert/strict'
import test from 'node:test'

import { main, parseArgs, type CliDependencies } from '../src/cli.js'
import type { AssessmentReceipt } from '../src/core/types.js'
import type { UpgradePlan } from '../src/upgrade.js'

function candidateReceipt(): AssessmentReceipt {
  return {
    schemaVersion: 1,
    mode: 'read-only-upgrade',
    generatedAt: '2026-08-29T00:00:00.000Z',
    dshHome: '/tmp/.dsh',
    core: {
      current: '0.1.1-rc.2',
      recommended: '0.1.1-rc.2',
      preview: null,
      action: 'current',
      message: '当前已是推荐版本',
    },
    profiles: [{
      name: 'web',
      path: '/tmp/.dsh/profiles/web',
      config: 'passed',
      dependencyCount: 1,
      bundleCount: 1,
      dependencies: [{
        name: 'upgrade-me',
        requested: '1.0.0',
        installedVersion: '1.0.0',
        source: 'npm',
        activeBundle: true,
        patch: null,
        latestVersion: '2.0.0',
        recommended: {
          version: '2.0.0',
          integrity: 'sha512-test',
          evaluation: {
            state: 'declared',
            dshRange: '>=0.1.1-rc.1',
            nodeRange: null,
            hostContract: 'dsh-engine',
            blockers: [],
            warnings: [],
            installScripts: [],
          },
        },
        latestEvaluation: null,
        git: null,
        checkedCandidates: 1,
        status: 'upgrade',
        messages: [],
      }],
      warnings: [],
    }],
    summary: {
      profiles: 1,
      dependencies: 1,
      recommendedUpdates: 1,
      heldUpdates: 0,
      unknown: 0,
      blocked: 0,
    },
    notices: [],
  }
}

function stagedPlan(): UpgradePlan {
  return {
    transactionId: 'test-upgrade',
    dshHome: '/tmp/.dsh',
    stagingRoot: '/tmp/.dsh/dshctl/staging/test-upgrade',
    profiles: [{
      name: 'web',
      livePath: '/tmp/.dsh/profiles/web',
      stagedPath: '/tmp/.dsh/dshctl/staging/test-upgrade/profiles/web',
      changes: [{ profile: 'web', package: 'upgrade-me', from: '1.0.0', to: '2.0.0', integrity: 'sha512-test' }],
    }],
    changes: [{ profile: 'web', package: 'upgrade-me', from: '1.0.0', to: '2.0.0', integrity: 'sha512-test' }],
  }
}

function flowDependencies(events: string[], logs: string[]): CliDependencies {
  let clock = 0
  return {
    assess: async () => {
      events.push('assess')
      return candidateReceipt()
    },
    stage: async () => {
      events.push('stage')
      return stagedPlan()
    },
    apply: async () => {
      events.push('apply')
      return { transactionId: 'test-upgrade', transactionPath: '/tmp/transaction', restarted: [] }
    },
    discard: () => events.push('discard'),
    interactive: true,
    log: message => logs.push(message),
    error: message => logs.push(`error:${message}`),
    progressOutput: { isTTY: false, write: () => undefined },
    now: () => {
      const value = clock
      clock += 1_000
      return value
    },
  }
}

test('-y and --yes both skip upgrade confirmation', () => {
  const short = parseArgs(['upgrade', '-y'])
  const long = parseArgs(['upgrade', '--yes'])
  assert.notEqual(typeof short, 'string')
  assert.notEqual(typeof long, 'string')
  if (typeof short !== 'string' && typeof long !== 'string') {
    assert.equal(short.yes, true)
    assert.equal(long.yes, true)
  }
})

test('--dry-run conflicts with -y', () => {
  assert.throws(() => parseArgs(['upgrade', '--dry-run', '-y']), /不能与/)
})

test('interactive cancellation happens before isolation staging', async () => {
  const events: string[] = []
  const logs: string[] = []
  const dependencies = flowDependencies(events, logs)
  dependencies.confirm = async () => {
    events.push('confirm')
    return false
  }

  assert.equal(await main(['upgrade'], dependencies), 0)
  assert.deepEqual(events, ['assess', 'confirm'])
  assert.match(logs[0] ?? '', /发现 1 项待验证插件更新/)
  assert.match(logs.at(-1) ?? '', /未下载候选包或执行隔离安装/)
  assert.doesNotMatch(logs.at(-1) ?? '', /用时：/)
})

test('confirmed upgrade validates in isolation before applying', async () => {
  const events: string[] = []
  const logs: string[] = []
  const dependencies = flowDependencies(events, logs)
  dependencies.confirm = async () => {
    events.push('confirm')
    return true
  }

  assert.equal(await main(['upgrade'], dependencies), 0)
  assert.deepEqual(events, ['assess', 'confirm', 'stage', 'apply'])
  assert.match(logs.at(-1) ?? '', /升级完成/)
  assert.doesNotMatch(logs.at(-1) ?? '', /用时：/)
})

test('-y skips only confirmation and retains isolation staging', async () => {
  const events: string[] = []
  const logs: string[] = []
  const dependencies = flowDependencies(events, logs)
  dependencies.confirm = async () => {
    events.push('confirm')
    return true
  }
  dependencies.interactive = false

  assert.equal(await main(['upgrade', '-y'], dependencies), 0)
  assert.deepEqual(events, ['assess', 'stage', 'apply'])
})

test('--dry-run validates and discards staging without confirmation or apply', async () => {
  const events: string[] = []
  const logs: string[] = []
  const dependencies = flowDependencies(events, logs)
  dependencies.confirm = async () => {
    events.push('confirm')
    return true
  }

  assert.equal(await main(['upgrade', '--dry-run'], dependencies), 0)
  assert.deepEqual(events, ['assess', 'stage', 'discard'])
  assert.match(logs.at(-1) ?? '', /隔离验证通过/)
  assert.doesNotMatch(logs.at(-1) ?? '', /用时：/)
})

test('--verbose shows phase timings for diagnostics', async () => {
  const events: string[] = []
  const logs: string[] = []
  const dependencies = flowDependencies(events, logs)
  dependencies.confirm = async () => true

  assert.equal(await main(['upgrade', '--verbose'], dependencies), 0)
  assert.match(logs.at(-1) ?? '', /候选发现 1\.0s，隔离验证 1\.0s，应用与恢复 1\.0s/)
})

test('--json reports phase timings in milliseconds without applying', async () => {
  const events: string[] = []
  const logs: string[] = []
  const dependencies = flowDependencies(events, logs)

  assert.equal(await main(['upgrade', '--json'], dependencies), 0)
  assert.deepEqual(events, ['assess', 'stage', 'discard'])
  const output = JSON.parse(logs.at(-1) ?? '{}') as { timings?: Record<string, number> }
  assert.deepEqual(output.timings, { discoveryMs: 1_000, isolationMs: 1_000 })
})
