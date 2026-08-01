import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertMutableRun, atomicWriteJson, digestObject, loadRun, nowIso, readJson, safeJoin, sha256, withRunLock } from "./core.mjs";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;

async function changedPaths(cwd, base, head) {
  const { stdout } = await execFileAsync("git", ["diff", "--name-only", `${base}..${head}`], { cwd });
  return stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).sort();
}

function inScope(file, scope) {
  return scope.some((prefix) => prefix === "." || file === prefix || file.startsWith(`${prefix.replace(/\/$/, "")}/`));
}

function normalizeScope(scope) {
  const normalized = [...new Set(scope.map((item) => String(item).replaceAll("\\", "/")))].sort();
  if (normalized.length === 0 || normalized.some((item) => !item || item.startsWith("/") || item === ".." || item.startsWith("../") || item === ".")) {
    throw new Error("Refinement scope must contain bounded recently-modified relative paths");
  }
  return normalized;
}

export async function recordRefinement(root, runId, input) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Refinement");
  if (
    run.contract.schemaVersion !== 2 ||
    run.contract.controlPlane?.refinementPolicy !== "pilot-v1" ||
    !["monorepo-refactor", "self-improve-ops"].includes(run.manifest.template)
  ) {
    throw new Error("Refinement pilot is only enabled for monorepo-refactor and self-improve-ops runs");
  }
  if (!input || input.schemaVersion !== 1) throw new Error("Refinement receipt must use schemaVersion 1");
  if (!SHA.test(input.base) || !SHA.test(input.functionalHead)) throw new Error("Refinement BASE and functional HEAD must be 40-character revisions");
  if (run.manifest.baselineRevision && input.base !== run.manifest.baselineRevision) {
    throw new Error("Refinement BASE must match the run baseline revision");
  }
  if (!Array.isArray(input.scope) || input.scope.length === 0) throw new Error("Refinement scope is required");
  const scope = normalizeScope(input.scope);
  if (!Array.isArray(input.behaviorTests) || input.behaviorTests.length === 0) throw new Error("Refinement requires behavior tests");
  if (!input.scopedDiff || typeof input.scopedDiff !== "object" || Array.isArray(input.scopedDiff)) throw new Error("Refinement scoped diff is required");
  if (!input.review || input.review.verdict !== "PASS" || input.review.independent !== true) throw new Error("Refinement requires an independent PASS review");
  await execFileAsync("git", ["merge-base", "--is-ancestor", input.base, input.functionalHead], { cwd: run.manifest.cwd });
  const paths = await changedPaths(run.manifest.cwd, input.base, input.functionalHead);
  if (paths.length === 0) throw new Error("Refinement requires a non-empty functional diff");
  if (paths.some((file) => !inScope(file, scope))) throw new Error("Refinement diff escapes the recently-modified scope");
  if (scope.some((prefix) => !paths.some((file) => inScope(file, [prefix])))) {
    throw new Error("Refinement scope contains paths outside the recently-modified diff");
  }
  const tests = input.behaviorTests.map((item) => ({
    id: String(item.id ?? ""),
    command: String(item.command ?? ""),
    status: String(item.status ?? "")
  }));
  if (tests.some((item) => !item.id || !item.command || item.status !== "passed")) throw new Error("All refinement behavior tests must pass");
  const receipt = {
    schemaVersion: 1,
    id: `refinement-${sha256(digestObject({ runId, base: input.base, functionalHead: input.functionalHead, scope: input.scope, paths, tests }))}`,
    runId,
    base: input.base,
    functionalHead: input.functionalHead,
    scope,
    paths,
    behaviorTests: tests,
    scopedDiff: input.scopedDiff,
    review: { verdict: "PASS", independent: true, digest: digestObject(input.review) },
    producedAt: nowIso(),
    status: "accepted",
    digest: digestObject({ runId, base: input.base, functionalHead: input.functionalHead, scope: input.scope, paths, tests, scopedDiff: input.scopedDiff })
  };
    await atomicWriteJson(root, safeJoin(runDir, "refinements", `${receipt.id}.json`), receipt);
    return receipt;
  });
}

export async function refinementStatus(root, runId) {
  const run = await loadRun(root, runId);
  const directory = safeJoin(run.runDir, "refinements");
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = (await readdir(directory)).filter((item) => item.endsWith(".json")).sort();
    const receipts = await Promise.all(entries.map((item) => readJson(root, safeJoin(directory, item))));
    return {
      enabled: run.contract.controlPlane?.refinementPolicy === "pilot-v1",
      receipts: receipts.map((item) => ({ id: item.id, status: item.status, digest: item.digest, base: item.base, functionalHead: item.functionalHead, paths: item.paths }))
    };
  } catch (error) {
    if (error.code === "ENOENT") return { enabled: run.contract.controlPlane?.refinementPolicy === "pilot-v1", receipts: [] };
    throw error;
  }
}
