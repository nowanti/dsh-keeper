import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderHuman, renderUpgradeCandidates } from '../src/render.js'
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
    messages: status === 'hold' ? ['证据不足'] : [],
  }
}

function receipt(): AssessmentReceipt {
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
    notices: ['只读'],
  }
}

describe('renderHuman', () => {
  it('collapses held candidates in default output', () => {
    const output = renderHuman(receipt(), { verbose: false })
    assert.match(output, /upgrade-me/)
    assert.doesNotMatch(output, /hold-me/)
    assert.doesNotMatch(output, /只读/)
    assert.match(output, /1 个较新候选保持当前版本/)
  })

  it('shows held candidate reasons in verbose output', () => {
    const output = renderHuman(receipt(), { verbose: true })
    assert.match(output, /hold-me/)
  })
})

describe('renderUpgradeCandidates', () => {
  it('labels exact updates as pending isolation validation', () => {
    const output = renderUpgradeCandidates(receipt(), { verbose: false })
    assert.match(output, /发现 1 项待验证插件更新/)
    assert.match(output, /upgrade-me 1\.0\.0 → 2\.0\.0/)
    assert.match(output, /1 个较新候选暂不升级/)
    assert.doesNotMatch(output, /隔离验证通过/)
  })
})
