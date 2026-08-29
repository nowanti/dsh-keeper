import { satisfies, validRange } from 'semver'

import { diagnostic, type Diagnostic } from './diagnostics.js'
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
  const blockers: Diagnostic[] = []
  const warnings: Diagnostic[] = []
  const dshRange = manifest.dsh?.engines?.dsh?.trim() || null
  const nodeRange = manifest.engines?.node?.trim() || null
  let hostContract: CompatibilityEvaluation['hostContract'] = null

  if (dshRange !== null) {
    const result = matches(host.dshVersion, dshRange)
    if (result === true) hostContract = 'dsh-engine'
    else if (result === false) blockers.push(diagnostic('reason.dshMismatch', { required: dshRange, current: host.dshVersion }))
    else warnings.push(diagnostic('reason.invalidDshRange', { range: dshRange }))
  }

  if (nodeRange !== null) {
    const result = matches(host.nodeVersion, nodeRange)
    if (result === false) blockers.push(diagnostic('reason.nodeMismatch', { required: nodeRange, current: host.nodeVersion }))
    else if (result === null) warnings.push(diagnostic('reason.invalidNodeRange', { range: nodeRange }))
  }

  for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const installed = host.installedVersions.get(peer)
    const optional = manifest.peerDependenciesMeta?.[peer]?.optional === true
    if (installed === undefined) {
      if (!optional) warnings.push(diagnostic('reason.peerMissing', { peer, range }))
      continue
    }
    const result = matches(installed, range)
    if (result === false && optional) warnings.push(diagnostic('reason.optionalPeerMismatch', { peer, required: range, current: installed }))
    else if (result === false) blockers.push(diagnostic('reason.peerMismatch', { peer, required: range, current: installed }))
    else if (result === null) warnings.push(diagnostic('reason.invalidPeerRange', { peer, range }))
    else if (isDshHostPeer(peer) && hostContract === null) hostContract = 'dsh-peer'
  }

  const installScripts = LIFECYCLE_SCRIPTS.filter(name => {
    const value = manifest.scripts?.[name]
    return typeof value === 'string' && value.trim() !== ''
  })
  if (installScripts.length > 0) {
    warnings.push(diagnostic('reason.lifecycleScript', { scripts: installScripts.join(', ') }))
  }

  let state: CompatibilityEvaluation['state']
  if (blockers.length > 0) state = 'blocked'
  else if (hostContract !== null) state = 'declared'
  else {
    state = 'unknown'
    warnings.push(diagnostic('reason.noHostContract'))
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
