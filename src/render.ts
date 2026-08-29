import type { AssessmentReceipt, DependencyAssessment } from './core/types.js'
import { translate, translateDiagnostic, type Locale } from './i18n.js'
import type { ApplyResult, UpgradePlan } from './upgrade.js'

export interface RenderOptions {
  verbose: boolean
  locale?: Locale
}

function shortCommit(value: string | null): string {
  return value === null ? '?' : value.slice(0, 8)
}

function heldDependencyLine(
  item: DependencyAssessment,
  locale: Locale,
  verbose: boolean,
  name: string = item.name,
): string {
  const from = item.source === 'github' && item.git?.updateAvailable
    ? shortCommit(item.git.currentCommit)
    : item.installedVersion ?? '?'
  const to = item.source === 'github' && item.git?.updateAvailable
    ? shortCommit(item.git.headCommit)
    : item.latestVersion ?? translate(locale, 'fallback.newerCandidate')
  if (!verbose) return translate(locale, 'render.holdCompact', { name, from, to })
  if (item.source === 'github' && item.git?.updateAvailable) {
    return translate(locale, 'render.gitHold', { name, from, to })
  }
  const reason = item.latestEvaluation?.blockers[0]
    ?? item.latestEvaluation?.warnings[0]
    ?? item.messages[0]
  return translate(locale, 'render.hold', {
    name,
    from,
    to,
    reason: reason === undefined ? translate(locale, 'fallback.notValidated') : translateDiagnostic(locale, reason),
  })
}

function dependencyLine(item: DependencyAssessment, locale: Locale, verbose: boolean): string | null {
  if (item.status === 'upgrade' && item.recommended !== null) {
    return translate(locale, 'render.upgradeDeclared', { name: item.name, from: item.installedVersion ?? '?', to: item.recommended.version })
  }
  if (item.source === 'github' && item.git !== null && item.git.updateAvailable) {
    return heldDependencyLine(item, locale, verbose)
  }
  if (item.status === 'hold') {
    return heldDependencyLine(item, locale, verbose)
  }
  if (item.status === 'unknown') {
    return translate(locale, 'render.unknown', { name: item.name, reason: item.messages[0] === undefined ? translate(locale, 'fallback.insufficientEvidence') : translateDiagnostic(locale, item.messages[0]) })
  }
  if (item.status === 'blocked') {
    return translate(locale, 'render.blocked', { name: item.name, reason: item.messages[0] === undefined ? translate(locale, 'fallback.conflict') : translateDiagnostic(locale, item.messages[0]) })
  }
  return null
}

export function renderHuman(receipt: AssessmentReceipt, options: RenderOptions): string {
  const locale = options.locale ?? 'en'
  const lines: string[] = []
  lines.push(translate(locale, receipt.mode === 'read-only-upgrade' ? 'render.upgradeCheckDone' : 'render.statusDone'))
  const current = receipt.core.current ?? translate(locale, 'fallback.unknown')
  const recommended = receipt.core.recommended
  const coreReason = translateDiagnostic(locale, receipt.core.reason)
  if (recommended !== null && recommended !== current) {
    lines.push(translate(locale, 'render.coreRecommended', { current, recommended, reason: coreReason }))
  } else {
    lines.push(translate(locale, 'render.core', { current, reason: coreReason }))
  }
  lines.push('')

  for (const profile of receipt.profiles) {
    const configMark = profile.config === 'passed' ? '✓' : profile.config === 'failed' ? '✗' : '•'
    const config = translate(locale, profile.config === 'passed' ? 'render.configPassed' : profile.config === 'failed' ? 'render.configFailed' : 'render.configSkipped')
    lines.push(translate(locale, 'render.profile', { mark: configMark, name: profile.name, dependencies: profile.dependencyCount, bundles: profile.bundleCount, config }))
    const visible = profile.dependencies
      .map(item => dependencyLine(item, locale, options.verbose))
      .filter((line): line is string => line !== null)
    if (options.verbose && visible.length === 0) lines.push(translate(locale, 'render.allCurrent'))
    else lines.push(...visible)
    for (const warning of profile.warnings) lines.push(`  ? ${translateDiagnostic(locale, warning)}`)
  }

  lines.push('')
  lines.push(translate(locale, 'render.summary', { updates: receipt.summary.recommendedUpdates, held: receipt.summary.heldUpdates, unknown: receipt.summary.unknown, blocked: receipt.summary.blocked }))
  return lines.join('\n')
}

export function renderUpgradeCandidates(receipt: AssessmentReceipt, options: RenderOptions): string {
  const locale = options.locale ?? 'en'
  const lines = [translate(locale, 'render.candidatesFound', { count: receipt.summary.recommendedUpdates })]
  for (const profile of receipt.profiles) {
    const candidates = profile.dependencies.filter(item => item.status === 'upgrade' && item.recommended !== null)
    if (candidates.length === 0) continue
    lines.push(`\n${profile.name}：`)
    for (const item of candidates) {
      lines.push(`  ↑ ${item.name} ${item.installedVersion ?? '?'} → ${item.recommended?.version ?? '?'}`)
    }
  }
  const held = receipt.summary.heldUpdates
  const unknown = receipt.summary.unknown
  if (held > 0 || unknown > 0) lines.push(translate(locale, 'render.remainder', { held, unknown }))
  lines.push(...heldCandidateLines(receipt, locale, options.verbose))
  lines.push(...unreachableRemovalAdvice(receipt, locale))
  return lines.join('\n')
}

function heldCandidateLines(receipt: AssessmentReceipt, locale: Locale, verbose: boolean): string[] {
  return receipt.profiles.flatMap(profile => profile.dependencies
    .filter(item => item.status === 'hold')
    .map(item => heldDependencyLine(item, locale, verbose, `${profile.name}/${item.name}`)))
}

function unreachableRemovalAdvice(receipt: AssessmentReceipt, locale: Locale): string[] {
  return receipt.profiles.flatMap(profile => profile.dependencies.flatMap(item => {
    if (item.source !== 'github' || item.git?.error === null || item.git?.error === undefined) return []
    return [
      translate(locale, 'render.remoteUnavailable', { name: item.name }),
      translate(locale, 'render.removeAdvice', { profile: profile.name, name: item.name }),
    ]
  }))
}

export function renderUpgradePlan(receipt: AssessmentReceipt, plan: UpgradePlan, options: RenderOptions): string {
  const locale = options.locale ?? 'en'
  const lines: string[] = [translate(locale, 'render.stagePassed', { count: plan.changes.length })]
  for (const profile of plan.profiles) {
    lines.push(`\n${profile.name}：`)
    for (const change of profile.changes) lines.push(`  ↑ ${change.package} ${change.from} → ${change.to}`)
  }
  const held = receipt.summary.heldUpdates
  const unknown = receipt.summary.unknown
  if (held > 0 || unknown > 0) lines.push(translate(locale, 'render.remainder', { held, unknown }))
  lines.push(...heldCandidateLines(receipt, locale, options.verbose))
  lines.push(...unreachableRemovalAdvice(receipt, locale))
  return lines.join('\n')
}

export function renderApplyResult(plan: UpgradePlan, result: ApplyResult, locale: Locale = 'en'): string {
  const lines = [translate(locale, 'render.applyDone', { count: plan.changes.length })]
  for (const service of result.restarted) lines.push(translate(locale, 'render.restarted', { profile: service.profile, port: service.port }))
  if (result.restarted.length === 0) lines.push(translate(locale, 'render.noServices'))
  lines.push(translate(locale, 'render.snapshot', { path: result.transactionPath }))
  return lines.join('\n')
}
