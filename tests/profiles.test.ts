import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  dependencySource,
  discoverProfiles,
  patchEvidence,
} from '../src/adapters/profiles.js'

describe('profile inventory', () => {
  let root = ''

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-keeper-profile-'))
    const profile = join(root, 'profiles', 'web')
    await mkdir(join(profile, 'node_modules', 'example-plugin'), { recursive: true })
    await mkdir(join(profile, 'patches'), { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      dependencies: { 'example-plugin': '1.0.0' },
      pnpm: { patchedDependencies: { 'example-plugin@1.0.0': 'patches/example.patch' } },
      dsh: { profile: { bundles: ['example-plugin'] } },
    }))
    await writeFile(join(profile, 'node_modules', 'example-plugin', 'package.json'), JSON.stringify({
      name: 'example-plugin',
      version: '1.0.0',
    }))
    await writeFile(join(profile, 'patches', 'example.patch'), 'patch contents')
    await writeFile(join(profile, '.credentials.yaml'), 'this is deliberately not JSON')
  })

  after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads only profile and installed package manifests', () => {
    const profiles = discoverProfiles(root)
    assert.equal(profiles.length, 1)
    const profile = profiles[0]
    assert.equal(profile?.name, 'web')
    assert.equal(profile?.installedVersions.get('example-plugin'), '1.0.0')
    assert.equal(profile?.bundles.has('example-plugin'), true)
  })

  it('hashes an in-profile patch without exposing its content', () => {
    const profile = discoverProfiles(root)[0]
    assert.ok(profile)
    const patch = patchEvidence(profile, 'example-plugin', '1.0.0')
    assert.equal(patch?.exists, true)
    assert.match(patch?.sha256 ?? '', /^[0-9a-f]{64}$/)
  })

  it('classifies dependency sources', () => {
    assert.equal(dependencySource('^1.0.0'), 'npm')
    assert.equal(dependencySource('github:owner/repo#0123456789abcdef0123456789abcdef01234567'), 'github')
    assert.equal(dependencySource('link:../plugin'), 'linked')
  })
})
