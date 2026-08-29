import { gt, prerelease, rcompare, valid } from 'semver'

export function newerCandidateVersions(
  versions: readonly string[],
  current: string,
  includePreview: boolean,
): string[] {
  if (valid(current) === null) return []
  return versions
    .filter(version => valid(version) !== null)
    .filter(version => includePreview || prerelease(version) === null)
    .filter(version => gt(version, current))
    .sort(rcompare)
}
