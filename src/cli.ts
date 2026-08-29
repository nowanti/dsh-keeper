#!/usr/bin/env node

import { createInterface } from 'node:readline/promises'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { assessEnvironment, type AssessmentOptions } from './assess.js'
import { Spinner } from './progress.js'
import { renderApplyResult, renderHuman, renderUpgradePlan } from './render.js'
import { applyUpgrade, discardStage, stageUpgrade } from './upgrade.js'

const VERSION = '0.2.1'

export interface CliOptions {
  command: 'status' | 'upgrade'
  profile?: string
  pluginsOnly: boolean
  preview: boolean
  json: boolean
  verbose: boolean
  dryRun: boolean
  yes: boolean
}
function usage(): string {
  return `dshctl ${VERSION}

用法:
  dshctl upgrade [选项]
  dshctl status [选项]

命令:
  upgrade              隔离验证推荐更新，确认后自动应用并回滚失败事务
  status               检查本地 DSH、profiles 和配置

选项:
  -P, --profile NAME   只检查一个 profile
  --plugins-only       保持当前 DSH，只检查插件
  --preview            包含 prerelease 插件候选
  --dry-run            完成隔离验证，但不询问、不应用
  -y, --yes            跳过确认，直接应用已通过隔离验证的推荐更新
  --json               输出机器可读 receipt
  -v, --verbose        显示更多保持原因
  -h, --help           显示帮助
  --version            显示版本`
}

export function parseArgs(args: readonly string[]): CliOptions | 'help' | 'version' {
  if (args.length === 0) return 'help'
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') return 'help'
  if (args[0] === '--version' || args[0] === '-V') return 'version'
  const command = args[0]
  if (command !== 'status' && command !== 'upgrade') throw new Error(`未知命令: ${command}`)

  let profile: string | undefined
  let pluginsOnly = false
  let preview = false
  let json = false
  let verbose = false
  let dryRun = false
  let yes = false
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-h' || arg === '--help') return 'help'
    if (arg === '-P' || arg === '--profile') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${arg} 缺少 profile 名`)
      profile = value
      index += 1
    } else if (arg?.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length)
    } else if (arg === '--plugins-only') pluginsOnly = true
    else if (arg === '--preview') preview = true
    else if (arg === '--json') json = true
    else if (arg === '-v' || arg === '--verbose') verbose = true
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '-y' || arg === '--yes') yes = true
    else if (arg === '--all') {
      // All profiles are already the default; retain the alias for compatibility.
    } else throw new Error(`未知选项: ${arg ?? ''}`)
  }
  if (profile !== undefined && !/^[A-Za-z0-9._-]+$/.test(profile)) throw new Error(`无效 profile 名: ${profile}`)
  if (dryRun && yes) throw new Error('--dry-run 不能与 -y/--yes 同时使用')
  if (command === 'status' && (dryRun || yes)) throw new Error('--dry-run 和 -y/--yes 只适用于 upgrade')
  return {
    command,
    ...(profile === undefined ? {} : { profile }),
    pluginsOnly,
    preview,
    json,
    verbose,
    dryRun,
    yes,
  }
}

async function confirmUpgrade(): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await readline.question('\n应用以上更新并自动恢复相关服务？[Y/n] ')).trim().toLowerCase()
    return answer === '' || answer === 'y' || answer === 'yes'
  } finally {
    readline.close()
  }
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: CliOptions | 'help' | 'version'
  try {
    options = parseArgs(args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`错误: ${message}\n\n${usage()}`)
    return 2
  }
  if (options === 'help') {
    console.log(usage())
    return 0
  }
  if (options === 'version') {
    console.log(VERSION)
    return 0
  }

  const spinner = new Spinner(process.stderr, options.json ? { enabled: false } : {})
  const assessmentOptions: AssessmentOptions = {
    command: options.command,
    pluginsOnly: options.pluginsOnly,
    preview: options.preview,
    onProgress: message => spinner.update(message),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
  }
  spinner.start('正在准备检查')
  try {
    const receipt = await assessEnvironment(assessmentOptions)
    if (options.command === 'status') {
      spinner.stop()
      console.log(options.json ? JSON.stringify(receipt, null, 2) : renderHuman(receipt, { verbose: options.verbose }))
      return receipt.summary.blocked > 0 ? 1 : 0
    }

    spinner.update('正在建立无凭据隔离环境')
    const plan = await stageUpgrade(receipt, {
      onProgress: message => spinner.update(message),
    })
    spinner.stop()
    if (plan === null) {
      if (options.json) console.log(JSON.stringify({ outcome: 'current', assessment: receipt }, null, 2))
      else console.log(`已经是当前兼容范围内的推荐状态。\n\n${renderHuman(receipt, { verbose: options.verbose })}`)
      return receipt.summary.blocked > 0 ? 1 : 0
    }

    if (!options.json) console.log(renderUpgradePlan(receipt, plan, { verbose: options.verbose }))
    if (options.dryRun || (options.json && !options.yes)) {
      discardStage(plan)
      if (options.json) console.log(JSON.stringify({ outcome: 'staged', applied: false, assessment: receipt, plan }, null, 2))
      else console.log('\n--dry-run：未修改现有 profile。')
      return 0
    }
    if (!options.yes && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      discardStage(plan)
      console.error('\n非交互环境不会擅自应用；确认后请使用 -y。')
      return 2
    }
    if (!options.yes && !await confirmUpgrade()) {
      discardStage(plan)
      console.log('已取消；现有 profile 没有变化。')
      return 0
    }

    spinner.start('正在建立可恢复快照')
    const result = await applyUpgrade(plan, { onProgress: message => spinner.update(message) })
    spinner.stop()
    if (options.json) console.log(JSON.stringify({ outcome: 'applied', assessment: receipt, plan, result }, null, 2))
    else console.log(renderApplyResult(plan, result))
    return 0
  } catch (error) {
    spinner.stop()
    const message = error instanceof Error ? error.message : String(error)
    console.error(`错误: ${message}`)
    return 1
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}

if (isMainModule()) {
  process.exitCode = await main()
}
