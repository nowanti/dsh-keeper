import type { Diagnostic } from './diagnostics.js'

export type CompatibilityState = 'declared' | 'unknown' | 'blocked'

export type DependencySource = 'npm' | 'github' | 'linked' | 'unknown'

export interface DshManifestFields {
  engines?: {
    dsh?: string
  }
  bundle?: unknown
  permissions?: unknown
}
export interface PackageManifest {
  name?: string
  version?: string
  dsh?: DshManifestFields
  engines?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  scripts?: Record<string, string>
  dist?: {
    integrity?: string
  }
}

export interface CompatibilityEvaluation {
  state: CompatibilityState
  dshRange: string | null
  nodeRange: string | null
  hostContract: 'dsh-engine' | 'dsh-peer' | null
  blockers: Diagnostic[]
  warnings: Diagnostic[]
  installScripts: string[]
}

export interface PatchEvidence {
  path: string
  exists: boolean
  sha256: string | null
}

export interface NpmCandidate {
  version: string
  integrity: string | null
  evaluation: CompatibilityEvaluation
}

export interface GitCandidate {
  repository: string
  currentCommit: string | null
  headCommit: string | null
  exact: boolean
  updateAvailable: boolean
  error: Diagnostic | null
}

export interface DependencyAssessment {
  name: string
  requested: string
  installedVersion: string | null
  source: DependencySource
  activeBundle: boolean
  patch: PatchEvidence | null
  latestVersion: string | null
  recommended: NpmCandidate | null
  latestEvaluation: CompatibilityEvaluation | null
  git: GitCandidate | null
  checkedCandidates: number
  status: 'current' | 'upgrade' | 'hold' | 'unknown' | 'blocked'
  messages: Diagnostic[]
}

export interface ProfileAssessment {
  name: string
  path: string
  config: 'passed' | 'failed' | 'skipped'
  dependencyCount: number
  bundleCount: number
  dependencies: DependencyAssessment[]
  warnings: Diagnostic[]
}

export interface CoreAssessment {
  current: string | null
  recommended: string | null
  preview: string | null
  action: 'current' | 'hold' | 'unknown'
  reason: Diagnostic
}

export interface AssessmentSummary {
  profiles: number
  dependencies: number
  recommendedUpdates: number
  heldUpdates: number
  unknown: number
  blocked: number
}

export interface AssessmentReceipt {
  schemaVersion: 2
  mode: 'status' | 'read-only-upgrade'
  generatedAt: string
  dshHome: string
  core: CoreAssessment
  profiles: ProfileAssessment[]
  summary: AssessmentSummary
}

export interface CompatibilityHost {
  dshVersion: string
  nodeVersion: string
  installedVersions: ReadonlyMap<string, string>
}
