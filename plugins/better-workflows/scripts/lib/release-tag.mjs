const SHA_PATTERN = /^[0-9a-f]{40}$/;
const STABLE_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const RELEASE_BRANCHES = new Set(["dev", "main"]);

export function normalizeStableVersion(value) {
  const version = String(value ?? "").trim();
  if (!STABLE_VERSION_PATTERN.test(version)) {
    throw new Error(`Release version must be stable semver MAJOR.MINOR.PATCH: ${version || "<empty>"}`);
  }
  return version;
}

export function assertCommitSha(value) {
  const sha = String(value ?? "").trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw new Error(`Release commit must be a 40-character SHA: ${sha || "<empty>"}`);
  return sha;
}

export function releaseTagName({ branch, version, sha }) {
  if (!RELEASE_BRANCHES.has(branch)) {
    throw new Error(`Release tags are only eligible on dev or main: ${branch || "<empty>"}`);
  }
  const stableVersion = normalizeStableVersion(version);
  const commit = assertCommitSha(sha);
  return branch === "main" ? `v${stableVersion}` : `v${stableVersion}-dev.${commit.slice(0, 12)}`;
}

export function versionSurfaces(packageJson, pluginManifest) {
  const packageVersion = normalizeStableVersion(packageJson?.version);
  const manifestVersion = String(pluginManifest?.version ?? "").split("+", 1)[0];
  if (normalizeStableVersion(manifestVersion) !== packageVersion) {
    throw new Error(`Package and plugin manifest versions do not match: ${packageVersion} vs ${manifestVersion || "<empty>"}`);
  }
  return packageVersion;
}

export function versionChanged(currentVersion, previousVersion) {
  const current = normalizeStableVersion(currentVersion);
  if (previousVersion === null || previousVersion === undefined || String(previousVersion).trim() === "") return true;
  return current !== normalizeStableVersion(previousVersion);
}

export function findMergedPullRequest(pulls, { branch, sha }) {
  const commit = assertCommitSha(sha);
  const matches = (Array.isArray(pulls) ? pulls : []).filter((pull) => (
    pull?.base?.ref === branch &&
    pull?.merged_at &&
    String(pull.merge_commit_sha ?? "").toLowerCase() === commit
  ));
  if (matches.length > 1) throw new Error(`Multiple merged pull requests match ${branch}@${commit}`);
  return matches[0] ?? null;
}

export function parseRemoteTagCommit(output) {
  let direct = null;
  let peeled = null;
  for (const line of String(output ?? "").split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2 || !SHA_PATTERN.test(fields[0])) continue;
    if (fields[1].endsWith("^{}")) peeled = fields[0];
    else if (fields[1].startsWith("refs/tags/")) direct = fields[0];
  }
  return peeled ?? direct;
}

export function remoteTagMatches(output, sha) {
  const commit = assertCommitSha(sha);
  const target = parseRemoteTagCommit(output);
  return target === commit;
}

export function isReleaseBranch(branch) {
  return RELEASE_BRANCHES.has(branch);
}
