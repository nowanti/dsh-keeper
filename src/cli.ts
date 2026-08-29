#!/usr/bin/env node

import { createInterface } from 'node:readline/promises'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { assessEnvironment, type AssessmentOptions } from './assess.js'
import { Spinner, type ProgressOutput } from './progress.js'
import { renderApplyResult, renderHuman, renderUpgradeCandidates, renderUpgradePlan } from './render.js'
import {
  applyUpgrade,
  discardStage,
  stageUpgrade,
  type ApplyOptions,
  type ApplyResult,
  type StageOptions,
  type UpgradePlan,
} from './upgrade.js'
import type { AssessmentReceipt } from './core/types.js'

const VERSION = '0.2.3'

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

export interface CliDependencies {
  assess?: (options: AssessmentOptions) => Promise<AssessmentReceipt>
  stage?: (receipt: AssessmentReceipt, options?: StageOptions) => Promise<UpgradePlan | null>
  apply?: (plan: UpgradePlan, options?: ApplyOptions) => Promise<ApplyResult>
  discard?: (plan: Pick<UpgradePlan, 'dshHome' | 'stagingRoot'>) => void
  confirm?: () => Promise<boolean>
  interactive?: boolean
  log?: (message: string) => void
  error?: (message: string) => void
  progressOutput?: ProgressOutput
  now?: () => number
}

interface UpgradeTimings {
  discoveryMs?: number
  isolationMs?: number
  applyMs?: number
}

function normalizedTimings(timings: UpgradeTimings): UpgradeTimings {
  return Object.fromEntries(
    Object.entries(timings).map(([key, value]) => [key, Math.max(0, Math.round(value))]),
  )
}

function formatDuration(milliseconds: number): string {
  const value = Math.max(0, milliseconds)
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`
}

function renderTimings(timings: UpgradeTimings): string {
  const phases = [
    timings.discoveryMs === undefined ? null : `候选发现 ${formatDuration(timings.discoveryMs)}`,
    timings.isolationMs === undefined ? null : `隔离验证 ${formatDuration(timings.isolationMs)}`,
    timings.applyMs === undefined ? null : `应用与恢复 ${formatDuration(timings.applyMs)}`,
  ].filter((value): value is string => value !== null)
  return phases.length === 0 ? '' : `用时：${phases.join('，')}。`
}

function appendVerboseTimings(message: string, timings: UpgradeTimings, verbose: boolean): string {
  if (!verbose) return message
  const timing = renderTimings(timings)
  return timing === '' ? message : `${message}\n${timing}`
}
function usage(): string {
  return `dshctl ${VERSION}

用法:
  dshctl upgrade [选项]
  dshctl status [选项]

命令:
  upgrade              展示候选，确认后隔离验证、应用并回滚失败事务
  status               检查本地 DSH、profiles 和配置

选项:
  -P, --profile NAME   只检查一个 profile
  --plugins-only       保持当前 DSH，只检查插件
  --preview            包含 prerelease 插件候选
  --dry-run            完成隔离验证，但不询问、不应用
  -y, --yes            跳过确认，仍经隔离验证后自动应用推荐更新
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
    const answer = (await readline.question('\n继续隔离验证，并在整组通过后应用？验证不通过不会切换现有 profile。[Y/n] ')).trim().toLowerCase()
    return answer === '' || answer === 'y' || answer === 'yes'
  } finally {
    readline.close()
  }
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> {
  const log = dependencies.log ?? (message => console.log(message))
  const error = dependencies.error ?? (message => console.error(message))
  const assess = dependencies.assess ?? assessEnvironment
  const stage = dependencies.stage ?? stageUpgrade
  const apply = dependencies.apply ?? applyUpgrade
  const discard = dependencies.discard ?? discardStage
  const confirm = dependencies.confirm ?? confirmUpgrade
  const interactive = dependencies.interactive ?? (process.stdin.isTTY && process.stdout.isTTY)
  const now = dependencies.now ?? Date.now
  let options: CliOptions | 'help' | 'version'
  try {
    options = parseArgs(args)
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught)
    error(`错误: ${message}\n\n${usage()}`)
    return 2
  }
  if (options === 'help') {
    log(usage())
    return 0
  }
  if (options === 'version') {
    log(VERSION)
    return 0
  }

  const spinner = new Spinner(dependencies.progressOutput ?? process.stderr, options.json ? { enabled: false } : {})
  const assessmentOptions: AssessmentOptions = {
    command: options.command,
    pluginsOnly: options.pluginsOnly,
    preview: options.preview,
    onProgress: message => spinner.update(message),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
  }
  const timings: UpgradeTimings = {}
  spinner.start('正在准备检查')
  try {
    let receipt: AssessmentReceipt
    const discoveryStarted = now()
    try {
      receipt = await assess(assessmentOptions)
    } finally {
      timings.discoveryMs = now() - discoveryStarted
    }
    if (options.command === 'status') {
      spinner.stop()
      log(options.json ? JSON.stringify(receipt, null, 2) : renderHuman(receipt, { verbose: options.verbose }))
      return receipt.summary.blocked > 0 ? 1 : 0
    }

    if (receipt.summary.recommendedUpdates === 0) {
      spinner.stop()
      if (options.json) log(JSON.stringify({ outcome: 'current', assessment: receipt, timings: normalizedTimings(timings) }, null, 2))
      else log(appendVerboseTimings(
        `已经是当前兼容范围内的推荐状态。\n\n${renderHuman(receipt, { verbose: options.verbose })}`,
        timings,
        options.verbose,
      ))
      return receipt.summary.blocked > 0 ? 1 : 0
    }

    const auditOnly = options.dryRun || (options.json && !options.yes)
    if (!auditOnly) {
      spinner.stop()
      if (!options.json) log(renderUpgradeCandidates(receipt, { verbose: options.verbose }))
      if (!options.yes && !interactive) {
        error('\n非交互环境不会擅自应用；确认后请使用 -y。')
        return 2
      }
      if (!options.yes && !await confirm()) {
        log(appendVerboseTimings(
          '已取消；未下载候选包或执行隔离安装，现有 profile 没有变化。',
          timings,
          options.verbose,
        ))
        return 0
      }
      spinner.start('正在建立无凭据隔离环境')
    }

    spinner.update('正在建立无凭据隔离环境')
    let plan: UpgradePlan | null
    const isolationStarted = now()
    try {
      plan = await stage(receipt, { onProgress: message => spinner.update(message) })
    } finally {
      timings.isolationMs = now() - isolationStarted
    }
    spinner.stop()
    if (plan === null) throw new Error('候选清单在隔离验证前发生变化，拒绝继续')

    if (auditOnly) {
      discard(plan)
      if (options.json) log(JSON.stringify({ outcome: 'staged', applied: false, assessment: receipt, plan, timings: normalizedTimings(timings) }, null, 2))
      else log(appendVerboseTimings(
        `${renderUpgradePlan(receipt, plan, { verbose: options.verbose })}\n\n--dry-run：未修改现有 profile。`,
        timings,
        options.verbose,
      ))
      return 0
    }

    spinner.start('隔离验证通过，正在建立可恢复快照')
    let result: ApplyResult
    const applyStarted = now()
    try {
      result = await apply(plan, { onProgress: message => spinner.update(message) })
    } finally {
      timings.applyMs = now() - applyStarted
    }
    spinner.stop()
    if (options.json) log(JSON.stringify({ outcome: 'applied', assessment: receipt, plan, result, timings: normalizedTimings(timings) }, null, 2))
    else log(appendVerboseTimings(renderApplyResult(plan, result), timings, options.verbose))
    return 0
  } catch (caught) {
    spinner.stop()
    const message = caught instanceof Error ? caught.message : String(caught)
    const timing = options.command === 'upgrade' && options.verbose ? renderTimings(timings) : ''
    error(`错误: ${message}${timing === '' ? '' : `\n${timing}`}`)
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
