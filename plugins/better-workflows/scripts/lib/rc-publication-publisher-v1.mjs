// SPDX-License-Identifier: AGPL-3.0-only
// One installed, staged, create-only RC publisher using the existing W5 ledger.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, digestObject, sha256 } from "./core.mjs";
import { withInstalledRcSourceGitV1 } from "./git.mjs";
import { acquireScopedSqliteMutexV1 } from "./scoped-sqlite-mutex-v1.mjs";
import { appendW5PublicationJournalV1, readW5PublicationJournalV1 } from "./w5-publication-journal-v1.mjs";
import { replayW5PublicationOperationV1, W5_PUBLICATION_STAGES } from "./w5-publication-operation-v1.mjs";
import { assertRootOwnedRuntimePathV2, observeRootOwnedRuntimeFileV2, readBoundedRuntimeFileV2 } from "./runtime-qualification-v2.mjs";
import { loadInstalledRcPublicationContextV1, assertInstalledRcPublicationContextCurrentV1, rcPublicationHoldV1,
  rcPublicationExactFieldsV1, rcPublicationGithubReadV1, rcPublicationDispatchEffectV1, deriveRcPublicationReleaseBodyV1,
  rcPublicationAssertOwnedCleanupV1 } from "./rc-publication-installed-context-v1.mjs";
import { verifyInstalledRcSourceRightsV1, assertInstalledRcSourceRightsResultV1, observeInstalledRcEmptyTargetV1,
  observeInstalledRcGithubIdentityV1, inspectRcPublicRefsV1, observeInstalledRcPublishedSourceV1 } from "./rc-publication-source-rights-v1.mjs";

const hold = rcPublicationHoldV1;
const EFFECT = Object.freeze({ sourcepublished: "create-source-main", tagcreated: "create-rc-tag", released: "create-rc-prerelease" });
const SHA256 = /^[a-f0-9]{64}$/;
const sourceAdmissions = new WeakMap(), qualifiedAdmissions = new WeakMap();
async function adapters() {
  // These two URLs are part of the full hash-pinned installed image. Neither
  // caller callbacks nor config module paths can replace them.
  let review, qualification;
  try {
    review = await import("./rc-publication-review-docs-v1.mjs");
    qualification = await import("./rc-publication-qualification-v1.mjs");
  } catch { hold("ERC_TRUSTED_ADAPTER_MISSING", "The complete installed review/docs and qualification adapters must exist before source publication"); }
  for (const [module, names] of [[review, ["verifyInstalledRcSnapshotReviewV1", "verifyInstalledRcReviewDocumentsV1", "assertInstalledRcReviewDocumentsResultV1"]],
    [qualification, ["verifyInstalledRcCandidateSourcePreflightV1", "verifyInstalledRcQualificationV1", "verifyInstalledRcFreshProviderEvidenceV1", "assertInstalledRcQualificationResultV1"]]]) {
    if (names.some(name => typeof module[name] !== "function")) hold("ERC_TRUSTED_ADAPTER_API", "The fixed installed RC adapter API is incomplete");
  }
  return { review, qualification };
}
async function durableDirectory(parent, directory) {
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  await assertRootOwnedRuntimePathV2(directory, { directory: true });
  if (((await lstat(directory)).mode & 0o777) !== 0o700) hold("ERC_EVIDENCE_PATH", "Authoritative operation evidence must remain root-private");
  const handle = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); }
}
async function persistRecord(ctx, value, name = null) {
  const bytes = Buffer.from(canonicalJson(value)), digest = sha256(bytes);
  const file = path.join(ctx.paths.evidenceRoot, name ?? `${digest}.json`);
  let handle;
  try { handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = await observeRootOwnedRuntimeFileV2(file, { maxBytes: 4 * 1024 * 1024, exactMode: 0o600 });
    if (previous.sha256 !== digest) hold("ERC_EVIDENCE_CONFLICT", "Immutable operation evidence conflicts with its existing record");
  }
  if (handle) { try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
  const directory = await open(ctx.paths.evidenceRoot, constants.O_RDONLY | constants.O_NOFOLLOW); try { await directory.sync(); } finally { await directory.close(); }
  const current = await observeRootOwnedRuntimeFileV2(file, { maxBytes: 4 * 1024 * 1024, exactMode: 0o600 });
  if (current.sha256 !== digest) hold("ERC_EVIDENCE_DRIFT", "Operation evidence changed after durable storage");
  return digest;
}
async function readReplay(ctx) {
  try { return (await readW5PublicationJournalV1({ stateRoot: ctx.paths.stateRoot, operationId: ctx.operationId })).replay; }
  catch (error) { if (error.code !== "EW5_JOURNAL_MISSING") throw error; return replayW5PublicationOperationV1({ events: [] }); }
}
function boundReplay(replay, ctx) {
  if (replay.binding && (replay.operationId !== ctx.operationId || replay.bindingDigest !== ctx.bindingDigest || canonicalJson(replay.binding) !== canonicalJson(ctx.preparePayload))) hold("ERC_W5_BINDING", "Durable operation binding differs from the single immutable candidate/target/image/grant");
  return replay;
}
async function append(ctx, replay, op, payload) {
  await assertInstalledRcPublicationContextCurrentV1(ctx);
  const result = await appendW5PublicationJournalV1({ stateRoot: ctx.paths.stateRoot, operationId: ctx.operationId,
    expectedHeadDigest: replay.headDigest, expectedEventCount: replay.eventCount,
    request: { operationId: ctx.operationId, eventId: randomUUID(), op, payload } });
  return boundReplay(result.replay, ctx);
}
function summary(result, ctx, phase) {
  if (!result || result.authenticatedState !== "VERIFIED_CURRENT" || result.operationId !== ctx.operationId || result.bindingDigest !== ctx.bindingDigest ||
      result.publicCandidateSha !== ctx.candidate.publicCandidateSha || result.publicTreeOid !== ctx.candidate.publicTreeOid || result.phase !== phase || !SHA256.test(result.evidenceDigest ?? "")) hold("ERC_ADAPTER_RESULT", "The fixed installed consumer did not verify this exact publication phase");
  return { phase, evidenceDigest: result.evidenceDigest };
}
async function sourceAdmission(ctx, api) {
  await api.qualification.verifyInstalledRcCandidateSourcePreflightV1(ctx);
  const rights = await verifyInstalledRcSourceRightsV1(ctx, "public-source");
  const review = await api.review.verifyInstalledRcSnapshotReviewV1(ctx);
  await api.review.assertInstalledRcReviewDocumentsResultV1(review, ctx, "source");
  await assertInstalledRcSourceRightsResultV1(rights, ctx, "public-source");
  const value = Object.freeze({ rights, evidence: Object.freeze({ sourceRights: summary(rights, ctx, "public-source"), snapshotReview: summary(review, ctx, "source") }) });
  sourceAdmissions.set(value, ctx); return value;
}
async function qualificationAdmission(ctx, api, { tagRequired = false, releaseRights = false } = {}) {
  const rights = await verifyInstalledRcSourceRightsV1(ctx, releaseRights ? "github-release" : "public-source");
  const source = await observeInstalledRcPublishedSourceV1(ctx, rights, { tagRequired });
  const review = await api.review.verifyInstalledRcReviewDocumentsV1(ctx);
  await api.review.assertInstalledRcReviewDocumentsResultV1(review, ctx, "qualification");
  const qualification = await api.qualification.verifyInstalledRcQualificationV1(ctx);
  await api.qualification.assertInstalledRcQualificationResultV1(qualification, ctx, "qualification");
  const fresh = await api.qualification.verifyInstalledRcFreshProviderEvidenceV1(ctx);
  await api.qualification.assertInstalledRcQualificationResultV1(fresh, ctx, "fresh");
  await assertInstalledRcSourceRightsResultV1(rights, ctx, rights.phase);
  const value = Object.freeze({ rights, source, evidence: Object.freeze({ rights: summary(rights, ctx, rights.phase), source: summary(source, ctx, "source-observation"),
    reviewDocuments: summary(review, ctx, "qualification"), qualification: summary(qualification, ctx, "qualification"), freshProvider: summary(fresh, ctx, "fresh") }) });
  qualifiedAdmissions.set(value, ctx); return value;
}
export function inspectRcReleaseReadbackV1(release, expected) {
  rcPublicationExactFieldsV1(expected, ["repository", "candidateSha", "tag", "name", "body", "actorId"], "release readback expectation");
  if (!release || !Number.isSafeInteger(release.id) || release.id <= 0 || release.tag_name !== expected.tag || release.target_commitish !== expected.candidateSha || release.name !== expected.name ||
      release.body !== expected.body || release.draft !== false || release.prerelease !== true || String(release.author?.id) !== expected.actorId ||
      release.html_url !== `https://github.com/${expected.repository}/releases/tag/${expected.tag}` || !Array.isArray(release.assets) || release.assets.length !== 0) hold("ERC_RELEASE_CONFLICT", "Actual prerelease readback differs from the exact authorized target/candidate/payload");
  return Object.freeze({ id: String(release.id), tag: release.tag_name, name: release.name, candidateSha: release.target_commitish, prerelease: release.prerelease, draft: release.draft,
    bodySha256: sha256(release.body), authorId: String(release.author.id), htmlUrl: release.html_url, assetCount: release.assets.length });
}
async function observeRelease(ctx, { absenceAllowed = false } = {}) {
  const prefix = `repos/${ctx.target.repository.name}`;
  const release = await rcPublicationGithubReadV1(ctx, `${prefix}/releases/tags/${encodeURIComponent(ctx.releaseTarget.releaseTag)}`);
  const all = await rcPublicationGithubReadV1(ctx, `${prefix}/releases?per_page=100`);
  const latest = await rcPublicationGithubReadV1(ctx, `${prefix}/releases/latest`);
  if (!Array.isArray(all) || latest !== null) hold("ERC_RELEASE_CHANNEL", "The exact RC target has an unexpected latest/stable release");
  if (release === null) {
    if (all.length || !absenceAllowed) hold("ERC_RELEASE_CONFLICT", "Exact prerelease is missing or another release conflicts");
    return null;
  }
  if (all.length !== 1 || all[0]?.id !== release.id) hold("ERC_RELEASE_CONFLICT", "Publication target contains an unexpected release");
  const bytes = await readBoundedRuntimeFileV2(path.join(ctx.candidate.publicRoot, ctx.license.releaseBodyPath), 128 * 1024);
  if (sha256(bytes) !== ctx.license.releaseBodySha256) hold("ERC_CHANGELOG", "Committed release notes changed before readback");
  return inspectRcReleaseReadbackV1(release, { repository: ctx.target.repository.name, candidateSha: ctx.candidate.publicCandidateSha, tag: ctx.releaseTarget.releaseTag,
    name: ctx.releaseTarget.releaseName, body: deriveRcPublicationReleaseBodyV1(bytes, ctx.releaseTarget, ctx.candidate.publicCandidateSha), actorId: ctx.binding.actor.id });
}
async function prerequisites(ctx, api, step) {
  await rcPublicationAssertOwnedCleanupV1(ctx);
  if (step === "sourcepublished") {
    const admission = await sourceAdmission(ctx, api), empty = await observeInstalledRcEmptyTargetV1(ctx);
    if (sourceAdmissions.get(admission) !== ctx) hold("ERC_SOURCE_ADMISSION", "Genuine source admission is missing");
    return { admission, evidence: { ...admission.evidence, emptyTargetDigest: empty.evidenceDigest } };
  }
  const admission = await qualificationAdmission(ctx, api, { tagRequired: ["released", "readback", "cleanup"].includes(step), releaseRights: ["tagcreated", "released", "readback", "cleanup"].includes(step) });
  if (qualifiedAdmissions.get(admission) !== ctx) hold("ERC_RC_ADMISSION", "Genuine exact-SHA RC qualification is missing");
  if (step === "remotechecks" || step === "tagcreated") {
    const release = await observeRelease(ctx, { absenceAllowed: true });
    if (release !== null) hold("ERC_CREATE_ONLY", "An existing prerelease cannot be adopted before its durable create intent");
  }
  if (step === "released") {
    const release = await observeRelease(ctx, { absenceAllowed: true });
    if (release !== null) hold("ERC_CREATE_ONLY", "Release publication requires an absent prerelease before its create intent");
  }
  return { admission, evidence: admission.evidence };
}
async function observedStage(ctx, api, step, admission, cleanup = null) {
  if (step === "sourcepublished") return { source: (await observeInstalledRcPublishedSourceV1(ctx, admission.rights)).evidenceDigest };
  if (step === "remotechecks") return { ...admission.evidence };
  if (step === "tagcreated") return { ...admission.evidence, sourceWithTag: (await observeInstalledRcPublishedSourceV1(ctx, admission.rights, { tagRequired: true })).evidenceDigest };
  if (step === "released" || step === "readback") {
    const source = await observeInstalledRcPublishedSourceV1(ctx, admission.rights, { tagRequired: true });
    const fresh = await api.qualification.verifyInstalledRcFreshProviderEvidenceV1(ctx); await api.qualification.assertInstalledRcQualificationResultV1(fresh, ctx, "fresh");
    return { ...admission.evidence, sourceWithTag: source.evidenceDigest, freshProvider: summary(fresh, ctx, "fresh"), release: await observeRelease(ctx) };
  }
  if (step === "cleanup") return { ...admission.evidence, release: await observeRelease(ctx), ...await rcPublicationAssertOwnedCleanupV1(ctx), publicationLeaseReleased: cleanup === true };
  hold("ERC_STAGE", "Unknown bounded RC publication stage");
}
async function attemptRecord(ctx, attemptId, step, prerequisitesDigest) {
  const record = { operationId: ctx.operationId, bindingDigest: ctx.bindingDigest, grantDigest: ctx.grantDigest, installedImageSha256: ctx.installedImageSha256,
    step, attemptId, prerequisitesDigest, publisherPid: process.pid, preparedAt: new Date().toISOString() };
  await persistRecord(ctx, record, `${attemptId}.intent.json`); return record;
}
async function recover(ctx, api, replay, mutex) {
  const { step, attemptId } = replay.pending;
  const record = await observeRootOwnedRuntimeFileV2(path.join(ctx.paths.evidenceRoot, `${attemptId}.intent.json`), { maxBytes: 64 * 1024, exactMode: 0o600, includeBytes: true });
  let intent; try { intent = JSON.parse(record.bytes); } catch { hold("ERC_RECOVERY_INTENT", "Durable exact attempt prerequisites are unavailable"); }
  if (intent.operationId !== ctx.operationId || intent.bindingDigest !== ctx.bindingDigest || intent.grantDigest !== ctx.grantDigest || intent.installedImageSha256 !== ctx.installedImageSha256 || intent.step !== step || intent.attemptId !== attemptId || !SHA256.test(intent.prerequisitesDigest ?? "")) hold("ERC_RECOVERY_INTENT", "Attempt prerequisites belong to another immutable publication");
  const previous = await observeRootOwnedRuntimeFileV2(path.join(ctx.paths.evidenceRoot, `${intent.prerequisitesDigest}.json`), { maxBytes: 4 * 1024 * 1024, exactMode: 0o600 });
  if (previous.sha256 !== intent.prerequisitesDigest) hold("ERC_RECOVERY_INTENT", "Pre-dispatch evidence differs from its durable digest");
  const cleanup = await rcPublicationAssertOwnedCleanupV1(ctx); await mutex.assertOwned();
  if (replay.pending.status === "INTENT") {
    const digest = await persistRecord(ctx, { operationId: ctx.operationId, bindingDigest: ctx.bindingDigest, step, attemptId, observation: "CRASH_INTENT_REQUIRES_PROVIDER_RECONCILIATION", cleanup });
    replay = await append(ctx, replay, "EFFECT_RESULT", { step, attemptId, outcome: "UNKNOWN", evidenceDigest: digest, bindingDigest: ctx.bindingDigest });
  }
  let outcome = "SUCCEEDED", evidence;
  if (step === "sourcepublished") {
    const actual = await observeInstalledRcGithubIdentityV1(ctx);
    if (!actual.refs.length) { const empty = await observeInstalledRcEmptyTargetV1(ctx); outcome = "NOT_APPLIED"; evidence = { emptyTargetDigest: empty.evidenceDigest, cleanup }; }
    else { inspectRcPublicRefsV1(actual.refs, ctx, false); const admission = await sourceAdmission(ctx, api); evidence = await observedStage(ctx, api, step, admission); }
  } else if (step === "tagcreated") {
    const actual = await observeInstalledRcGithubIdentityV1(ctx), tag = actual.refs.find(ref => ref.ref === ctx.target.tagRef);
    if (!tag) { inspectRcPublicRefsV1(actual.refs, ctx, false); outcome = "NOT_APPLIED"; evidence = { refsDigest: digestObject(actual), cleanup }; }
    else { inspectRcPublicRefsV1(actual.refs, ctx, true); const admission = await qualificationAdmission(ctx, api, { tagRequired: true, releaseRights: true }); evidence = await observedStage(ctx, api, step, admission); }
  } else if (step === "released") {
    const release = await observeRelease(ctx, { absenceAllowed: true });
    if (release === null) { const actual = await observeInstalledRcGithubIdentityV1(ctx); inspectRcPublicRefsV1(actual.refs, ctx, true); outcome = "NOT_APPLIED"; evidence = { releaseAbsent: true, refsDigest: digestObject(actual), cleanup }; }
    else { const admission = await qualificationAdmission(ctx, api, { tagRequired: true, releaseRights: true }); evidence = await observedStage(ctx, api, step, admission); }
  } else {
    const { admission } = await prerequisites(ctx, api, step); evidence = await observedStage(ctx, api, step, admission, step === "cleanup" ? await mutex.release().then(() => true) : null);
  }
  const evidenceDigest = await persistRecord(ctx, { operationId: ctx.operationId, bindingDigest: ctx.bindingDigest, step, attemptId, reconciliation: true, outcome, evidence });
  replay = await append(ctx, replay, "EFFECT_RECONCILE", { step, attemptId, outcome, evidenceDigest, bindingDigest: ctx.bindingDigest });
  if (outcome === "NOT_APPLIED") hold("ERC_RECONCILED_NOT_APPLIED", "The exact prior attempt is reconciled as not applied; a fresh invocation may request a new create-only attempt");
  return replay;
}

export async function runInstalledProductRcPublicationV1(request) {
  return withInstalledRcSourceGitV1(request, () => runScopedInstalledProductRcPublicationV1(request));
}
async function runScopedInstalledProductRcPublicationV1(request) {
  const ctx = await loadInstalledRcPublicationContextV1(request), api = await adapters();
  await durableDirectory(ctx.paths.stateRoot, ctx.paths.evidenceRoot);
  const mutex = await acquireScopedSqliteMutexV1({ stateRoot: ctx.paths.coordinationRoot, namespace: "installed-product-rc-publisher-v1",
    resourceDigest: digestObject({ provider: "github", repositoryId: ctx.target.repository.id }) });
  let released = false;
  const lease = { assertOwned: () => mutex.assertOwned(), release: async () => { if (!released) { await mutex.release(); released = true; } } };
  try {
    let replay = boundReplay(await readReplay(ctx), ctx);
    if (!replay.binding) {
      const preflight = await prerequisites(ctx, api, "sourcepublished");
      await persistRecord(ctx, { operationId: ctx.operationId, bindingDigest: ctx.bindingDigest, stage: "prepared", prerequisites: preflight.evidence });
      await lease.assertOwned(); replay = await append(ctx, replay, "PREPARE", ctx.preparePayload);
    }
    if (replay.pending) replay = await recover(ctx, api, replay, lease);
    if (replay.operationStatus === "COMPLETE") {
      // A terminal journal records the past operation; current remote state
      // must still satisfy its exact source/tag/release and existing qualifiers.
      await qualificationAdmission(ctx, api, { tagRequired: true, releaseRights: true });
      await observeRelease(ctx);
      await rcPublicationAssertOwnedCleanupV1(ctx);
      await assertInstalledRcPublicationContextCurrentV1(ctx);
      return Object.freeze({ status: "COMPLETE", operationId: ctx.operationId, channel: "rc", releaseVersion: ctx.releaseTarget.releaseVersion, publicCandidateSha: ctx.candidate.publicCandidateSha,
        repository: ctx.target.repository, w5HeadDigest: replay.headDigest, w5EventCount: replay.eventCount, gaAcceptance: "NOT_ESTABLISHED", releaseUrl: `https://github.com/${ctx.target.repository.name}/releases/tag/${ctx.releaseTarget.releaseTag}` });
    }
    for (let stages = 0; stages < 6; stages++) {
      const step = W5_PUBLICATION_STAGES[W5_PUBLICATION_STAGES.indexOf(replay.stage) + 1];
      if (!step) break;
      const { admission, evidence } = await prerequisites(ctx, api, step);
      const prerequisitesDigest = await persistRecord(ctx, { operationId: ctx.operationId, bindingDigest: ctx.bindingDigest, step, prerequisites: evidence });
      const attemptId = randomUUID(); await attemptRecord(ctx, attemptId, step, prerequisitesDigest);
      await lease.assertOwned(); replay = await append(ctx, replay, "EFFECT_INTENT", { step, attemptId, bindingDigest: ctx.bindingDigest });
      let dispatchStarted = false, effectDispatch = null;
      try {
        await lease.assertOwned(); await assertInstalledRcPublicationContextCurrentV1(ctx);
        if (EFFECT[step]) {
          if (step === "sourcepublished") await observeInstalledRcEmptyTargetV1(ctx);
          else { const actual = await observeInstalledRcGithubIdentityV1(ctx); inspectRcPublicRefsV1(actual.refs, ctx, step === "released"); if (await observeRelease(ctx, { absenceAllowed: true }) !== null) hold("ERC_CREATE_ONLY", "Publication target changed before create-only dispatch"); }
          await assertInstalledRcSourceRightsResultV1(admission.rights, ctx, admission.rights.phase);
          // Nonzero/timeout/malformed response never proves that the provider
          // did not apply the write. Only the exact independent readback can.
          effectDispatch = await rcPublicationDispatchEffectV1(ctx, attemptId, EFFECT[step]);
          dispatchStarted = true;
        }
        if (step === "cleanup") { await rcPublicationAssertOwnedCleanupV1(ctx); await lease.release(); }
        const observed = await observedStage(ctx, api, step, admission, step === "cleanup" ? released : null);
        const digest = await persistRecord(ctx, { operationId: ctx.operationId, bindingDigest: ctx.bindingDigest, step, attemptId, prerequisitesDigest, effectDispatch, evidence: observed });
        replay = await append(ctx, replay, "EFFECT_RESULT", { step, attemptId, outcome: "SUCCEEDED", evidenceDigest: digest, bindingDigest: ctx.bindingDigest });
      } catch (error) {
        if (dispatchStarted) error.status = "UNKNOWN";
        try {
          const current = boundReplay(await readReplay(ctx), ctx);
          if (current.pending?.attemptId === attemptId && current.pending.status === "INTENT") {
            const outcome = dispatchStarted || error.status === "UNKNOWN" || ["remotechecks", "readback", "cleanup"].includes(step) ? "UNKNOWN" : "NOT_APPLIED";
            const digest = await persistRecord(ctx, { operationId: ctx.operationId, bindingDigest: ctx.bindingDigest, step, attemptId, outcome, code: typeof error.code === "string" ? error.code : "ERC_OBSERVATION_INCOMPLETE" });
            await append(ctx, current, "EFFECT_RESULT", { step, attemptId, outcome, evidenceDigest: digest, bindingDigest: ctx.bindingDigest });
          }
        } catch (journalError) {
          // Trust drift may forbid an append. Keep the original UNKNOWN and
          // durable INTENT; recover() must reconcile it before another write.
          error.reconciliationRequired = true;
          error.journalRecordCode = typeof journalError.code === "string" ? journalError.code : "ERC_JOURNAL_INCOMPLETE";
        }
        throw error;
      }
      if (replay.operationStatus === "COMPLETE") {
        return Object.freeze({ status: "COMPLETE", operationId: ctx.operationId, channel: "rc", releaseVersion: ctx.releaseTarget.releaseVersion, publicCandidateSha: ctx.candidate.publicCandidateSha,
          repository: ctx.target.repository, w5HeadDigest: replay.headDigest, w5EventCount: replay.eventCount, gaAcceptance: "NOT_ESTABLISHED", releaseUrl: `https://github.com/${ctx.target.repository.name}/releases/tag/${ctx.releaseTarget.releaseTag}` });
      }
    }
    hold("ERC_STAGE_LIMIT", "Publication has remaining stages after its bounded execution");
  } finally {
    await lease.release();
  }
}
