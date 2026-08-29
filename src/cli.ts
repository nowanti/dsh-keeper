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
import { normalizeLocale, resolveLocale, translate, type Locale } from './i18n.js'

const VERSION = '0.3.2'

export interface CliOptions {
  command: 'status' | 'upgrade'
  profile?: string
  pluginsOnly: boolean
  preview: boolean
  json: boolean
  verbose: boolean
  dryRun: boolean
  yes: boolean
  locale: Locale
}

export interface CliDependencies {
  assess?: (options: AssessmentOptions) => Promise<AssessmentReceipt>
  stage?: (receipt: AssessmentReceipt, options?: StageOptions) => Promise<UpgradePlan | null>
  apply?: (plan: UpgradePlan, options?: ApplyOptions) => Promise<ApplyResult>
  discard?: (plan: Pick<UpgradePlan, 'dshHome' | 'stagingRoot'>, locale?: Locale) => void
  confirm?: (locale: Locale) => Promise<boolean>
  interactive?: boolean
  log?: (message: string) => void
  error?: (message: string) => void
  progressOutput?: ProgressOutput
  now?: () => number
  locale?: Locale
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

function renderTimings(timings: UpgradeTimings, locale: Locale): string {
  const phases = [
    timings.discoveryMs === undefined ? null : translate(locale, 'timing.discovery', { duration: formatDuration(timings.discoveryMs) }),
    timings.isolationMs === undefined ? null : translate(locale, 'timing.isolation', { duration: formatDuration(timings.isolationMs) }),
    timings.applyMs === undefined ? null : translate(locale, 'timing.apply', { duration: formatDuration(timings.applyMs) }),
  ].filter((value): value is string => value !== null)
  return phases.length === 0 ? '' : translate(locale, 'timing.total', { phases: phases.join(locale === 'zh-CN' ? '，' : ', ') })
}

function appendVerboseTimings(message: string, timings: UpgradeTimings, verbose: boolean, locale: Locale): string {
  if (!verbose) return message
  const timing = renderTimings(timings, locale)
  return timing === '' ? message : `${message}\n${timing}`
}
function usage(locale: Locale): string {
  return translate(locale, 'cli.usage', { version: VERSION })
}

export function parseArgs(args: readonly string[], initialLocale: Locale = 'en'): CliOptions | 'help' | 'version' {
  if (args.length === 0) return 'help'
  let command: CliOptions['command'] | undefined
  let locale = initialLocale
  let profile: string | undefined
  let pluginsOnly = false
  let preview = false
  let json = false
  let verbose = false
  let dryRun = false
  let yes = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-h' || arg === '--help' || arg === 'help') return 'help'
    if (arg === '--version' || arg === '-V') return 'version'
    if (arg === 'status' || arg === 'upgrade') {
      if (command !== undefined) throw new Error(translate(locale, 'cli.unknownCommand', { command: arg }))
      command = arg
    } else if (arg === '-P' || arg === '--profile') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(translate(locale, 'cli.missingProfile', { option: arg }))
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
    else if (arg === '--lang') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(translate(locale, 'cli.missingLanguage', { option: arg }))
      const normalized = normalizeLocale(value)
      if (normalized === null) throw new Error(translate(locale, 'cli.unsupportedLanguage', { locale: value }))
      locale = normalized
      index += 1
    } else if (arg?.startsWith('--lang=')) {
      const value = arg.slice('--lang='.length)
      const normalized = normalizeLocale(value)
      if (normalized === null) throw new Error(translate(locale, 'cli.unsupportedLanguage', { locale: value }))
      locale = normalized
    }
    else if (arg === '--all') {
      // All profiles are already the default; retain the alias for compatibility.
    } else if (arg?.startsWith('-')) throw new Error(translate(locale, 'cli.unknownOption', { option: arg ?? '' }))
    else throw new Error(translate(locale, 'cli.unknownCommand', { command: arg ?? '' }))
  }
  if (command === undefined) return 'help'
  if (profile !== undefined && !/^[A-Za-z0-9._-]+$/.test(profile)) throw new Error(translate(locale, 'cli.invalidProfile', { profile }))
  if (dryRun && yes) throw new Error(translate(locale, 'cli.dryRunYesConflict'))
  if (command === 'status' && (dryRun || yes)) throw new Error(translate(locale, 'cli.upgradeOnlyOptions'))
  return {
    command,
    ...(profile === undefined ? {} : { profile }),
    pluginsOnly,
    preview,
    json,
    verbose,
    dryRun,
    yes,
    locale,
  }
}

async function confirmUpgrade(locale: Locale): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await readline.question(translate(locale, 'cli.confirm'))).trim().toLowerCase()
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
  const requestedLanguage = args.flatMap((arg, index) => {
    if (arg.startsWith('--lang=')) return [arg.slice('--lang='.length)]
    if (arg === '--lang') return [args[index + 1]]
    return []
  }).find((value): value is string => value !== undefined)
  const initialLocale = dependencies.locale ?? resolveLocale(requestedLanguage === undefined ? {} : { explicit: requestedLanguage })
  let options: CliOptions | 'help' | 'version'
  try {
    options = parseArgs(args, initialLocale)
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught)
    error(`${translate(initialLocale, 'cli.error', { message })}\n\n${usage(initialLocale)}`)
    return 2
  }
  if (options === 'help') {
    log(usage(initialLocale))
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
    locale: options.locale,
    onProgress: message => spinner.update(message),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
  }
  const timings: UpgradeTimings = {}
  spinner.start(translate(options.locale, 'progress.prepare'))
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
      log(options.json ? JSON.stringify(receipt, null, 2) : renderHuman(receipt, { verbose: options.verbose, locale: options.locale }))
      return receipt.summary.blocked > 0 ? 1 : 0
    }

    if (receipt.summary.recommendedUpdates === 0) {
      spinner.stop()
      if (options.json) log(JSON.stringify({ outcome: 'current', assessment: receipt, timings: normalizedTimings(timings) }, null, 2))
      else log(appendVerboseTimings(
        `${translate(options.locale, 'cli.current')}\n\n${renderHuman(receipt, { verbose: options.verbose, locale: options.locale })}`,
        timings,
        options.verbose,
        options.locale,
      ))
      return receipt.summary.blocked > 0 ? 1 : 0
    }

    const auditOnly = options.dryRun || (options.json && !options.yes)
    if (!auditOnly) {
      spinner.stop()
      if (!options.json) log(renderUpgradeCandidates(receipt, { verbose: options.verbose, locale: options.locale }))
      if (!options.yes && !interactive) {
        error(translate(options.locale, 'cli.nonInteractive'))
        return 2
      }
      if (!options.yes && !await confirm(options.locale)) {
        log(appendVerboseTimings(
          translate(options.locale, 'cli.cancelled'),
          timings,
          options.verbose,
          options.locale,
        ))
        return 0
      }
      spinner.start(translate(options.locale, 'progress.stageEnvironment'))
    }

    spinner.update(translate(options.locale, 'progress.stageEnvironment'))
    let plan: UpgradePlan | null
    const isolationStarted = now()
    try {
      plan = await stage(receipt, { onProgress: message => spinner.update(message), locale: options.locale })
    } finally {
      timings.isolationMs = now() - isolationStarted
    }
    spinner.stop()
    if (plan === null) throw new Error(translate(options.locale, 'cli.stageChanged'))

    if (auditOnly) {
      discard(plan, options.locale)
      if (options.json) log(JSON.stringify({ outcome: 'staged', applied: false, assessment: receipt, plan, timings: normalizedTimings(timings) }, null, 2))
      else log(appendVerboseTimings(
        `${renderUpgradePlan(receipt, plan, { verbose: options.verbose, locale: options.locale })}\n\n${translate(options.locale, 'cli.dryRunDone')}`,
        timings,
        options.verbose,
        options.locale,
      ))
      return 0
    }

    spinner.start(translate(options.locale, 'progress.snapshot'))
    let result: ApplyResult
    const applyStarted = now()
    try {
      result = await apply(plan, { onProgress: message => spinner.update(message), locale: options.locale })
    } finally {
      timings.applyMs = now() - applyStarted
    }
    spinner.stop()
    if (options.json) log(JSON.stringify({ outcome: 'applied', assessment: receipt, plan, result, timings: normalizedTimings(timings) }, null, 2))
    else log(appendVerboseTimings(renderApplyResult(plan, result, options.locale), timings, options.verbose, options.locale))
    return 0
  } catch (caught) {
    spinner.stop()
    const message = caught instanceof Error ? caught.message : String(caught)
    const timing = options.command === 'upgrade' && options.verbose ? renderTimings(timings, options.locale) : ''
    error(`${translate(options.locale, 'cli.error', { message })}${timing === '' ? '' : `\n${timing}`}`)
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
