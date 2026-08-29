import type { AssessmentReceipt, DependencyAssessment } from './core/types.js'
import type { ApplyResult, UpgradePlan } from './upgrade.js'

export interface RenderOptions {
  verbose: boolean
}

function shortCommit(value: string | null): string {
  return value === null ? '?' : value.slice(0, 8)
}

function dependencyLine(item: DependencyAssessment): string | null {
  if (item.status === 'upgrade' && item.recommended !== null) {
    return `  ↑ ${item.name} ${item.installedVersion ?? '?'} → ${item.recommended.version}（声明兼容，待隔离验证）`
  }
  if (item.source === 'github' && item.git !== null && item.git.updateAvailable) {
    return `  • ${item.name} ${shortCommit(item.git.currentCommit)} → ${shortCommit(item.git.headCommit)}（Git 候选证据不足，保持）`
  }
  if (item.status === 'hold') {
    const target = item.latestVersion ?? '较新候选'
    const reason = item.latestEvaluation?.blockers[0]
      ?? item.latestEvaluation?.warnings[0]
      ?? item.messages[0]
      ?? '尚未验证'
    return `  • ${item.name} ${item.installedVersion ?? '?'} → ${target}（保持：${reason}）`
  }
  if (item.status === 'unknown') {
    return `  ? ${item.name}（${item.messages[0] ?? '证据不足'}）`
  }
  if (item.status === 'blocked') {
    return `  ✗ ${item.name}（${item.messages[0] ?? '存在确定冲突'}）`
  }
  return null
}

export function renderHuman(receipt: AssessmentReceipt, options: RenderOptions): string {
  const lines: string[] = []
  lines.push(receipt.mode === 'read-only-upgrade' ? '升级候选检查完成。' : 'DSH 状态检查完成。')
  const current = receipt.core.current ?? '未知'
  const recommended = receipt.core.recommended
  if (recommended !== null && recommended !== current) {
    lines.push(`DSH ${current}；推荐通道 ${recommended}。${receipt.core.message}`)
  } else {
    lines.push(`DSH ${current}：${receipt.core.message}`)
  }
  lines.push('')

  for (const profile of receipt.profiles) {
    const configMark = profile.config === 'passed' ? '✓' : profile.config === 'failed' ? '✗' : '•'
    lines.push(`${configMark} ${profile.name}: ${profile.dependencyCount} 个直接依赖，${profile.bundleCount} 个 bundle，配置${profile.config === 'passed' ? '通过' : profile.config === 'failed' ? '失败' : '未检查'}`)
    const visible = profile.dependencies
      .filter(item => options.verbose || item.status !== 'hold')
      .map(dependencyLine)
      .filter((line): line is string => line !== null)
    if (options.verbose && visible.length === 0) lines.push('  所有已检查依赖保持当前版本。')
    else lines.push(...visible)
    if (!options.verbose) {
      const held = profile.dependencies.filter(item => item.status === 'hold').length
      if (held > 0) lines.push(`  ${held} 个较新候选保持当前版本（用 --verbose 查看原因）`)
    }
    for (const warning of profile.warnings) lines.push(`  ? ${warning}`)
  }

  lines.push('')
  lines.push(`结论：${receipt.summary.recommendedUpdates} 个候选可进入隔离验证；${receipt.summary.heldUpdates} 个保持；${receipt.summary.unknown} 个未知；${receipt.summary.blocked} 个阻塞。`)
  lines.push(...receipt.notices)
  return lines.join('\n')
}

export function renderUpgradeCandidates(receipt: AssessmentReceipt, options: RenderOptions): string {
  const lines = [`发现 ${receipt.summary.recommendedUpdates} 项待验证插件更新。`]
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
  if (held > 0 || unknown > 0) lines.push(`\n其余保持现状：${held} 个较新候选暂不升级，${unknown} 个来源状态未知。`)
  lines.push(...unreachableRemovalAdvice(receipt))
  if (options.verbose) {
    for (const profile of receipt.profiles) {
      for (const item of profile.dependencies.filter(value => value.status === 'hold')) {
        lines.push(`  • ${profile.name}/${item.name}：${item.messages[0] ?? '证据不足'}`)
      }
    }
  }
  return lines.join('\n')
}

function unreachableRemovalAdvice(receipt: AssessmentReceipt): string[] {
  return receipt.profiles.flatMap(profile => profile.dependencies.flatMap(item => {
    if (item.source !== 'github' || item.git?.error === null || item.git?.error === undefined) return []
    return [
      `  ? ${item.name}：远端不可达，已安装版本会继续保留。`,
      `    确认不再需要时手动移除：dsh plugin --profile ${profile.name} remove ${item.name}`,
    ]
  }))
}

export function renderUpgradePlan(receipt: AssessmentReceipt, plan: UpgradePlan, options: RenderOptions): string {
  const lines: string[] = [`隔离验证通过：${plan.changes.length} 项插件更新已达到当前自动切换门槛。`]
  for (const profile of plan.profiles) {
    lines.push(`\n${profile.name}：`)
    for (const change of profile.changes) lines.push(`  ↑ ${change.package} ${change.from} → ${change.to}`)
  }
  const held = receipt.summary.heldUpdates
  const unknown = receipt.summary.unknown
  if (held > 0 || unknown > 0) lines.push(`\n其余保持现状：${held} 个较新候选暂不升级，${unknown} 个来源状态未知。`)
  lines.push(...unreachableRemovalAdvice(receipt))
  if (options.verbose) {
    for (const profile of receipt.profiles) {
      for (const item of profile.dependencies.filter(value => value.status === 'hold')) {
        lines.push(`  • ${profile.name}/${item.name}：${item.messages[0] ?? '证据不足'}`)
      }
    }
  }
  return lines.join('\n')
}

export function renderApplyResult(plan: UpgradePlan, result: ApplyResult): string {
  const lines = [`升级完成：${plan.changes.length} 项插件更新已通过隔离验证并应用。`]
  for (const service of result.restarted) lines.push(`✓ ${service.profile} 已重启，端口 ${service.port} 已恢复监听。`)
  if (result.restarted.length === 0) lines.push('现有常驻服务未受影响；更新将在 profile 下次启动时生效。')
  lines.push(`可恢复快照：${result.transactionPath}`)
  return lines.join('\n')
}
