import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { newerCandidateVersions } from '../src/core/selection.js'

describe('newerCandidateVersions', () => {
  it('sorts newest first and excludes prereleases by default', () => {
    const result = newerCandidateVersions(['1.0.1', '1.1.0-beta.1', '1.0.2', '0.9.0'], '1.0.0', false)
    assert.deepEqual(result, ['1.0.2', '1.0.1'])
  })

  it('includes prereleases only when explicitly enabled', () => {
    const result = newerCandidateVersions(['1.1.0-beta.1', '1.0.1'], '1.0.0', true)
    assert.deepEqual(result, ['1.1.0-beta.1', '1.0.1'])
  })
})
