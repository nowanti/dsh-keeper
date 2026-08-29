import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { runCommand } from '../dist/src/adapters/process.js'

const version = process.env.DSH_E2E_VERSION?.trim() || '0.1.1-rc.2'
const root = mkdtempSync(join(tmpdir(), 'dsh-keeper-real-dsh-'))
const tool = join(root, 'tool')
const home = join(root, 'home')
mkdirSync(tool, { recursive: true })
writeFileSync(join(tool, 'package.json'), `${JSON.stringify({ private: true }, null, 2)}\n`)

const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH'
const env = {
  ...process.env,
  DSH_HOME: home,
  [pathKey]: `${join(tool, 'node_modules', '.bin')}${delimiter}${process.env[pathKey] ?? ''}`,
}

async function requireSuccess(command, args, options = {}) {
  const result = await runCommand(command, args, { ...options, env, timeoutMs: options.timeoutMs ?? 10 * 60_000 })
  if (result.code !== 0 || result.timedOut) {
    const detail = (result.stderr || result.stdout).trim().slice(-4_000)
    throw new Error(`${command} ${args.join(' ')} failed${result.timedOut ? ' (timeout)' : ''}: ${detail}`)
  }
  return result
}

try {
  await requireSuccess('pnpm', ['add', `@deepseek-ai/dsh@${version}`, '--ignore-scripts'], { cwd: tool })
  const reported = (await requireSuccess('dsh', ['--version'])).stdout.trim()
  if (reported !== version) throw new Error(`expected DSH ${version}, received ${reported}`)

  await requireSuccess('dsh', ['plugin', '--profile', 'web', 'install', '--ignore-scripts'])
  const receiptPath = join(root, 'receipt.json')
  const status = await requireSuccess(process.execPath, [
    join(process.cwd(), 'dist', 'src', 'cli.js'),
    'status',
    '--profile',
    'web',
    '--lang',
    'en',
    '--json',
  ])
  writeFileSync(receiptPath, status.stdout)
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  if (receipt.schemaVersion !== 2) throw new Error(`unexpected receipt schema: ${receipt.schemaVersion}`)
  if (receipt.core?.current !== version) throw new Error(`dsh-keeper saw DSH ${receipt.core?.current ?? 'unknown'}`)
  if (receipt.profiles?.[0]?.config !== 'passed') throw new Error('real DSH --dump-config validation did not pass')
  process.stdout.write(`real DSH ${version} profile E2E passed on ${process.platform}/${process.arch}\n`)
} finally {
  if (process.env.DSH_KEEPER_KEEP_E2E === '1') process.stdout.write(`fixture retained at ${root}\n`)
  else rmSync(root, { recursive: true, force: true })
}
