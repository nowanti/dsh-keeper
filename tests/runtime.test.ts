import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DshRuntimeController, type RuntimeSpec, windowsServiceCommandLine } from '../src/adapters/runtime.js'
import type { CommandResult } from '../src/adapters/process.js'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  return port
}

async function spawnFixture(port: number, closeOnInterrupt: boolean): Promise<ChildProcess> {
  const script = `
    const net = require('node:net')
    const server = net.createServer(() => {})
    const keepAlive = setInterval(() => {}, 60000)
    process.on('SIGINT', () => { ${closeOnInterrupt ? 'server.close()' : ''} })
    process.on('SIGTERM', () => {})
    server.listen(${port}, '127.0.0.1', () => process.stdout.write('ready\\n'))
    process.on('exit', () => clearInterval(keepAlive))
  `
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture did not become ready')), 3_000)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.stdout?.once('data', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  return child
}

function runtimeFor(child: ChildProcess, port: number): RuntimeSpec {
  assert.ok(child.pid)
  return { profile: 'web', pid: child.pid, port, cwd: process.cwd() }
}

function testController(messages: string[] = []): DshRuntimeController {
  return new DshRuntimeController(process.env, {
    interruptGraceMs: 100,
    terminateGraceMs: 100,
    forceGraceMs: 1_000,
    onProgress: message => messages.push(message),
    locale: 'zh-CN',
  })
}

test('force-cleans a process only after its service port has closed', {
  skip: process.platform === 'win32',
}, async () => {
  const port = await freePort()
  const child = await spawnFixture(port, true)
  const messages: string[] = []
  try {
    await testController(messages).stop(runtimeFor(child, port))
    assert.match(messages.join('\n'), /退出清理卡住/)
    assert.equal(child.killed, false)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

test('refuses SIGKILL while the service port is still listening', {
  skip: process.platform === 'win32',
}, async () => {
  const port = await freePort()
  const child = await spawnFixture(port, false)
  try {
    await assert.rejects(testController().stop(runtimeFor(child, port)), /仍在监听，拒绝强制结束/)
    assert.equal(child.exitCode, null)
    assert.equal(child.signalCode, null)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

test('discovers DSH processes through the Windows CIM adapter', async () => {
  const output: CommandResult = {
    code: 0,
    stdout: JSON.stringify([
      { pid: 42, command: 'C:\\Tools\\dsh.cmd --profile web --port 3080' },
      { pid: 43, command: 'C:\\Tools\\dshkeeper.cmd upgrade --profile web' },
    ]),
    stderr: '',
    timedOut: false,
  }
  const controller = new DshRuntimeController({}, {
    platform: 'win32',
    runCommand: async () => output,
  })
  assert.deepEqual(await controller.inspect('web'), [{ profile: 'web', pid: 42, port: 3080, cwd: process.cwd() }])
})

test('builds only constrained Windows service command lines', () => {
  assert.equal(
    windowsServiceCommandLine('C:\\Program Files\\dsh.cmd', 'web-dev', 3080),
    '"C:\\Program Files\\dsh.cmd" --profile web-dev --port 3080',
  )
  assert.equal(windowsServiceCommandLine('dsh.cmd & whoami', 'web', 3080), null)
  assert.equal(windowsServiceCommandLine('dsh.cmd', 'web & whoami', 3080), null)
  assert.equal(windowsServiceCommandLine('dsh.cmd', 'web', 70_000), null)
})

async function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(500)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

test('starts, discovers, and stops a detached DSH shim on native Windows', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshkeeper-windows-runtime-'))
  const binDir = join(root, 'dsh')
  mkdirSync(binDir, { recursive: true })
  const fixture = [
    "import { createServer } from 'node:net'",
    "const args = process.argv.slice(2)",
    "const port = Number(args[args.indexOf('--port') + 1])",
    "const server = createServer(() => {})",
    "server.listen(port, '127.0.0.1')",
  ].join('\n')
  writeFileSync(join(binDir, 'fixture.mjs'), `${fixture}\n`)
  const shim = join(binDir, 'dsh.cmd')
  writeFileSync(shim, '@echo off\r\nnode "%~dp0fixture.mjs" %*\r\n')
  const port = await freePort()
  const controller = new DshRuntimeController({ ...process.env, DSH_BIN: shim }, {
    platform: 'win32',
    terminateGraceMs: 5_000,
    forceGraceMs: 5_000,
  })
  try {
    const started = await controller.start({ profile: 'web', pid: 0, port, cwd: root }, join(root, 'home'))
    assert.ok(started.pid > 0)
    assert.equal(await listening(port), true)
    await controller.stop(started)
    assert.equal(await listening(port), false)
  } finally {
    // Windows may briefly retain the detached launcher's working-directory
    // handle after its service child has exited.
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
