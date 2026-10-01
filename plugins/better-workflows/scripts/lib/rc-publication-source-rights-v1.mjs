// SPDX-License-Identifier: AGPL-3.0-only
// Actual full-public-universe license/rights and Corresponding Source consumer.
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { digestObject, sha256 } from "./core.mjs";
import { runSourceGit } from "./git.mjs";
import { deriveReleaseProductSubject, revalidateReleaseProductSubject } from "./release-license-subject-v1.mjs";
import { verifyReleaseLicenseGate } from "./release-license-gate-v1.mjs";
import { inspectRightsClearanceEnvelopeV1 } from "./rights-clearance-v1.mjs";
import { readBoundedRuntimeFileV2 } from "./runtime-qualification-v2.mjs";
import { assertInstalledRcPublicationContextV1, assertInstalledRcPublicationContextCurrentV1,
  revalidateInstalledRcProjectionV1, readInstalledRcLicenseCarrierV1, readInstalledRcRightsInputsV1,
  rcPublicationGithubReadV1, rcPublicationGithubAllRefsV1, rcPublicationHoldV1 } from "./rc-publication-installed-context-v1.mjs";

const hold = rcPublicationHoldV1;
const verifiedRights = new WeakMap();
const observedSources = new WeakMap();
const MAX_ARCHIVE = 32 * 1024 * 1024, MAX_SOURCE = 64 * 1024 * 1024;
const SHA40 = /^[a-f0-9]{40}$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });
function result(ctx, phase, evidence, brand, privateData) {
  const value = Object.freeze({ authenticatedState: "VERIFIED_CURRENT", operationId: ctx.operationId, bindingDigest: ctx.bindingDigest,
    publicCandidateSha: ctx.candidate.publicCandidateSha, publicTreeOid: ctx.candidate.publicTreeOid, phase,
    evidenceDigest: digestObject(evidence), evidence: Object.freeze(evidence) });
  brand.set(value, { context: ctx, ...privateData }); return value;
}
function privateRepositoryName(origin) {
  const https = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(origin);
  const ssh = /^git@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(origin);
  if (!https && !ssh) hold("ERC_PRIVATE_SOURCE_IDENTITY", "Approved private source origin is not an exact credential-free GitHub repository");
  return (https ?? ssh)[1];
}
// The approved W3 projection must derive installation/source URLs for the
// actual frozen public target. This validates bytes; it never rewrites docs.
export function inspectRcPublicInstallationSourceV1(subject, { publicRepository, privateRepository }) {
  if (publicRepository === privateRepository) hold("ERC_PUBLIC_INSTALLATION", "Public distribution must use its separate public target");
  const entries = subject?.entries;
  if (!Array.isArray(entries)) hold("ERC_PUBLIC_INSTALLATION", "Actual public source subject is required");
  const commands = [];
  for (const entry of entries) {
    if (!/\.(?:md|txt|json|ya?ml|html?|js|mjs|ts|jsx|css|svg|ps1|sh)$/.test(entry.path)) continue;
    let text; try { text = utf8.decode(entry.bytes); } catch { hold("ERC_PUBLIC_INSTALLATION", "A public source/document text file is not valid UTF-8"); }
    const privateReference = new RegExp(`(?:https://(?:raw\\.githubusercontent\\.com|github\\.com)/|git@github\\.com:)${privateRepository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/#?\\s.\\\"'<>]|$)`, "g");
    if (privateReference.test(text)) hold("ERC_PRIVATE_INSTALLATION_TARGET", "Public candidate still contains a private source/installation URL");
    // Only actual documentation contributes installation command evidence.
    // Generic script/test source may contain synthetic command examples; every
    // public text file still receives the private-target URL check above.
    if (!/\.(?:md|txt|html?)$/.test(entry.path)) continue;
    for (const match of text.matchAll(/codex\s+plugin\s+marketplace\s+add\s+([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/g)) {
      if (match[1] !== publicRepository) hold("ERC_PUBLIC_INSTALLATION", "Codex public installation names a different repository");
      commands.push({ path: entry.path, host: "codex", repository: match[1] });
    }
    for (const match of text.matchAll(/(?:gemini|qwen)\s+extensions?\s+install[^\r\n]*?https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?(?=[\s"'<>]|$)/g)) {
      if (match[1] !== publicRepository) hold("ERC_PUBLIC_INSTALLATION", "Public host installation names a different repository");
      commands.push({ path: entry.path, host: match[0].startsWith("gemini") ? "gemini-cli" : "qwen-code", repository: match[1] });
    }
    if (/qwen\s+extensions\s+install\s+\.\//.test(text)) {
      const clones = [...text.matchAll(/git\s+clone[\s\S]{0,180}?https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?(?=[\s"'<>]|$)/g)];
      if (!clones.some(match => match[1] === publicRepository)) hold("ERC_PUBLIC_INSTALLATION", "Qwen local-copy installation is not derived from its actual public source target");
      commands.push({ path: entry.path, host: "qwen-code", repository: publicRepository });
    }
  }
  if (!commands.some(c => c.host === "codex") || !commands.some(c => c.host === "gemini-cli") || !commands.some(c => c.host === "qwen-code")) hold("ERC_PUBLIC_INSTALLATION", "Actual public candidate lacks its three scoped host installation commands");
  const paths = new Set(entries.map(entry => entry.path));
  const template = "plugins/better-workflows/templates/auto.json", skill = "plugins/better-workflows/skills/auto/SKILL.md";
  if (!paths.has(template) || !paths.has(skill) || paths.has(".claude-plugin/marketplace.json") || paths.has("plugins/better-workflows/.claude-plugin/plugin.json") ||
      [...paths].some(file => file.startsWith("plugins/better-workflows/templates/") && file !== template || file.startsWith("plugins/better-workflows/skills/") && file !== skill)) hold("ERC_PUBLIC_SURFACE", "Actual public tree differs from the accepted Auto-only installation surface");
  const catalog = entries.find(entry => entry.path === "plugins/better-workflows/config/entrypoint-catalog.json");
  let parsed; try { parsed = JSON.parse(catalog?.bytes); } catch { hold("ERC_PUBLIC_SURFACE", "Exact public entrypoint catalog is absent"); }
  if (!Array.isArray(parsed.skills) || parsed.skills.length !== 1 || parsed.skills[0].id !== "auto" || parsed.skills[0].template !== "auto") hold("ERC_PUBLIC_SURFACE", "Public entrypoint catalog is not Auto-only");
  return Object.freeze({ installationSourceDigest: digestObject(commands), sourceTarget: publicRepository });
}

export async function verifyInstalledRcSourceRightsV1(ctx, scope) {
  await assertInstalledRcPublicationContextCurrentV1(ctx);
  await revalidateInstalledRcProjectionV1(ctx);
  if (!["public-source", "github-release"].includes(scope)) hold("ERC_RIGHTS_SCOPE", "Unknown effect-specific distribution rights scope");
  const subject = await deriveReleaseProductSubject({ cwd: ctx.candidate.publicRoot, sourceRevision: ctx.candidate.publicCandidateSha, productVersion: ctx.releaseTarget.releaseVersion });
  const origin = await runSourceGit(ctx.candidate.privateRoot, ["config", "--get", "remote.origin.url"], { encoding: "utf8", maxBuffer: 4096 });
  const install = inspectRcPublicInstallationSourceV1(subject, { publicRepository: ctx.target.repository.name, privateRepository: privateRepositoryName(String(origin.stdout).trim()) });
  const inputs = {};
  for (const [fileKey, shaKey, limit] of [["inventoryPath", "inventorySha256", 8 * 1024 * 1024], ["outerBindingPath", "outerBindingSha256", 2 * 1024 * 1024], ["artifactPath", "artifactSha256", MAX_ARCHIVE], ["releaseBodyPath", "releaseBodySha256", 128 * 1024]]) {
    const file = path.join(ctx.candidate.publicRoot, ctx.license[fileKey]);
    const bytes = fileKey === "releaseBodyPath" ? await readBoundedRuntimeFileV2(file, limit) : await readInstalledRcLicenseCarrierV1(ctx, fileKey);
    if (sha256(bytes) !== ctx.license[shaKey]) hold("ERC_LICENSE_INPUT", "Actual license/artifact/publication-body bytes differ from immutable installed inputs");
    inputs[shaKey] = sha256(bytes);
  }
  const gate = await verifyReleaseLicenseGate({ cwd: ctx.candidate.publicRoot, sourceRevision: ctx.candidate.publicCandidateSha, productVersion: ctx.releaseTarget.releaseVersion,
    inventoryPath: ctx.license.inventoryPath, outerBindingPath: ctx.license.outerBindingPath, artifactPath: ctx.license.artifactPath });
  // Replace only the one unavailable-integration issue with the actual signed
  // verifier below. Every engineering/schema/boundary/rightsReady issue remains.
  const issues = gate.issues ?? [];
  if (issues.length !== 1 || issues[0]?.code !== "RIGHTS_CLEARANCE_UNAVAILABLE" || !gate.rightsClearanceRequest || gate.coverageProof?.verified !== true ||
      gate.inventory?.coverage?.complete !== true || gate.inventory?.schemaErrors?.length !== 0 || gate.inventory?.releaseDisposition !== "READY" || gate.inventory?.rightsReady !== true ||
      gate.inputs?.inventorySha256 !== inputs.inventorySha256 || gate.inputs?.outerBindingSha256 !== inputs.outerBindingSha256 || gate.inputs?.artifactSha256 !== inputs.artifactSha256 ||
      gate.releaseSubject?.filesSha256 !== subject.filesSha256 || gate.releaseSubject?.treeSha256 !== subject.treeSha256) hold("ERC_LICENSE_HOLD", "Full-public-universe engineering, license inventory, artifact/source mapping or rights request is incomplete");
  const trusted = await readInstalledRcRightsInputsV1(ctx, scope);
  const clearance = inspectRightsClearanceEnvelopeV1({ ...trusted, request: gate.rightsClearanceRequest,
    expected: { targetRepositoryId: ctx.target.repository.id, operationId: ctx.operationId, productReleaseScopeDigest: ctx.binding.productReleaseScopeDigest,
      distributionScope: scope, sourceRevision: ctx.candidate.publicCandidateSha, publicSourceRevision: ctx.candidate.publicCandidateSha,
      productVersion: ctx.releaseTarget.releaseVersion, artifactSha256: inputs.artifactSha256, requestDigest: gate.rightsClearanceRequest.requestDigest }, nowMs: Date.now() });
  await revalidateReleaseProductSubject(subject, { cwd: ctx.candidate.publicRoot });
  await assertInstalledRcPublicationContextCurrentV1(ctx);
  return result(ctx, scope, { licenseGateReceiptDigest: gate.receipt.receiptDigest, rightsEnvelopeSha256: clearance.envelopeSha256, rightsPolicySha256: clearance.policySha256,
    requestDigest: clearance.requestDigest, fileCount: clearance.fileCount, sourceFilesSha256: subject.filesSha256, sourceTreeSha256: subject.treeSha256,
    artifactSha256: inputs.artifactSha256, releaseBodySha256: inputs.releaseBodySha256, ...install }, verifiedRights, { subject, expiresAt: JSON.parse(trusted.envelopeBytes).payload.expiresAt });
}
export async function assertInstalledRcSourceRightsResultV1(value, ctx, scope) {
  assertInstalledRcPublicationContextV1(ctx);
  const data = verifiedRights.get(value);
  if (!data || data.context !== ctx || value.phase !== scope || value.bindingDigest !== ctx.bindingDigest || Date.parse(data.expiresAt) <= Date.now()) hold("ERC_RIGHTS_RESULT", "Actual current effect-specific signed rights result is required");
  await revalidateReleaseProductSubject(data.subject, { cwd: ctx.candidate.publicRoot });
  await assertInstalledRcPublicationContextCurrentV1(ctx); return value;
}

export async function observeInstalledRcGithubIdentityV1(ctx) {
  await assertInstalledRcPublicationContextCurrentV1(ctx);
  const prefix = `repos/${ctx.target.repository.name}`;
  const [repository, actor, refs] = await Promise.all([rcPublicationGithubReadV1(ctx, prefix), rcPublicationGithubReadV1(ctx, "user"), rcPublicationGithubAllRefsV1(ctx)]);
  if (!repository || repository.full_name !== ctx.target.repository.name || String(repository.id) !== ctx.target.repository.id || repository.private !== false || repository.visibility !== "public" || repository.archived || repository.disabled ||
      actor?.login !== ctx.binding.actor.login || String(actor?.id) !== ctx.binding.actor.id) hold("ERC_PROVIDER_BINDING", "Fresh actual public target/actor identity differs from the immutable staged grant");
  return { repository: { name: repository.full_name, id: String(repository.id), private: repository.private, visibility: repository.visibility }, actor: { login: actor.login, id: String(actor.id) }, refs };
}
export function inspectRcPublicRefsV1(refs, ctx, tagRequired = false) {
  if (!Array.isArray(refs) || refs.length !== (tagRequired ? 2 : 1)) hold("ERC_REFS_CONFLICT", "Public target has missing/conflicting refs");
  const allowed = new Set([ctx.target.sourceRef, ...(tagRequired ? [ctx.target.tagRef] : [])]);
  for (const ref of refs) if (!allowed.delete(ref?.ref) || ref.object?.type !== "commit" || ref.object?.sha !== ctx.candidate.publicCandidateSha) hold("ERC_REFS_CONFLICT", "Public refs do not point directly to the exact parentless public candidate");
  if (allowed.size) hold("ERC_REFS_CONFLICT", "Public source/tag ref is missing");
}
export async function observeInstalledRcEmptyTargetV1(ctx) {
  const observation = await observeInstalledRcGithubIdentityV1(ctx);
  const releases = await rcPublicationGithubReadV1(ctx, `repos/${ctx.target.repository.name}/releases?per_page=100`);
  if (observation.refs.length || !Array.isArray(releases) || releases.length) hold("ERC_BOOTSTRAP_NONEMPTY", "Source bootstrap permits only the exact public-empty target, without refs or releases");
  return Object.freeze({ ...observation, releases, evidenceDigest: digestObject({ ...observation, releases }) });
}

function octal(bytes) { const text = bytes.toString("ascii").replace(/\0/g, "").trim(); if (!/^[0-7]+$/.test(text)) hold("ERC_SOURCE_ARCHIVE", "Source tar integer is invalid"); return Number.parseInt(text, 8); }
function field(bytes) { try { return utf8.decode(bytes).replace(/\0+$/, ""); } catch { hold("ERC_SOURCE_ARCHIVE", "Source tar name is not UTF-8"); } }
function pax(bytes) {
  const values = {}; let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset); if (space < 0 || space - offset > 10) hold("ERC_SOURCE_ARCHIVE", "PAX length is invalid");
    const length = Number(bytes.subarray(offset, space).toString("ascii"));
    if (!Number.isSafeInteger(length) || length < space - offset + 4 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) hold("ERC_SOURCE_ARCHIVE", "PAX record is truncated");
    const text = field(bytes.subarray(space + 1, offset + length - 1)); const equal = text.indexOf("=");
    if (equal < 1 || Object.hasOwn(values, text.slice(0, equal))) hold("ERC_SOURCE_ARCHIVE", "PAX record is duplicated or invalid");
    values[text.slice(0, equal)] = text.slice(equal + 1); offset += length;
  }
  return values;
}
// GitHub's immutable exact-commit archive adds one top-level directory and Git
// PAX comment/path records. Normalize those only; compare every actual file byte
// and executable bit against the already verified full Git source universe.
export function inspectRcGithubSourceArchiveV1(archive, subject, repository) {
  if (!(archive instanceof Uint8Array) || archive.length < 32 || archive.length > MAX_ARCHIVE || !SHA40.test(subject?.sourceRevision ?? "")) hold("ERC_SOURCE_ARCHIVE", "Actual bounded exact-commit GitHub archive is required");
  let raw; try { raw = gunzipSync(archive, { maxOutputLength: MAX_SOURCE }); } catch { hold("ERC_SOURCE_ARCHIVE", "Actual source archive gzip is invalid or oversized"); }
  if (raw.length < 1024 || raw.length % 512 || raw.length > archive.length * 1000) hold("ERC_SOURCE_ARCHIVE", "Source tar framing/compression exceeds bounds");
  const prefix = `${repository.split("/")[1]}-${subject.sourceRevision}/`;
  const expected = new Map(subject.entries.map(entry => [entry.path, entry])); const seen = new Set(), directories = new Set([""]);
  for (const file of expected.keys()) { const parts = file.split("/"); for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/")); }
  let offset = 0, extended = null, globalSeen = false, count = 0, ended = false;
  const observed = [];
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) { if (raw.subarray(offset).some(byte => byte !== 0) || raw.length - offset < 512 || extended) hold("ERC_SOURCE_ARCHIVE", "Source tar termination is invalid"); ended = true; break; }
    if (++count > 16384) hold("ERC_SOURCE_ARCHIVE", "Source tar has too many entries");
    const expectedChecksum = octal(header.subarray(148, 156)); let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== expectedChecksum || !field(header.subarray(257, 263)).startsWith("ustar")) hold("ERC_SOURCE_ARCHIVE", "Source tar header checksum/format is invalid");
    const size = octal(header.subarray(124, 136)); if (!Number.isSafeInteger(size) || size > 16 * 1024 * 1024 || offset + Math.ceil(size / 512) * 512 > raw.length) hold("ERC_SOURCE_ARCHIVE", "Source tar entry is oversized or truncated");
    const bytes = raw.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156]);
    if (type === "g" || type === "x") {
      if (size > 16384 || extended) hold("ERC_SOURCE_ARCHIVE", "Source tar PAX extension exceeds bounds");
      const values = pax(bytes);
      if (type === "g") { if (globalSeen || Object.keys(values).length !== 1 || values.comment !== subject.sourceRevision) hold("ERC_SOURCE_ARCHIVE", "Source archive Git PAX commit is not the exact candidate"); globalSeen = true; }
      else { if (Object.keys(values).length !== 1 || typeof values.path !== "string") hold("ERC_SOURCE_ARCHIVE", "Source tar has an unsupported PAX override"); extended = values.path; }
      continue;
    }
    const name = extended ?? [field(header.subarray(345, 500)), field(header.subarray(0, 100))].filter(Boolean).join("/"); extended = null;
    if (!name.startsWith(prefix) || /[\\\0]/.test(name)) hold("ERC_SOURCE_ARCHIVE", "Source archive path escapes the exact immutable GitHub prefix");
    const relative = name.slice(prefix.length).replace(/\/$/, "");
    if (relative.split("/").some(part => part === "." || part === "..") || seen.has(name)) hold("ERC_SOURCE_ARCHIVE", "Source archive path is duplicated/unsafe"); seen.add(name);
    if (type === "5") { if (size !== 0 || !name.endsWith("/") || !directories.has(relative)) hold("ERC_SOURCE_ARCHIVE", "Source archive contains an unexpected directory"); continue; }
    if (type !== "0" && type !== "\0") hold("ERC_SOURCE_ARCHIVE", "Source archive contains a link or unsupported entry");
    const entry = expected.get(relative), mode = octal(header.subarray(100, 108));
    if (!entry || sha256(bytes) !== entry.sha256 || bytes.length !== entry.size || (mode & 0o111) !== (entry.mode & 0o111)) hold("ERC_SOURCE_ARCHIVE", "Actual archive file bytes/mode differ from the full public source tree");
    expected.delete(relative); observed.push({ path: relative, sha256: sha256(bytes), executable: Boolean(mode & 0o111) });
  }
  if (!ended || !globalSeen || expected.size) hold("ERC_SOURCE_ARCHIVE", "Actual Corresponding Source archive is incomplete or lacks its exact commit binding");
  return Object.freeze({ sourceArchiveSha256: sha256(archive), sourceArchiveFilesDigest: digestObject(observed.sort((a, b) => a.path.localeCompare(b.path))), sourceArchiveFileCount: observed.length });
}
async function publicArchive(ctx) {
  const url = `https://codeload.github.com/${ctx.target.repository.name}/tar.gz/${ctx.candidate.publicCandidateSha}`;
  const response = await fetch(url, { method: "GET", redirect: "error", credentials: "omit", headers: { "User-Agent": "BetterWorkflowsInstalledRcPublisherV1", "Accept": "application/gzip" }, signal: AbortSignal.timeout(60_000) });
  if (response.status !== 200 || response.url !== url || !response.body) { await response.body?.cancel(); hold("ERC_CORRESPONDING_SOURCE_UNAVAILABLE", "Actual public unauthenticated exact-commit source archive is unavailable"); }
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_ARCHIVE) { await response.body.cancel(); hold("ERC_SOURCE_ARCHIVE", "Actual public source archive exceeds bounds"); }
  const chunks = []; let size = 0;
  try { for await (const chunk of response.body) { size += chunk.length; if (size > MAX_ARCHIVE) hold("ERC_SOURCE_ARCHIVE", "Actual public source archive exceeded its bound"); chunks.push(Buffer.from(chunk)); } }
  finally { if (size > MAX_ARCHIVE) await response.body.cancel().catch(() => {}); }
  return { url, bytes: Buffer.concat(chunks) };
}
export async function observeInstalledRcPublishedSourceV1(ctx, rights, { tagRequired = false } = {}) {
  await assertInstalledRcSourceRightsResultV1(rights, ctx, rights?.phase);
  const subject = verifiedRights.get(rights).subject;
  const observation = await observeInstalledRcGithubIdentityV1(ctx); inspectRcPublicRefsV1(observation.refs, ctx, tagRequired);
  const prefix = `repos/${ctx.target.repository.name}`;
  const commit = await rcPublicationGithubReadV1(ctx, `${prefix}/git/commits/${ctx.candidate.publicCandidateSha}`);
  if (commit?.sha !== ctx.candidate.publicCandidateSha || commit.tree?.sha !== ctx.candidate.publicTreeOid || !Array.isArray(commit.parents) || commit.parents.length !== 0) hold("ERC_SOURCE_COMMIT", "Actual public source commit/tree/history differs from the parentless approved candidate");
  const tree = await rcPublicationGithubReadV1(ctx, `${prefix}/git/trees/${ctx.candidate.publicTreeOid}?recursive=1`);
  const entries = tree?.tree;
  if (tree?.sha !== ctx.candidate.publicTreeOid || tree.truncated !== false || !Array.isArray(entries) || entries.length > 12288) hold("ERC_SOURCE_TREE", "Actual complete public source tree is unavailable");
  const blobs = entries.filter(entry => entry.type !== "tree");
  const actual = blobs.map(entry => ({ path: entry.path, sha: entry.sha, mode: entry.mode, size: entry.size })).sort((a, b) => a.path.localeCompare(b.path));
  const expected = subject.entries.map(entry => ({ path: entry.path, sha: entry.gitBlobSha1, mode: (entry.mode & 0o111) ? "100755" : "100644", size: entry.size })).sort((a, b) => a.path.localeCompare(b.path));
  if (blobs.some(entry => entry.type !== "blob") || digestObject(actual) !== digestObject(expected)) hold("ERC_SOURCE_TREE", "Actual provider source tree differs from the complete approved public universe");
  const archive = await publicArchive(ctx); const availability = inspectRcGithubSourceArchiveV1(archive.bytes, subject, ctx.target.repository.name);
  await revalidateReleaseProductSubject(subject, { cwd: ctx.candidate.publicRoot });
  const final = await observeInstalledRcGithubIdentityV1(ctx); inspectRcPublicRefsV1(final.refs, ctx, tagRequired);
  if (digestObject(final) !== digestObject(observation)) hold("ERC_SOURCE_PROVIDER_DRIFT", "Provider identity/refs changed while validating Corresponding Source");
  const evidence = { ...availability, correspondingSourceUrl: archive.url, sourceCommitSha: commit.sha, sourceTreeOid: tree.sha, publicTreeDigest: digestObject(actual),
    providerBindingDigest: digestObject(final), sourceRightsDigest: rights.evidenceDigest };
  return result(ctx, "source-observation", evidence, observedSources, { rights, tagRequired });
}
export async function assertInstalledRcPublishedSourceResultV1(value, ctx) {
  const data = observedSources.get(value);
  if (!data || data.context !== ctx || value.bindingDigest !== ctx.bindingDigest) hold("ERC_SOURCE_OBSERVATION", "Actual installed source observation is required");
  await assertInstalledRcSourceRightsResultV1(data.rights, ctx, data.rights.phase); return value;
}
