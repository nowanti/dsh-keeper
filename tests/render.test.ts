import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderHuman, renderUpgradeCandidates, renderUpgradePlan } from '../src/render.js'
import { diagnostic } from '../src/core/diagnostics.js'
import type { AssessmentReceipt, DependencyAssessment } from '../src/core/types.js'

function dependency(status: DependencyAssessment['status'], name: string): DependencyAssessment {
  return {
    name,
    requested: '1.0.0',
    installedVersion: '1.0.0',
    source: 'npm',
    activeBundle: true,
    patch: null,
    latestVersion: '2.0.0',
    recommended: status === 'upgrade'
      ? {
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
        }
      : null,
    latestEvaluation: null,
    git: null,
    checkedCandidates: 1,
    status,
    messages: status === 'hold' ? [diagnostic('reason.newerUnknown')] : [],
  }
}

function receipt(): AssessmentReceipt {
  return {
    schemaVersion: 2,
    mode: 'read-only-upgrade',
    generatedAt: '2026-08-29T00:00:00.000Z',
    dshHome: '/tmp/.dsh',
    core: {
      current: '0.1.1-rc.2',
      recommended: '0.1.1-rc.2',
      preview: null,
      action: 'current',
      reason: diagnostic('reason.dshCurrent'),
    },
    profiles: [{
      name: 'web',
      path: '/tmp/.dsh/profiles/web',
      config: 'passed',
      dependencyCount: 2,
      bundleCount: 2,
      dependencies: [dependency('upgrade', 'upgrade-me'), dependency('hold', 'hold-me')],
      warnings: [],
    }],
    summary: {
      profiles: 1,
      dependencies: 2,
      recommendedUpdates: 1,
      heldUpdates: 1,
      unknown: 0,
      blocked: 0,
    },
  }
}

describe('renderHuman', () => {
  it('shows held candidate names and versions without reasons by default', () => {
    const output = renderHuman(receipt(), { verbose: false, locale: 'zh-CN' })
    assert.match(output, /upgrade-me/)
    assert.match(output, /hold-me 1\.0\.0 → 2\.0\.0/)
    assert.doesNotMatch(output, /较新版本缺少足够兼容证据/)
    assert.doesNotMatch(output, /只读/)
  })

  it('shows held candidate reasons in verbose output', () => {
    const output = renderHuman(receipt(), { verbose: true, locale: 'zh-CN' })
    assert.match(output, /hold-me 1\.0\.0 → 2\.0\.0/)
    assert.match(output, /较新版本缺少足够兼容证据/)
  })
})

describe('renderUpgradeCandidates', () => {
  it('labels exact updates as pending isolation validation', () => {
    const output = renderUpgradeCandidates(receipt(), { verbose: false, locale: 'zh-CN' })
    assert.match(output, /发现 1 项待验证插件更新/)
    assert.match(output, /upgrade-me 1\.0\.0 → 2\.0\.0/)
    assert.match(output, /1 个较新候选暂不升级/)
    assert.match(output, /web\/hold-me 1\.0\.0 → 2\.0\.0/)
    assert.doesNotMatch(output, /较新版本缺少足够兼容证据/)
    assert.doesNotMatch(output, /隔离验证通过/)
  })

  it('adds held reasons only in verbose candidate output', () => {
    const output = renderUpgradeCandidates(receipt(), { verbose: true, locale: 'zh-CN' })
    assert.match(output, /web\/hold-me 1\.0\.0 → 2\.0\.0/)
    assert.match(output, /较新版本缺少足够兼容证据/)
  })

  it('keeps held names and versions after isolation validation', () => {
    const output = renderUpgradePlan(receipt(), {
      transactionId: 'test',
      dshHome: '/tmp/.dsh',
      stagingRoot: '/tmp/.dsh/dsh-keeper/staging/test',
      profiles: [{
        name: 'web',
        livePath: '/tmp/.dsh/profiles/web',
        stagedPath: '/tmp/.dsh/dsh-keeper/staging/test/profiles/web',
        changes: [{ profile: 'web', package: 'upgrade-me', from: '1.0.0', to: '2.0.0', integrity: 'sha512-test' }],
      }],
      changes: [{ profile: 'web', package: 'upgrade-me', from: '1.0.0', to: '2.0.0', integrity: 'sha512-test' }],
    }, { verbose: false, locale: 'zh-CN' })
    assert.match(output, /隔离验证通过/)
    assert.match(output, /web\/hold-me 1\.0\.0 → 2\.0\.0/)
    assert.doesNotMatch(output, /较新版本缺少足够兼容证据/)
  })
})
