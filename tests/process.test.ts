import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { commandInvocation, runCommand } from '../src/adapters/process.js'

test('Windows shim arguments are transferred as data instead of shell source', () => {
  const args = ['install', 'C:\\path with spaces\\profile', 'name&echo unsafe', '%PATH%']
  const invocation = commandInvocation('pnpm.cmd', args, { Path: 'C:\\bin' }, 'win32')
  assert.equal(invocation.command, 'powershell.exe')
  assert.equal(invocation.args.includes('name&echo unsafe'), false)
  const encoded = invocation.env.DSHKEEPER_COMMAND_PAYLOAD
  assert.ok(encoded)
  const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as { command: string; args: string[] }
  assert.deepEqual(payload, { command: 'pnpm.cmd', args })
})

test('native Windows executables do not need the shim runner', () => {
  const invocation = commandInvocation('taskkill.exe', ['/PID', '42'], {}, 'win32')
  assert.equal(invocation.command, 'taskkill.exe')
  assert.deepEqual(invocation.args, ['/PID', '42'])
  assert.equal(invocation.env.DSHKEEPER_COMMAND_PAYLOAD, undefined)
})

test('Windows executes a .cmd shim without interpreting arguments as PowerShell source', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshkeeper-cmd-'))
  try {
    const scriptDir = join(root, 'path with spaces')
    mkdirSync(scriptDir, { recursive: true })
    writeFileSync(join(scriptDir, 'echo-args.mjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    writeFileSync(join(scriptDir, 'fixture.cmd'), '@echo off\r\nnode "%~dp0echo-args.mjs" %*\r\n')
    const args = ['plain', 'value with spaces', '@scope/package@1.2.3']
    const result = await runCommand(join(scriptDir, 'fixture.cmd'), args, { timeoutMs: 10_000 })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), args)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
