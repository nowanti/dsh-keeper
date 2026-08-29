export type DiagnosticParam = string | number | boolean | null

export type DiagnosticCode =
  | 'reason.addedLifecycleScript'
  | 'reason.permissionsChanged'
  | 'reason.localPatch'
  | 'reason.missingIntegrity'
  | 'reason.dshMismatch'
  | 'reason.invalidDshRange'
  | 'reason.nodeMismatch'
  | 'reason.invalidNodeRange'
  | 'reason.peerMissing'
  | 'reason.optionalPeerMismatch'
  | 'reason.peerMismatch'
  | 'reason.invalidPeerRange'
  | 'reason.lifecycleScript'
  | 'reason.noHostContract'
  | 'reason.installedManifestMissing'
  | 'reason.compatibleCandidate'
  | 'reason.newerBlocked'
  | 'reason.newerUnknown'
  | 'reason.candidateLimit'
  | 'reason.npmMetadataUnavailable'
  | 'reason.githubFormatInvalid'
  | 'reason.githubNotPinned'
  | 'reason.gitInstalledManifestMissing'
  | 'reason.gitRemoteUnavailable'
  | 'reason.gitHeadChanged'
  | 'reason.linkedNotChecked'
  | 'reason.sourceUnknown'
  | 'reason.pnpmOutdatedFailed'
  | 'reason.dshVersionUnavailable'
  | 'reason.statusLocalOnly'
  | 'reason.pluginsOnly'
  | 'reason.dshLatestUnavailable'
  | 'reason.dshUpgradeUnsupported'
  | 'reason.dshCurrent'
  | 'reason.dshNoForwardUpdate'
  | 'reason.dshChannelUnavailable'

export interface Diagnostic {
  code: DiagnosticCode
  params?: Record<string, DiagnosticParam>
}

export function diagnostic(code: DiagnosticCode, params?: Record<string, DiagnosticParam>): Diagnostic {
  return params === undefined ? { code } : { code, params }
}
