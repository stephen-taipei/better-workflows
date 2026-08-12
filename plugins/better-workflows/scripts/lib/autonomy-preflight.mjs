import { execBoundGitHubCli, execBoundProcess } from "./core.mjs";
import { runSourceGit } from "./git.mjs";
import {
  canonicalGovernedGithubRepository,
  captureBoundedAutonomySnapshot,
  currentAutonomyBranchFromGit,
  inspectAutonomyChanges,
  resolveGovernedGithubRepository
} from "./autonomy-snapshot.mjs";

const CONTROLLED_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export { canonicalGovernedGithubRepository as canonicalGithubRepository };

function sourceRunner(cwd, runGit = null) {
  return runGit ?? ((args, options = {}) => runSourceGit(cwd, args, options));
}

export async function resolveAutonomyRepository(cwd, { runGit = null, ...options } = {}) {
  return (await resolveGovernedGithubRepository(sourceRunner(cwd, runGit), {
    maxBuffer: DEFAULT_MAX_BUFFER,
    ...options
  })).repository;
}

export async function currentAutonomyBranch(cwd, options = {}) {
  const { runGit = null, ...gitOptions } = options;
  return currentAutonomyBranchFromGit(sourceRunner(cwd, runGit), {
    maxBuffer: DEFAULT_MAX_BUFFER,
    ...gitOptions
  });
}

export async function captureAutonomyBindingContext(cwd, pathScope) {
  const branch = await currentAutonomyBranch(cwd);
  if (!branch) throw new Error("bounded-autopilot-v1 requires a named codex/* branch");
  const repository = await resolveAutonomyRepository(cwd);
  return { repository, branch, pathScope };
}

export async function inspectAutonomyWorktree(cwd, { limits, pathScope }) {
  return inspectAutonomyChanges(cwd, {
    limits,
    pathScope,
    runGit: sourceRunner(cwd)
  });
}

export async function captureAutonomyReadinessSnapshotFromSource(cwd, binding, sourceBindingDigest, {
  runGit = null,
  sentinelDigest = null,
  beforeFinalCheck = null
} = {}) {
  return captureBoundedAutonomySnapshot(
    cwd,
    binding,
    sourceBindingDigest,
    sourceRunner(cwd, runGit),
    { sentinelDigest, beforeFinalCheck }
  );
}

export async function readBoundHostStatus(hostTrustTool, cwd, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const result = await execBoundProcess(process.execPath, [hostTrustTool, "status"], {
    cwd,
    env: { PATH: CONTROLLED_PATH, HOME: "/var/empty", LANG: "C", LC_ALL: "C" },
    timeoutMs,
    maxBuffer: DEFAULT_MAX_BUFFER,
    encoding: "utf8",
    label: "Bound host status"
  });
  return JSON.parse(result.stdout);
}

export async function probeAutonomyGithubCredential(cwd, executablePath, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return execBoundGitHubCli(executablePath, ["auth", "status", "--hostname", "github.com"], {
    cwd,
    env: {},
    timeoutMs,
    maxBuffer: DEFAULT_MAX_BUFFER,
    encoding: "utf8"
  });
}

export async function runAutonomyGitCommandForTest(cwd, args, options = {}) {
  return runSourceGit(cwd, args, options);
}
