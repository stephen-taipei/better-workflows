// SPDX-License-Identifier: AGPL-3.0-only
// Pure preparation for owner review. No install, account creation, launch,
// credential read, key generation, signature or service is performed here.
import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalJson } from "./core.mjs";
import { snapshotJsonDataV1 } from "./private-input-snapshot-v1.mjs";
import { parseStrictJsonV1 } from "./strict-json-v1.mjs";
import { FORMAL_FULL_PROFILE } from "./formal-operation.mjs";
import { FORMAL_PROTECTED_POLICY_PATH_V2, FORMAL_PROTECTED_ARTIFACT_ROOT_V2,
  FORMAL_PROTECTED_PURPOSE, FORMAL_PROTECTED_AUDIENCE } from "./formal-protected-admission-v1.mjs";

export const FORMAL_PROTECTED_PRIVATE_KEY_ROOT_V2 = "/private/var/db/better-workflows/formal-observer-keys-v2";
const SHA256 = /^[a-f0-9]{64}$/, SHA40 = /^[a-f0-9]{40}$/;
const absolute = value => typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);
const hash = value => createHash("sha256").update(value).digest("hex");
const REQUEST_KEYS = ["schemaVersion", "kind", "ownerContractReceiptSha256", "publicProjectionReceiptSha256", "publicTarget", "expectedBase",
  "executionSourceRoot", "controllerImage", "suiteIdentity", "issuer", "keyId", "ledgerEpoch", "runtimeLanes", "sourceManifest"];

export class FormalProtectedPreparationPendingError extends Error {
  constructor(message, fields = []) {
    super(message); this.name = "FormalProtectedPreparationPendingError";
    this.code = "EFORMAL_OBSERVER_OWNER_CONTRACT_PENDING"; this.status = "PENDING";
    this.installAuthorization = "INSTALL_NOT_AUTHORIZED"; this.fields = Object.freeze(fields);
  }
}
function pending(message, fields) { throw new FormalProtectedPreparationPendingError(message, fields); }
function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) pending(`${label} has missing or unexpected fields`, [label]);
}
function missingValues(value, prefix = "request") {
  if (value === null || value === undefined || value === "") return [prefix];
  if (typeof value !== "object") return [];
  if (Array.isArray(value) && value.length === 0) return [prefix];
  return Object.entries(value).flatMap(([key, item]) => missingValues(item, `${prefix}.${key}`));
}

/** Produce an exact, digest-bound review plan. This function cannot authorize
 * its plan, verify owner adoption, or replace the visible administrator step.
 */
export function prepareFormalProtectedObserverInstallV2(request) {
  let value;
  try { value = parseStrictJsonV1(JSON.stringify(snapshotJsonDataV1(request, { maxBytes: 1024 * 1024 })), { maxBytes: 1024 * 1024 }); }
  catch { pending("Formal observer preparation request cannot be captured safely", ["request"]); }
  exact(value, REQUEST_KEYS, "request");
  const missing = missingValues(value);
  if (missing.length) pending("Owner must freeze every exact installation and public projection value", missing);
  if (value.schemaVersion !== 2 || value.kind !== "FormalProtectedObserverProvisioningRequestV2") pending("Formal observer preparation schema is invalid", ["request.kind"]);
  for (const key of ["ownerContractReceiptSha256", "publicProjectionReceiptSha256", "ledgerEpoch"]) {
    if (!SHA256.test(value[key])) pending("Owner or public projection receipt is not exact", [`request.${key}`]);
  }
  exact(value.publicTarget, ["repository", "sourceRevision", "sourceRef"], "publicTarget");
  exact(value.publicTarget.repository, ["name", "id"], "publicTarget.repository");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.publicTarget.repository.name) ||
      typeof value.publicTarget.repository.id !== "string" || !/^[1-9][0-9]{0,31}$/.test(value.publicTarget.repository.id) || !SHA40.test(value.publicTarget.sourceRevision) ||
      value.publicTarget.sourceRef !== "refs/heads/main" || !SHA40.test(value.expectedBase) || !absolute(value.executionSourceRoot)) {
    pending("Exact public projection repository, numeric ID, commit, base, namespace and execution root must be frozen", ["publicTarget", "expectedBase", "executionSourceRoot"]);
  }
  exact(value.suiteIdentity, ["uid", "gid", "home"], "suiteIdentity");
  if (![value.suiteIdentity.uid, value.suiteIdentity.gid].every(id => Number.isSafeInteger(id) && id > 0) ||
      !absolute(value.suiteIdentity.home) || value.suiteIdentity.home === "/") pending("A dedicated nonroot suite identity must be frozen", ["suiteIdentity"]);
  if (typeof value.issuer !== "string" || typeof value.keyId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.issuer) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.keyId)) {
    pending("Dedicated formal issuer and key identity must be frozen", ["issuer", "keyId"]);
  }
  exact(value.controllerImage, ["root", "entrypoint", "manifestSha256", "provenanceRepositoryIdentity", "provenanceHead"], "controllerImage");
  const image = value.controllerImage;
  if (!absolute(image.root) || !absolute(image.entrypoint) || !image.entrypoint.startsWith(`${image.root}/`) ||
      !SHA256.test(image.manifestSha256) || !SHA40.test(image.provenanceHead) ||
      !/^github:github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(image.provenanceRepositoryIdentity) ||
      image.root === value.executionSourceRoot || image.root.startsWith(`${value.executionSourceRoot}/`) ||
      value.executionSourceRoot.startsWith(`${image.root}/`) || image.root === value.suiteIdentity.home ||
      image.root.startsWith(`${value.suiteIdentity.home}/`)) pending("Root-controlled controller image must be pinned and separate from the public workload and suite home", ["controllerImage"]);
  if (!Array.isArray(value.runtimeLanes) || value.runtimeLanes.length !== 2) pending("Both formal runtime lanes must be frozen", ["runtimeLanes"]);
  value.runtimeLanes.forEach((runtime, index) => {
    exact(runtime, ["id", "nodeVersion", "path", "executableSha256"], "runtime lane");
    const expected = FORMAL_FULL_PROFILE.lanes[index];
    if (runtime.id !== expected.id || runtime.nodeVersion !== expected.nodeVersion || !absolute(runtime.path) ||
        !SHA256.test(runtime.executableSha256)) pending("Formal runtime version, executable and digest must be pinned", [`runtimeLanes.${index}`]);
  });
  if (value.runtimeLanes[0].path === value.runtimeLanes[1].path) pending("Formal runtime executables must be distinct", ["runtimeLanes"]);
  if (!Array.isArray(value.sourceManifest) || value.sourceManifest.length < 1 || value.sourceManifest.length > 10000) pending("Exact controller installation file manifest is required", ["sourceManifest"]);
  const paths = [];
  for (const file of value.sourceManifest) {
    exact(file, ["path", "sha256"], "sourceManifest file");
    if (typeof file.path !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(file.path) || path.posix.normalize(file.path) !== file.path ||
        file.path.split("/").some(part => ["..", ".git", ".codex", ".aws", ".env"].includes(part)) || !SHA256.test(file.sha256)) pending("Controller installation manifest contains an unsafe or unpinned file", ["sourceManifest"]);
    paths.push(file.path);
  }
  if (!sameOrdered(paths, [...new Set(paths)].sort()) || !paths.includes(path.relative(image.root, image.entrypoint)) ||
      hash(Buffer.from(canonicalJson(value.sourceManifest))) !== image.manifestSha256) pending("Controller manifest must be complete, ordered, unique and bind its entrypoint", ["sourceManifest", "controllerImage.manifestSha256"]);
  const requestSha256 = hash(Buffer.from(canonicalJson(value)));
  const keyPath = path.join(FORMAL_PROTECTED_PRIVATE_KEY_ROOT_V2, `${value.keyId}.pkcs8`);
  const plan = { schemaVersion: 2, kind: "FormalProtectedObserverInstallPreparationV2", requestSha256,
    ownerContractReceiptSha256: value.ownerContractReceiptSha256, publicProjectionReceiptSha256: value.publicProjectionReceiptSha256,
    sourceRepositoryIdentity: `github:github.com/${value.publicTarget.repository.name}`, publicTarget: value.publicTarget,
    purpose: FORMAL_PROTECTED_PURPOSE, audience: FORMAL_PROTECTED_AUDIENCE,
    policyPath: FORMAL_PROTECTED_POLICY_PATH_V2, artifactRoot: FORMAL_PROTECTED_ARTIFACT_ROOT_V2,
    privateKeyPath: keyPath, controllerImage: value.controllerImage, executionSourceRoot: value.executionSourceRoot,
    suiteIdentity: value.suiteIdentity, runtimeLanes: value.runtimeLanes, issuer: value.issuer, keyId: value.keyId, ledgerEpoch: value.ledgerEpoch,
    actions: [
      { action: "VERIFY_PUBLIC_PROJECTION_AND_OWNER_CONTRACT_RECEIPTS", digests: [value.publicProjectionReceiptSha256, value.ownerContractReceiptSha256] },
      { action: "INSTALL_EXACT_ROOT_CONTROLLED_IMAGE", root: image.root, manifestSha256: image.manifestSha256, ownerUid: 0, groupOrOtherWritable: false, noAcl: true },
      { action: "GENERATE_FRESH_DEDICATED_ED25519_KEY_EXCLUSIVELY", path: keyPath, purpose: FORMAL_PROTECTED_PURPOSE, ownerUid: 0, mode: "0600", importExistingKey: false },
      { action: "CREATE_EXCLUSIVE_ROOT_OWNED_V2_POLICY", path: FORMAL_PROTECTED_POLICY_PATH_V2, ownerUid: 0, mode: "0644", requestSha256 },
      { action: "PREPARE_PROTECTED_IMMUTABLE_ATTEMPT_NAMESPACE", root: FORMAL_PROTECTED_ARTIFACT_ROOT_V2, repositoryId: value.publicTarget.repository.id, expectedHead: value.publicTarget.sourceRevision,
        ownerUid: 0, directoryMode: "0700", fileMode: "0600", preserveExistingHistory: true, overwriteExistingBundle: false }
    ],
    administratorApproval: { method: "visible-native-macos-administrator-dialog", exactRequestSha256: requestSha256, status: "INSTALL_NOT_AUTHORIZED" },
    producerStatus: "NOT_IMPLEMENTED", installationStatus: "PREPARATION_ONLY", authority: "none", releaseEligible: false };
  return Object.freeze({ ...plan, preparationSha256: hash(Buffer.from(canonicalJson(plan))) });
}
function sameOrdered(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
