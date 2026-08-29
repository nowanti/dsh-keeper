import assert from 'node:assert/strict'
import test from 'node:test'

import { parseArgs } from '../src/cli.js'

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
