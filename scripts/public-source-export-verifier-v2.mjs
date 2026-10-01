// SPDX-License-Identifier: AGPL-3.0-only
// Independent local W3 V2 verifier. It does not import the export producer or
// accept the producer's receipt as proof. Remote identity, rights, and release
// authority remain separate protected gates. This does not certify the export
// repository directory or its .git ancillary files as a distributable archive.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { assertCurrentRcSourceGitV1, assertCurrentRcSourceGitAfterInvocationV1, rcSourceGitInvocationV1 } from "../plugins/better-workflows/scripts/lib/git.mjs";
import { analyzePublicModuleClosureV1 } from "./public-source-module-closure-v1.mjs";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 4096;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const DERIVED_WORKFLOWS = Object.freeze({
  ".github/workflows/ci.yml": "scripts/public-ci/ci.yml",
  ".github/workflows/host-conformance.yml": "scripts/public-ci/host-conformance.yml",
  ".github/workflows/website-public-qa.yml": "scripts/public-ci/website-public-qa.yml"
});
const AUTO_TEMPLATE_PATH = "plugins/better-workflows/templates/auto.json";
const AUTO_SKILL_PATH = "plugins/better-workflows/skills/auto/SKILL.md";
// Independently enforce the fixed V5.0 Auto runtime and installation inputs.
// Presence does not prove complete filesystem/site closure, rights, or release.
const FIXED_AUTO_RUNTIME_SOURCE_PATHS = Object.freeze([
  ".agents/plugins/marketplace.json",
  "GEMINI.md",
  "QWEN.md",
  "gemini-extension.json",
  "qwen-extension.json",
  "plugins/better-workflows/.codex-plugin/plugin.json",
  "plugins/better-workflows/package.json",
  "plugins/better-workflows/scripts/sbw.mjs",
  "plugins/better-workflows/scripts/runtime-qualification-ci-v2.mjs",
  "plugins/better-workflows/scripts/runtime-qualification-gate-v2.mjs",
  "plugins/better-workflows/scripts/runtime-qualification-launch-v2.sh",
  // Native pre-shell consumer source and its source-only invocation contract.
  "plugins/better-workflows/native/macos/runtime-qualification-supervisor-v2.c",
  "plugins/better-workflows/native/macos/runtime-qualification-supervisor-invocation-v2.json",
  "plugins/better-workflows/scripts/lib/runtime-qualification-v2.mjs",
  "plugins/better-workflows/scripts/lib/runtime-qualification-verifier-v2.mjs",
  "plugins/better-workflows/scripts/lib/github-runtime-attestation-v2.mjs",
  "plugins/better-workflows/scripts/formal-candidate-coverage-v1.mjs",
  "plugins/better-workflows/scripts/lib/formal-candidate-coverage-v1.mjs",
  "plugins/better-workflows/config/formal-atomic-requirements-v1.json",
  // Worker/source URLs are filesystem dependencies, not ESM import edges.
  "plugins/better-workflows/scripts/lib/formal-supervisor.mjs",
  "plugins/better-workflows/scripts/lib/formal-coordinator.mjs",
  "plugins/better-workflows/scripts/formal-coordinator-worker.mjs",
  "plugins/better-workflows/scripts/formal-commit-worker.mjs",
  "plugins/better-workflows/scripts/formal-protected-observer-v2.mjs",
  "plugins/better-workflows/scripts/install-protected-formal-observer-v2.mjs",
  "plugins/better-workflows/scripts/native-review-read.mjs",
  "plugins/better-workflows/scripts/native-review-app-server.mjs",
  "plugins/better-workflows/config/defaults.json",
  "plugins/better-workflows/config/task-worktree-v1.json",
  "plugins/better-workflows/config/deliberation-roster.json",
  "plugins/better-workflows/config/evidence-contracts-v1.json",
  "plugins/better-workflows/config/host-support-v1.json",
  "plugins/better-workflows/config/entrypoint-catalog.json",
  "plugins/better-workflows/config/version-manifest-v1.json",
  "plugins/better-workflows/config/product-release-scope-v1.json",
  "plugins/better-workflows/config/product-release-channel-v1.json"
]);
const PUBLIC_TEMPLATE_PREFIX = "plugins/better-workflows/templates/";
const PUBLIC_SKILL_PREFIX = "plugins/better-workflows/skills/";
const PRIVATE_PLAN_PREFIX = "docs/plans/";
const PRIVATE_SOURCE_PREFIXES = [
  "audit/", "evidence/", "output/", "deploy/", "docs/checkpoints/"
];
const PRIVATE_RECIPE_PREFIX = "plugins/better-workflows/fixtures/recipes/";
const PRIVATE_RECIPE_PATHS = new Set([
  "plugins/better-workflows/scripts/lib/recipe-artifact-publisher.mjs",
  "plugins/better-workflows/scripts/lib/recipe-runtime.mjs",
  "plugins/better-workflows/scripts/lib/recipes.mjs",
  "plugins/better-workflows/scripts/tests/recipes.test.mjs"
]);
const PRIVATE_TEMPLATE_PREFIXES = [
  "plugins/better-workflows/config/self-improve-",
  "plugins/better-workflows/fixtures/self-improve-ops-",
  "plugins/better-workflows/scripts/lib/self-improve-"
];
const PRIVATE_TEMPLATE_TOOL_PATHS = new Set([
  "scripts/plugin-cache.mjs",
  "plugins/better-workflows/config/autonomy/bounded-autopilot-v1.json",
  "plugins/better-workflows/config/autonomy/bounded-autopilot-v1.schema.json",
  "plugins/better-workflows/scripts/lib/autonomy.mjs",
  "plugins/better-workflows/scripts/lib/autonomy-snapshot.mjs",
  "plugins/better-workflows/scripts/lib/autonomy-preflight.mjs",
  "plugins/better-workflows/scripts/lib/self-improve.mjs"
]);
const PUBLIC_TEST_PREFIX = "plugins/better-workflows/scripts/tests/";
const PUBLIC_AUTO_TESTS = new Set([
  "auto-policy-v1", "canary-ledger-v1", "canary-start-boundary-v1",
  "execution-admission-v1", "execution-runtime-v1",
  "execution-runtime-recovery-v1", "execution-runtime-stop-race",
  "formal-cli-options", "formal-commit", "formal-coordinator",
  "formal-evaluator-receipt", "formal-operation", "formal-protected-admission-v1",
  "formal-suite-runner", "formal-supervisor",
  "incident-cli-sbw", "native-v3-command-runner", "native-v3-plan-runner",
  "native-v3-plan-runner-recovery", "native-v3-production-recovery",
  "native-review-sharded-v2", "platform-receipts-v1", "posix-owned-process-adapter",
  "runtime-support", "skills", "verification-incremental-v1", "workspace",
  "codex-install-smoke-v1", "hosts", "routing", "providers", "public-host-safety-v1",
  "formal-protected-observer-v2", "runtime-qualification-v1", "runtime-qualification-v2",
  "rc-publication-git-v1", "rc-publication-publisher-v1", "rc-publication-qualification-v1", "native-review-full-snapshot",
  "w5-publication-journal-v1", "w5-publication-operation-v1"
].map((name) => `${PUBLIC_TEST_PREFIX}${name}.test.mjs`));

function reject(message) {
  throw new Error(`public source export verification: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function blobOid(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function sameKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function safePath(value) {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") &&
    Buffer.byteLength(value, "utf8") <= 4096 && !/[\\<>:"|?*\u0000-\u001f\u007f]/u.test(value) &&
    value.normalize("NFC") === value &&
    value.split("/").every((part) => part && part !== "." && part !== ".." &&
      !/^\.git$/i.test(part) && !/[. ]$/u.test(part) && Buffer.byteLength(part, "utf8") <= 255 &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

function parseManifest(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    reject("manifest bytes are missing or oversized");
  }
  const raw = Buffer.from(bytes);
  let manifest;
  try {
    const source = UTF8.decode(raw);
    manifest = JSON.parse(source);
    if (`${JSON.stringify(manifest)}\n` !== source) reject("manifest is not canonical JSON");
  } catch {
    reject("manifest cannot be parsed as canonical UTF-8 JSON");
  }
  if (!sameKeys(manifest, ["schemaVersion", "kind", "privateSourceSha", "privateSourceTreeOid", "productReleaseScopeDigest", "approvalArtifact", "commit", "entries", "derivedOutputs"]) ||
      manifest.schemaVersion !== 2 || manifest.kind !== "PublicSourceProjectionV2" ||
      typeof manifest.privateSourceSha !== "string" || !SHA1.test(manifest.privateSourceSha) ||
      typeof manifest.privateSourceTreeOid !== "string" || !SHA1.test(manifest.privateSourceTreeOid) ||
      typeof manifest.productReleaseScopeDigest !== "string" || !SHA256.test(manifest.productReleaseScopeDigest) ||
      !sameKeys(manifest.approvalArtifact, ["kind", "sha256"]) ||
      manifest.approvalArtifact.kind !== "W3SourceProjectionApprovalV1" ||
      typeof manifest.approvalArtifact.sha256 !== "string" || !SHA256.test(manifest.approvalArtifact.sha256) ||
      !sameKeys(manifest.commit, ["name", "email", "epochSeconds", "message"]) ||
      typeof manifest.commit.name !== "string" || !manifest.commit.name || manifest.commit.name.length > 100 ||
      /[\r\n<>\u0000-\u001f\u007f]/u.test(manifest.commit.name) ||
      typeof manifest.commit.email !== "string" ||
      !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(manifest.commit.email) ||
      /[\u0000-\u001f\u007f]/u.test(manifest.commit.email) || manifest.commit.email.length > 200 ||
      !Number.isSafeInteger(manifest.commit.epochSeconds) || manifest.commit.epochSeconds < 0 ||
      typeof manifest.commit.message !== "string" || !manifest.commit.message ||
      manifest.commit.message.length > 500 || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(manifest.commit.message) ||
      !Array.isArray(manifest.entries) || !manifest.entries.length || manifest.entries.length > MAX_FILES) {
    reject("manifest schema or identity is invalid");
  }
  let previous = null;
  const folded = new Set();
  for (const entry of manifest.entries) {
    const expected = entry?.decision === "exclude"
      ? ["path", "mode", "type", "objectId", "size", "sha256", "decision", "reason"]
      : ["path", "mode", "type", "objectId", "size", "sha256", "decision"];
    if (!sameKeys(entry, expected) || !safePath(entry.path) || !["100644", "100755"].includes(entry.mode) ||
        entry.type !== "blob" || typeof entry.objectId !== "string" || !SHA1.test(entry.objectId) ||
        typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES ||
        !["include", "exclude"].includes(entry.decision) ||
        (entry.decision === "exclude" && (typeof entry.reason !== "string" ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.reason) || entry.reason.length > 80))) {
      reject("manifest contains an invalid entry");
    }
    const encoded = Buffer.from(entry.path);
    if (previous && Buffer.compare(previous, encoded) >= 0) reject("manifest paths are not unique and byte sorted");
    previous = encoded;
    const key = entry.path.toLocaleLowerCase("en-US");
    if (folded.has(key)) reject("manifest has a case-folded collision");
    folded.add(key);
  }
  const includedPaths = new Set(manifest.entries
    .filter((entry) => entry.decision === "include")
    .map((entry) => entry.path));
  if (!includedPaths.has(AUTO_TEMPLATE_PATH) || !includedPaths.has(AUTO_SKILL_PATH)) {
    reject("the public projection must include the Auto template and skill");
  }
  for (const file of FIXED_AUTO_RUNTIME_SOURCE_PATHS) {
    if (!includedPaths.has(file)) {
      reject(`the public projection is missing a fixed Auto runtime source: ${file}`);
    }
  }
  for (const file of includedPaths) {
    const foldedPath = file.toLocaleLowerCase("en-US");
    if (foldedPath.startsWith(PRIVATE_PLAN_PREFIX)) {
      reject("the public projection contains private planning documents");
    }
    if (PRIVATE_SOURCE_PREFIXES.some((prefix) => foldedPath.startsWith(prefix))) {
      reject("the public projection contains private source directories");
    }
    if ((foldedPath.startsWith(PUBLIC_TEMPLATE_PREFIX) && file !== AUTO_TEMPLATE_PATH) ||
        (foldedPath.startsWith(PUBLIC_SKILL_PREFIX) && file !== AUTO_SKILL_PATH)) {
      reject("the public projection may include only the Auto template and skill");
    }
    if (foldedPath.startsWith(PRIVATE_RECIPE_PREFIX) || PRIVATE_RECIPE_PATHS.has(foldedPath)) {
      reject("the public Auto projection contains private recipe source");
    }
    if (PRIVATE_TEMPLATE_TOOL_PATHS.has(foldedPath) ||
        PRIVATE_TEMPLATE_PREFIXES.some((prefix) => foldedPath.startsWith(prefix))) {
      reject("the public Auto projection contains private template tooling");
    }
    if (foldedPath.startsWith(PUBLIC_TEST_PREFIX) && foldedPath.endsWith(".test.mjs") &&
        !PUBLIC_AUTO_TESTS.has(foldedPath)) {
      reject("the public Auto projection contains a test outside the public suite catalog");
    }
  }
  if (manifest.entries.some((entry) => entry.decision === "include" &&
      entry.path.toLocaleLowerCase("en-US").startsWith(".github/workflows/"))) {
    reject("the public projection contains a non-derived workflow");
  }
  if (!Array.isArray(manifest.derivedOutputs) ||
      manifest.derivedOutputs.length !== Object.keys(DERIVED_WORKFLOWS).length ||
      Object.keys(DERIVED_WORKFLOWS).some((requiredPath) =>
        !manifest.derivedOutputs.some((output) => output?.path === requiredPath))) {
    reject("the V5.0 public projection requires the exact Auto CI, host conformance and website QA workflows");
  }
  let previousOutput = null;
  for (const derived of manifest.derivedOutputs) {
    if (!sameKeys(derived, ["path", "mode", "type", "objectId", "size", "sha256", "sourcePath"]) ||
        !Object.hasOwn(DERIVED_WORKFLOWS, derived.path) ||
        derived.sourcePath !== DERIVED_WORKFLOWS[derived.path] ||
        derived.mode !== "100644" || derived.type !== "blob" ||
        typeof derived.objectId !== "string" || !SHA1.test(derived.objectId) ||
        typeof derived.sha256 !== "string" || !SHA256.test(derived.sha256) ||
        !Number.isSafeInteger(derived.size) || derived.size < 0 || derived.size > MAX_FILE_BYTES ||
        (previousOutput && Buffer.compare(Buffer.from(previousOutput.path), Buffer.from(derived.path)) >= 0)) {
      reject("derived public workflow output is invalid or unsorted");
    }
    const original = manifest.entries.find((entry) => entry.path === derived.path);
    const source = manifest.entries.find((entry) => entry.path === derived.sourcePath);
    if (!original || original.decision !== "exclude" || !source || source.decision !== "exclude" ||
        source.mode !== "100644" || source.objectId !== derived.objectId ||
        source.size !== derived.size || source.sha256 !== derived.sha256) {
      reject("derived workflow is not bound to an excluded tracked source and private workflow");
    }
    previousOutput = derived;
  }
  assertOutputPaths([
    ...manifest.entries.filter((entry) => entry.decision === "include").map((entry) => entry.path),
    ...manifest.derivedOutputs.map((entry) => entry.path)
  ]);
  return { manifest, manifestDigest: sha256(raw) };
}

function assertOutputPaths(paths) {
  const nodes = new Map();
  for (const outputPath of paths) {
    const parts = outputPath.split("/");
    if (parts.length > 32) reject("projection path depth exceeds bound");
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const exactPath = parts.slice(0, depth).join("/");
      const folded = exactPath.toLocaleLowerCase("en-US");
      const kind = depth === parts.length ? "file" : "directory";
      const prior = nodes.get(folded);
      if (prior && (prior.path !== exactPath || prior.kind !== kind)) {
        reject("projection has a case-folded or file/directory path collision");
      }
      nodes.set(folded, { path: exactPath, kind });
    }
  }
}

async function git(cwd, args, maxBuffer = 2 * 1024 * 1024) {
  const rcScope = await assertCurrentRcSourceGitV1();
  const invocation = rcScope ? rcSourceGitInvocationV1() : null;
  let result;
  try { result = spawnSync(invocation?.executable ?? "git", invocation ? ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", ...args] : args, {
    cwd, encoding: "buffer", maxBuffer, timeout: 30_000,
    env: invocation?.environment ?? {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/",
      LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0"
    }
  }); } finally { if (rcScope) await assertCurrentRcSourceGitAfterInvocationV1(); }
  if (result.error || result.status !== 0) reject(`Git ${args[0]} failed`);
  return result.stdout;
}

function splitZero(bytes) {
  const chunks = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) {
      if (index !== start) chunks.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== bytes.length) reject("Git tree output is not NUL terminated");
  return chunks;
}

function readTree(bytes) {
  const records = [];
  let total = 0;
  for (const chunk of splitZero(bytes)) {
    const tab = chunk.indexOf(9);
    if (tab < 0) reject("Git tree entry is malformed");
    let metadata;
    let file;
    try {
      metadata = UTF8.decode(chunk.subarray(0, tab)).trim().split(/\s+/);
      file = UTF8.decode(chunk.subarray(tab + 1));
    } catch {
      reject("Git tree entry is not valid UTF-8");
    }
    if (metadata.length !== 4 || !safePath(file) || !["100644", "100755"].includes(metadata[0]) ||
        metadata[1] !== "blob" || !SHA1.test(metadata[2]) || !/^\d+$/.test(metadata[3])) {
      reject("Git tree contains an unsafe or unsupported entry");
    }
    const size = Number(metadata[3]);
    if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) reject("Git tree entry is oversized");
    total += size;
    if (total > MAX_SOURCE_BYTES) reject("Git tree exceeds the byte bound");
    records.push({ path: file, mode: metadata[0], type: metadata[1], objectId: metadata[2], size });
  }
  if (!records.length || records.length > MAX_FILES) reject("Git tree entry count is invalid");
  records.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  for (let index = 1; index < records.length; index += 1) {
    if (records[index - 1].path === records[index].path) reject("Git tree has duplicate paths");
  }
  return records;
}

async function absent(file, label) {
  try {
    await lstat(file);
    reject(`${label} is present`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function matchingRecords(expected, observed, label) {
  if (expected.length !== observed.length) reject(`${label} path count differs`);
  for (let index = 0; index < expected.length; index += 1) {
    for (const key of ["path", "mode", "type", "objectId", "size"]) {
      if (expected[index][key] !== observed[index][key]) reject(`${label} differs at ${observed[index].path}`);
    }
  }
}

// Reconstruct the exact canonical Git tree bytes from the manifest. Recursive
// ls-tree leaf enumeration alone cannot reveal an extra reachable empty tree.
function projectedTreeOid(entries) {
  const root = { files: new Map(), directories: new Map() };
  let directories = 1;
  for (const entry of entries) {
    const parts = entry.path.split("/");
    if (parts.length > 32) reject("projection path depth exceeds bound");
    let current = root;
    for (const part of parts.slice(0, -1)) {
      if (current.files.has(part)) reject("projection has a file/directory conflict");
      if (!current.directories.has(part)) {
        if (++directories > 8192) reject("projection has too many directories");
        current.directories.set(part, { files: new Map(), directories: new Map() });
      }
      current = current.directories.get(part);
    }
    const basename = parts.at(-1);
    if (current.directories.has(basename) || current.files.has(basename)) {
      reject("projection has a duplicate or file/directory conflict");
    }
    current.files.set(basename, entry);
  }
  function treeOid(node) {
    const items = [];
    for (const [name, entry] of node.files) {
      items.push({ name, mode: entry.mode, oid: entry.objectId, isTree: false });
    }
    for (const [name, child] of node.directories) {
      items.push({ name, mode: "40000", oid: treeOid(child), isTree: true });
    }
    items.sort((a, b) => Buffer.compare(
      Buffer.from(`${a.name}${a.isTree ? "/" : "\0"}`, "utf8"),
      Buffer.from(`${b.name}${b.isTree ? "/" : "\0"}`, "utf8")
    ));
    const chunks = [];
    for (const item of items) {
      chunks.push(Buffer.from(`${item.mode} ${item.name}\0`, "utf8"));
      chunks.push(Buffer.from(item.oid, "hex"));
    }
    const body = Buffer.concat(chunks);
    return createHash("sha1").update(`tree ${body.length}\0`).update(body).digest("hex");
  }
  return treeOid(root);
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Independent source/object/history verification. No producer receipt input. */
export async function verifyPublicSourceExportV2({ sourceRepository, manifestBytes, outputDirectory } = {}) {
  const { manifest, manifestDigest } = parseManifest(manifestBytes);
  if (typeof sourceRepository !== "string" || !path.isAbsolute(sourceRepository) ||
      typeof outputDirectory !== "string" || !path.isAbsolute(outputDirectory)) {
    reject("sourceRepository and outputDirectory must be absolute paths");
  }
  const sourceRoot = await realpath(sourceRepository);
  const outputRoot = await realpath(outputDirectory);
  if (sourceRoot !== await realpath((await git(sourceRoot, ["rev-parse", "--show-toplevel"])).toString().trim())) {
    reject("sourceRepository must be the exact private checkout root");
  }
  if (outputRoot !== await realpath((await git(outputRoot, ["rev-parse", "--show-toplevel"])).toString().trim())) {
    reject("outputDirectory must be the exact public checkout root");
  }
  const sourceGitCommon = await realpath((await git(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toString().trim());
  if (isWithin(sourceRoot, outputRoot) || isWithin(sourceGitCommon, outputRoot)) {
    reject("public output is inside private source or Git storage");
  }
  const gitDir = path.join(outputRoot, ".git");
  const gitInfo = await lstat(gitDir);
  if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink()) reject("public output must own a real .git directory");
  for (const [file, label] of [
    [path.join(gitDir, "objects", "info", "alternates"), "object alternate"],
    [path.join(gitDir, "commondir"), "linked Git common directory"],
    [path.join(gitDir, "info", "grafts"), "grafts"],
    [path.join(gitDir, "shallow"), "shallow history"]
  ]) await absent(file, label);
  if ((await git(sourceRoot, ["rev-parse", "--show-object-format"])).toString().trim() !== "sha1" ||
      (await git(outputRoot, ["rev-parse", "--show-object-format"])).toString().trim() !== "sha1") {
    reject("both repositories must use SHA-1 Git objects");
  }
  const privateSha = manifest.privateSourceSha;
  if ((await git(sourceRoot, ["rev-parse", "--verify", `${privateSha}^{commit}`])).toString().trim() !== privateSha ||
      (await git(sourceRoot, ["rev-parse", `${privateSha}^{tree}`])).toString().trim() !== manifest.privateSourceTreeOid) {
    reject("private source commit or tree differs from manifest");
  }
  const sourceRecords = readTree((await git(sourceRoot, ["ls-tree", "-r", "-z", "-l", "--full-tree", privateSha], 4 * 1024 * 1024)));
  matchingRecords(manifest.entries, sourceRecords, "private source");
  if (projectedTreeOid(manifest.entries) !== manifest.privateSourceTreeOid) {
    reject("private source tree has unmanifested structure");
  }
  const includedSource = manifest.entries.filter((entry) => entry.decision === "include");
  if (!includedSource.length) reject("projection has no included source files");
  const expectedPublic = [...includedSource, ...manifest.derivedOutputs].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  assertOutputPaths(expectedPublic.map((entry) => entry.path));
  if (expectedPublic.some((entry) => entry.path === ".gitattributes" || entry.path.endsWith("/.gitattributes"))) {
    reject("included .gitattributes is unsupported");
  }
  const sha = (await git(outputRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).toString().trim();
  if (!SHA1.test(sha)) reject("public commit SHA is invalid");
  const refs = (await git(outputRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)"])).toString("utf8").trim().split("\n");
  if (refs.length !== 1 || refs[0] !== `refs/heads/main\0${sha}` ||
      (await git(outputRoot, ["symbolic-ref", "HEAD"])).toString().trim() !== "refs/heads/main" ||
      (await git(outputRoot, ["remote"])).toString().trim() !== "") {
    reject("public repository has unexpected refs, HEAD, or remotes");
  }
  const lineage = (await git(outputRoot, ["rev-list", "--parents", "-n", "1", sha])).toString().trim().split(" ");
  if (lineage.length !== 1 || lineage[0] !== sha) reject("public candidate is not a parentless commit");
  const publicTreeOid = (await git(outputRoot, ["rev-parse", `${sha}^{tree}`])).toString().trim();
  if (!SHA1.test(publicTreeOid)) reject("public tree OID is invalid");
  if (projectedTreeOid(expectedPublic) !== publicTreeOid) {
    reject("public tree OID differs from the exact projection");
  }
  const { name, email, epochSeconds, message } = manifest.commit;
  const expectedCommit = Buffer.from(
    `tree ${publicTreeOid}\nauthor ${name} <${email}> ${epochSeconds} +0000\n` +
    `committer ${name} <${email}> ${epochSeconds} +0000\n\n${message}\n`, "utf8"
  );
  const actualCommit = (await git(outputRoot, ["cat-file", "commit", sha]));
  if (!actualCommit.equals(expectedCommit)) reject("public commit metadata differs from manifest");
  const publicRecords = readTree((await git(outputRoot, ["ls-tree", "-r", "-z", "-l", "--full-tree", sha], 4 * 1024 * 1024)));
  matchingRecords(expectedPublic, publicRecords, "public tree");
  const publicFiles = [];
  const moduleClosureEntries = [];
  for (const entry of manifest.entries) {
    const sourceBytes = (await git(sourceRoot, ["cat-file", "blob", entry.objectId], MAX_FILE_BYTES + 1024));
    if (sourceBytes.length !== entry.size || blobOid(sourceBytes) !== entry.objectId || sha256(sourceBytes) !== entry.sha256) {
      reject(`private source bytes differ: ${entry.path}`);
    }
    moduleClosureEntries.push({ path: entry.path, decision: entry.decision, bytes: sourceBytes });
    if (entry.decision === "include") {
      const publicBytes = (await git(outputRoot, ["cat-file", "blob", entry.objectId], MAX_FILE_BYTES + 1024));
      if (!sourceBytes.equals(publicBytes)) reject(`public bytes differ: ${entry.path}`);
      publicFiles.push({ path: entry.path, mode: entry.mode, objectId: entry.objectId, size: entry.size, sha256: entry.sha256 });
    }
  }
  for (const derived of manifest.derivedOutputs) {
    const derivedBytes = (await git(sourceRoot, ["cat-file", "blob", derived.objectId], MAX_FILE_BYTES + 1024));
    const publicDerivedBytes = (await git(outputRoot, ["cat-file", "blob", derived.objectId], MAX_FILE_BYTES + 1024));
    if (derivedBytes.length !== derived.size || blobOid(derivedBytes) !== derived.objectId ||
        sha256(derivedBytes) !== derived.sha256 || !derivedBytes.equals(publicDerivedBytes)) {
      reject(`derived public workflow bytes differ from the manifest-bound source identity: ${derived.path}`);
    }
    publicFiles.push({ path: derived.path, mode: derived.mode, objectId: derived.objectId, size: derived.size, sha256: derived.sha256 });
  }
  const moduleClosure = analyzePublicModuleClosureV1({
    sourceSha: privateSha,
    sourceTreeOid: manifest.privateSourceTreeOid,
    entries: moduleClosureEntries,
    derivedOutputs: manifest.derivedOutputs.map(({ path: outputPath, sourcePath }) => ({ path: outputPath, sourcePath }))
  });
  if (moduleClosure.status !== "NO_RECORDED_GAPS_IN_SUPPLIED_SET") {
    reject(`public source has recorded module closure gaps: ${moduleClosure.unresolved.length} unresolved requests, ${moduleClosure.excludedReachability.length} excluded dependencies`);
  }
  publicFiles.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  // An explicit root prevents the index from making unrelated objects look
  // reachable; the only accepted public history root is this checked commit.
  const fsck = (await git(outputRoot, ["fsck", "--full", "--strict", "--unreachable", "--no-reflogs", sha], 2 * 1024 * 1024));
  if (fsck.length !== 0) reject("public object database contains unreachable or invalid objects");
  const publicFilesSha256 = sha256(Buffer.from(JSON.stringify(publicFiles)));
  const derivedOutputsSha256 = sha256(Buffer.from(JSON.stringify(manifest.derivedOutputs)));
  const exportDigest = sha256(Buffer.from(JSON.stringify({
    privateSourceSha: privateSha,
    privateSourceTreeOid: manifest.privateSourceTreeOid,
    productReleaseScopeDigest: manifest.productReleaseScopeDigest,
    approvalArtifactSha256: manifest.approvalArtifact.sha256,
    exportManifestDigest: manifestDigest,
    publicTreeOid,
    publicCandidateSha: sha,
    publicFilesSha256,
    derivedOutputsSha256,
    moduleClosureReceiptDigest: moduleClosure.receiptDigest
  })));
  return {
    schemaVersion: 2,
    kind: "W3SourceExportVerificationV2",
    authority: "none",
    verifiedSurface: "local-git-ref-object-graph-only",
    privateSourceSha: privateSha,
    privateSourceTreeOid: manifest.privateSourceTreeOid,
    productReleaseScopeDigest: manifest.productReleaseScopeDigest,
    approvalArtifactSha256: manifest.approvalArtifact.sha256,
    exportManifestDigest: manifestDigest,
    publicTreeOid,
    publicCandidateSha: sha,
    publicFilesSha256,
    derivedOutputsSha256,
    moduleClosureReceiptDigest: moduleClosure.receiptDigest,
    exportDigest,
    includedCount: includedSource.length,
    excludedCount: manifest.entries.length - includedSource.length,
    derivedCount: manifest.derivedOutputs.length
  };
}
