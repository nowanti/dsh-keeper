import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { DshAdapter } from '../src/adapters/dsh.js'

describe('DshAdapter installation inventory', () => {
  let root = ''
  let binary = ''

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'dshctl-host-'))
    binary = join(root, 'lib', 'bin.js')
    await mkdir(join(root, 'lib'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'react'), { recursive: true })
    await mkdir(join(root, 'node_modules', '@deepseek-ai', 'dsh-agent'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }))
    await writeFile(binary, '#!/usr/bin/env node\n')
    await chmod(binary, 0o755)
    await writeFile(join(root, 'node_modules', 'react', 'package.json'), JSON.stringify({ name: 'react', version: '18.3.1' }))
    await writeFile(join(root, 'node_modules', '@deepseek-ai', 'dsh-agent', 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-agent',
      version: '0.1.1-rc.2',
    }))
  })

  after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('discovers peer versions supplied by the DSH installation', async () => {
    const installation = new DshAdapter({ DSH_BIN: binary }).installation()
    assert.equal(installation?.path, await realpath(root))
    assert.equal(installation?.versions.get('@deepseek-ai/dsh'), '0.1.1-rc.2')
    assert.equal(installation?.versions.get('@deepseek-ai/dsh-agent'), '0.1.1-rc.2')
    assert.equal(installation?.versions.get('react'), '18.3.1')
  })
})
