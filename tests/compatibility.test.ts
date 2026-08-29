import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { evaluateCompatibility } from '../src/core/compatibility.js'
import type { CompatibilityHost, PackageManifest } from '../src/core/types.js'

function host(overrides: Partial<CompatibilityHost> = {}): CompatibilityHost {
  return {
    dshVersion: '0.1.1-rc.2',
    nodeVersion: '24.15.0',
    installedVersions: new Map([
      ['@deepseek-ai/dsh-settings', '0.1.1-rc.2'],
      ['react', '18.3.1'],
    ]),
    ...overrides,
  }
}

describe('evaluateCompatibility', () => {
  it('accepts an explicit DSH host contract including prereleases', () => {
    const result = evaluateCompatibility({ dsh: { engines: { dsh: '>=0.1.1-rc.1 <0.1.2' } } }, host())
    assert.equal(result.state, 'declared')
    assert.equal(result.hostContract, 'dsh-engine')
  })

  it('blocks a candidate that requires a newer DSH', () => {
    const result = evaluateCompatibility({ dsh: { engines: { dsh: '>=0.1.2-alpha.1' } } }, host())
    assert.equal(result.state, 'blocked')
    assert.equal(result.blockers[0]?.code, 'reason.dshMismatch')
  })

  it('uses a DSH peer as host contract evidence', () => {
    const manifest: PackageManifest = {
      peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.1-rc.2' },
    }
    const result = evaluateCompatibility(manifest, host())
    assert.equal(result.state, 'declared')
    assert.equal(result.hostContract, 'dsh-peer')
  })

  it('marks missing host metadata as unknown', () => {
    const result = evaluateCompatibility({ peerDependencies: { react: '^18.0.0' } }, host())
    assert.equal(result.state, 'unknown')
  })

  it('keeps unresolved peers as staging evidence instead of a hard conflict', () => {
    const required = evaluateCompatibility({ peerDependencies: { missing: '^1.0.0' } }, host())
    assert.equal(required.state, 'unknown')
    assert.equal(required.warnings[0]?.code, 'reason.peerMissing')

    const optional = evaluateCompatibility({
      dsh: { engines: { dsh: '>=0.1.1-rc.1' } },
      peerDependencies: { missing: '^1.0.0' },
      peerDependenciesMeta: { missing: { optional: true } },
    }, host())
    assert.equal(optional.state, 'declared')
    assert.equal(optional.warnings.some(item => item.code === 'reason.peerMissing'), false)
  })

  it('warns instead of blocking when an installed optional peer is outside range', () => {
    const result = evaluateCompatibility({
      dsh: { engines: { dsh: '>=0.1.1-rc.1' } },
      peerDependencies: { react: '^18.0.0' },
      peerDependenciesMeta: { react: { optional: true } },
    }, host({ installedVersions: new Map([['react', '19.2.8']]) }))
    assert.equal(result.state, 'declared')
    assert.equal(result.warnings[0]?.code, 'reason.optionalPeerMismatch')
  })

  it('uses an installed and satisfied optional DSH peer as contract evidence', () => {
    const result = evaluateCompatibility({
      peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.1-rc.2' },
      peerDependenciesMeta: { '@deepseek-ai/dsh-settings': { optional: true } },
    }, host())
    assert.equal(result.state, 'declared')
    assert.equal(result.hostContract, 'dsh-peer')
  })

  it('reports lifecycle install scripts as risk evidence', () => {
    const result = evaluateCompatibility({
      dsh: { engines: { dsh: '>=0.1.1-rc.1' } },
      scripts: { postinstall: 'node setup.js' },
    }, host())
    assert.deepEqual(result.installScripts, ['postinstall'])
    assert.equal(result.warnings[0]?.code, 'reason.lifecycleScript')
  })
})
