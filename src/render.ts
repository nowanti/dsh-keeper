import type { AssessmentReceipt, DependencyAssessment } from './core/types.js'

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
  lines.push(receipt.mode === 'read-only-upgrade' ? '只读升级检查完成。' : 'DSH 状态检查完成。')
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
