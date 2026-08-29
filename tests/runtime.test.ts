import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import test from 'node:test'

import { DshRuntimeController, type RuntimeSpec } from '../src/adapters/runtime.js'

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
  })
}

test('force-cleans a process only after its service port has closed', async () => {
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

test('refuses SIGKILL while the service port is still listening', async () => {
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
