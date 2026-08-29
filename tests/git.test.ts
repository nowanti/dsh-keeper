import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseGitHubReference } from '../src/adapters/git.js'

describe('parseGitHubReference', () => {
  it('recognizes a full immutable GitHub commit', () => {
    const value = parseGitHubReference('github:owner/repo#0123456789abcdef0123456789abcdef01234567')
    assert.deepEqual(value, {
      owner: 'owner',
      repository: 'repo',
      ref: '0123456789abcdef0123456789abcdef01234567',
      exact: true,
    })
  })

  it('marks branches as mutable', () => {
    const value = parseGitHubReference('github:owner/repo#main')
    assert.equal(value?.exact, false)
  })

  it('rejects non-GitHub targets', () => {
    assert.equal(parseGitHubReference('git+ssh://example.com/repo'), null)
  })
})
