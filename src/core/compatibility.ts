import { satisfies, validRange } from 'semver'

import type {
  CompatibilityEvaluation,
  CompatibilityHost,
  PackageManifest,
} from './types.js'

const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const

function isDshHostPeer(name: string): boolean {
  return name === '@deepseek-ai/cordis'
    || name === '@deepseek-ai/schemastery'
    || name.startsWith('@deepseek-ai/dsh-')
}

function matches(version: string, range: string): boolean | null {
  if (validRange(range, { loose: true }) === null) return null
  return satisfies(version, range, { includePrerelease: true, loose: true })
}

export function evaluateCompatibility(
  manifest: PackageManifest,
  host: CompatibilityHost,
): CompatibilityEvaluation {
  const blockers: string[] = []
  const warnings: string[] = []
  const dshRange = manifest.dsh?.engines?.dsh?.trim() || null
  const nodeRange = manifest.engines?.node?.trim() || null
  let hostContract: CompatibilityEvaluation['hostContract'] = null

  if (dshRange !== null) {
    const result = matches(host.dshVersion, dshRange)
    if (result === true) hostContract = 'dsh-engine'
    else if (result === false) blockers.push(`需要 DSH ${dshRange}，当前是 ${host.dshVersion}`)
    else warnings.push(`无法解析 DSH 兼容范围 ${dshRange}`)
  }

  if (nodeRange !== null) {
    const result = matches(host.nodeVersion, nodeRange)
    if (result === false) blockers.push(`需要 Node ${nodeRange}，当前是 ${host.nodeVersion}`)
    else if (result === null) warnings.push(`无法解析 Node 兼容范围 ${nodeRange}`)
  }

  for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const installed = host.installedVersions.get(peer)
    const optional = manifest.peerDependenciesMeta?.[peer]?.optional === true
    if (installed === undefined) {
      if (!optional) blockers.push(`缺少必需 peer ${peer}@${range}`)
      continue
    }
    const result = matches(installed, range)
    if (result === false && optional) warnings.push(`可选 peer ${peer} 期望 ${range}，当前是 ${installed}`)
    else if (result === false) blockers.push(`peer ${peer} 需要 ${range}，当前是 ${installed}`)
    else if (result === null) warnings.push(`无法解析 peer ${peer} 的范围 ${range}`)
    else if (isDshHostPeer(peer) && hostContract === null) hostContract = 'dsh-peer'
  }

  const installScripts = LIFECYCLE_SCRIPTS.filter(name => {
    const value = manifest.scripts?.[name]
    return typeof value === 'string' && value.trim() !== ''
  })
  if (installScripts.length > 0) {
    warnings.push(`包含 lifecycle script: ${installScripts.join(', ')}`)
  }

  let state: CompatibilityEvaluation['state']
  if (blockers.length > 0) state = 'blocked'
  else if (hostContract !== null) state = 'declared'
  else {
    state = 'unknown'
    warnings.push('插件没有声明可判断的 DSH host contract')
  }

  return {
    state,
    dshRange,
    nodeRange,
    hostContract,
    blockers,
    warnings,
    installScripts: [...installScripts],
  }
}
