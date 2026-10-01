import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const LICENSE_INVENTORY_SCHEMA_VERSION = 1;
export const LICENSE_INVENTORY_KIND = "better-workflows-license-inventory";

const SHA256 = /^[a-f0-9]{64}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\u0000).+$/;
const LICENSE_EXPRESSION = /^[A-Za-z0-9.-]+(?:\s+(?:AND|OR)\s+[A-Za-z0-9.-]+)*$/;
const SIMPLE_SPDX = new Set([
  "AGPL-3.0-only",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "GPL-3.0-only",
  "ISC",
  "LGPL-3.0-only",
  "MIT",
  "MPL-2.0",
  "LicenseRef-Proprietary"
]);
const MATERIAL_TYPES = new Set(["source", "template", "doc", "asset", "font", "generated", "binary", "bundled"]);
const SCOPES = new Set(["core", "apache-package", "proprietary-pack", "cloud-deferred", "notice-only", "test-only"]);
const DISPOSITIONS = new Set(["include", "hold", "exclude"]);
const ORIGIN_KINDS = new Set(["first-party", "upstream", "generated", "bundled", "unknown"]);
const RIGHTSHOLDER_KINDS = new Set(["project", "upstream", "contributor", "user", "unknown"]);
const RIGHTSHOLDER_EVIDENCE = new Set(["public-license-file", "upstream-license-file", "contributor-grant", "owner-record", "unknown"]);
const GRANT_KINDS = new Set(["spdx", "upstream-license", "contributor-grant", "proprietary", "unknown"]);
const CORE_ROOT = "plugins/better-workflows";
const OUTER_REQUIRED_KEYS = ["artifactPath", "artifactSha256", "kind", "manifestPath", "manifestSha256"];
const OUTER_OPTIONAL_KEYS = ["artifactBytes", "manifestBytes"];
const APACHE_SOURCE_MATERIALS = new Set(["source", "template", "generated"]);
const CORE_IMPORT_RE = /(?:^|[/@.-])(?:plugins\/better-workflows|better-workflows(?:\/core)?)(?:$|[/@.-])/i;

const TOP_KEYS = ["schemaVersion", "kind", "productVersion", "bindingMode", "policy", "files"];
const POLICY_KEYS = ["coreSpdx", "firstPartyMit", "apacheRequiresPhysicalIndependentPackage", "manifestHashMode"];
const FILE_KEYS = ["path", "sha256", "materialType", "origin", "rightsholder", "grant", "spdx", "publicScope", "disposition", "noticeRefs", "generatedFrom", "bundledFrom", "correspondingSource", "apacheEvidence"];
const ORIGIN_KEYS = ["kind", "sourcePath", "sourceSha256", "generatorPath", "generatorSha256", "sourceOffer"];
const OFFER_KEYS = ["name", "version", "spdx", "sourceUrl", "sha256"];
const RIGHTSHOLDER_KEYS = ["kind", "evidenceKind", "evidencePath", "evidenceSha256", "recordId"];
const GRANT_KEYS = ["kind", "spdx", "evidencePath", "evidenceSha256"];
const REF_KEYS = ["path", "sha256"];
const BUNDLED_KEYS = ["name", "version", "spdx", "sourceUrl", "sourceSha256"];
const APACHE_KEYS = ["packageRoot", "packageManifest", "buildReceipt", "closureReceipt"];
const GENERATED_KEYS = ["source", "generator"];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, at, errors) {
  if (!isObject(value)) {
    errors.push({ code: "SCHEMA_OBJECT", path: at, detail: "object required" });
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    const missing = wanted.filter((key) => !actual.includes(key));
    const extra = actual.filter((key) => !wanted.includes(key));
    errors.push({ code: "SCHEMA_KEYS", path: at, detail: `missing=${missing.join(",")};extra=${extra.join(",")}` });
    return false;
  }
  return true;
}

function requiredString(value, at, errors, { pattern = null } = {}) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    errors.push({ code: "SCHEMA_STRING", path: at, detail: "invalid string" });
    return false;
  }
  return true;
}

function nullableString(value, at, errors, { pattern = null } = {}) {
  if (value !== null && !requiredString(value, at, errors, { pattern })) return false;
  return true;
}

function digest(value, at, errors, nullable = false) {
  if (nullable && value === null) return true;
  if (typeof value !== "string" || !SHA256.test(value)) {
    errors.push({ code: "SCHEMA_DIGEST", path: at, detail: "sha256 required" });
    return false;
  }
  return true;
}

function safePath(value, at, errors, nullable = false) {
  if (nullable && value === null) return true;
  if (typeof value !== "string" || !SAFE_PATH.test(value)) {
    errors.push({ code: "PATH_UNSAFE", path: at, detail: "safe relative path required" });
    return false;
  }
  return true;
}

function licenseExpression(value, at, errors, nullable = false) {
  if (nullable && value === null) return true;
  if (typeof value !== "string" || !LICENSE_EXPRESSION.test(value)) {
    errors.push({ code: "SCHEMA_LICENSE", path: at, detail: "SPDX expression syntax is invalid" });
    return false;
  }
  return true;
}

function uri(value, at, errors) {
  try {
    const parsed = new URL(value);
    if (!parsed.protocol || !parsed.hostname) throw new Error("invalid");
  } catch {
    errors.push({ code: "SCHEMA_URI", path: at, detail: "absolute URL required" });
  }
}

function validateRef(value, at, errors) {
  if (!exactKeys(value, REF_KEYS, at, errors)) return;
  safePath(value.path, `${at}.path`, errors);
  digest(value.sha256, `${at}.sha256`, errors);
}

function validateOffer(value, at, errors) {
  if (!exactKeys(value, OFFER_KEYS, at, errors)) return;
  requiredString(value.name, `${at}.name`, errors, { pattern: /^[A-Za-z0-9._/@+-]{1,160}$/ });
  requiredString(value.version, `${at}.version`, errors, { pattern: /^\S{1,160}$/ });
  licenseExpression(value.spdx, `${at}.spdx`, errors);
  requiredString(value.sourceUrl, `${at}.sourceUrl`, errors);
  uri(value.sourceUrl, `${at}.sourceUrl`, errors);
  digest(value.sha256, `${at}.sha256`, errors);
}

function validateLicenseFile(value, at, errors) {
  if (!exactKeys(value, FILE_KEYS, at, errors)) return;
  safePath(value.path, `${at}.path`, errors);
  digest(value.sha256, `${at}.sha256`, errors);
  requiredString(value.materialType, `${at}.materialType`, errors);
  if (!MATERIAL_TYPES.has(value.materialType)) errors.push({ code: "SCHEMA_ENUM", path: `${at}.materialType`, detail: "unsupported material type" });

  if (exactKeys(value.origin, ORIGIN_KEYS, `${at}.origin`, errors)) {
    if (!ORIGIN_KINDS.has(value.origin.kind)) errors.push({ code: "SCHEMA_ENUM", path: `${at}.origin.kind`, detail: "unsupported origin kind" });
    safePath(value.origin.sourcePath, `${at}.origin.sourcePath`, errors, true);
    digest(value.origin.sourceSha256, `${at}.origin.sourceSha256`, errors, true);
    safePath(value.origin.generatorPath, `${at}.origin.generatorPath`, errors, true);
    digest(value.origin.generatorSha256, `${at}.origin.generatorSha256`, errors, true);
    if (value.origin.sourceOffer !== null) validateOffer(value.origin.sourceOffer, `${at}.origin.sourceOffer`, errors);
  }
  if (exactKeys(value.rightsholder, RIGHTSHOLDER_KEYS, `${at}.rightsholder`, errors)) {
    if (!RIGHTSHOLDER_KINDS.has(value.rightsholder.kind)) errors.push({ code: "SCHEMA_ENUM", path: `${at}.rightsholder.kind`, detail: "unsupported rightsholder kind" });
    if (!RIGHTSHOLDER_EVIDENCE.has(value.rightsholder.evidenceKind)) errors.push({ code: "SCHEMA_ENUM", path: `${at}.rightsholder.evidenceKind`, detail: "unsupported evidence kind" });
    safePath(value.rightsholder.evidencePath, `${at}.rightsholder.evidencePath`, errors, true);
    digest(value.rightsholder.evidenceSha256, `${at}.rightsholder.evidenceSha256`, errors, true);
    if (value.rightsholder.recordId !== null) requiredString(value.rightsholder.recordId, `${at}.rightsholder.recordId`, errors, { pattern: /^private:[A-Za-z0-9._-]{1,128}$/ });
  }
  if (exactKeys(value.grant, GRANT_KEYS, `${at}.grant`, errors)) {
    if (!GRANT_KINDS.has(value.grant.kind)) errors.push({ code: "SCHEMA_ENUM", path: `${at}.grant.kind`, detail: "unsupported grant kind" });
    licenseExpression(value.grant.spdx, `${at}.grant.spdx`, errors, true);
    safePath(value.grant.evidencePath, `${at}.grant.evidencePath`, errors, true);
    digest(value.grant.evidenceSha256, `${at}.grant.evidenceSha256`, errors, true);
  }
  licenseExpression(value.spdx, `${at}.spdx`, errors, true);
  if (!SCOPES.has(value.publicScope)) errors.push({ code: "SCHEMA_ENUM", path: `${at}.publicScope`, detail: "unsupported public scope" });
  if (!DISPOSITIONS.has(value.disposition)) errors.push({ code: "SCHEMA_ENUM", path: `${at}.disposition`, detail: "unsupported disposition" });
  if (!Array.isArray(value.noticeRefs) || value.noticeRefs.some((item) => typeof item !== "string" || !SAFE_PATH.test(item)) || new Set(value.noticeRefs).size !== value.noticeRefs.length) {
    errors.push({ code: "SCHEMA_NOTICE_REFS", path: `${at}.noticeRefs`, detail: "unique safe notice paths required" });
  }
  if (value.generatedFrom !== null) {
    if (!exactKeys(value.generatedFrom, GENERATED_KEYS, `${at}.generatedFrom`, errors)) return;
    validateRef(value.generatedFrom.source, `${at}.generatedFrom.source`, errors);
    validateRef(value.generatedFrom.generator, `${at}.generatedFrom.generator`, errors);
  }
  if (value.bundledFrom !== null) {
    if (!exactKeys(value.bundledFrom, BUNDLED_KEYS, `${at}.bundledFrom`, errors)) return;
    requiredString(value.bundledFrom.name, `${at}.bundledFrom.name`, errors, { pattern: /^[A-Za-z0-9._/@+-]{1,160}$/ });
    requiredString(value.bundledFrom.version, `${at}.bundledFrom.version`, errors, { pattern: /^\S{1,160}$/ });
    licenseExpression(value.bundledFrom.spdx, `${at}.bundledFrom.spdx`, errors);
    requiredString(value.bundledFrom.sourceUrl, `${at}.bundledFrom.sourceUrl`, errors);
    uri(value.bundledFrom.sourceUrl, `${at}.bundledFrom.sourceUrl`, errors);
    digest(value.bundledFrom.sourceSha256, `${at}.bundledFrom.sourceSha256`, errors);
  }
  if (value.correspondingSource !== null) validateRef(value.correspondingSource, `${at}.correspondingSource`, errors);
  if (value.apacheEvidence !== null) {
    if (!exactKeys(value.apacheEvidence, APACHE_KEYS, `${at}.apacheEvidence`, errors)) return;
    safePath(value.apacheEvidence.packageRoot, `${at}.apacheEvidence.packageRoot`, errors);
    validateRef(value.apacheEvidence.packageManifest, `${at}.apacheEvidence.packageManifest`, errors);
    validateRef(value.apacheEvidence.buildReceipt, `${at}.apacheEvidence.buildReceipt`, errors);
    validateRef(value.apacheEvidence.closureReceipt, `${at}.apacheEvidence.closureReceipt`, errors);
  }
}

export function validateLicenseInventoryShape(inventory) {
  const errors = [];
  if (!exactKeys(inventory, TOP_KEYS, "inventory", errors)) return errors;
  if (inventory.schemaVersion !== LICENSE_INVENTORY_SCHEMA_VERSION) errors.push({ code: "SCHEMA_VERSION", path: "inventory.schemaVersion", detail: "unsupported schema version" });
  if (inventory.kind !== LICENSE_INVENTORY_KIND) errors.push({ code: "SCHEMA_KIND", path: "inventory.kind", detail: "unexpected inventory kind" });
  if (typeof inventory.productVersion !== "string" || !SEMVER.test(inventory.productVersion)) errors.push({ code: "SCHEMA_VERSION", path: "inventory.productVersion", detail: "semver required" });
  if (inventory.bindingMode !== "external-envelope") errors.push({ code: "SCHEMA_BINDING", path: "inventory.bindingMode", detail: "external-envelope required" });
  if (exactKeys(inventory.policy, POLICY_KEYS, "inventory.policy", errors)) {
    if (inventory.policy.coreSpdx !== "AGPL-3.0-only") errors.push({ code: "SCHEMA_POLICY", path: "inventory.policy.coreSpdx", detail: "V5 core policy mismatch" });
    if (inventory.policy.firstPartyMit !== "forbidden") errors.push({ code: "SCHEMA_POLICY", path: "inventory.policy.firstPartyMit", detail: "first-party MIT must be forbidden" });
    if (inventory.policy.apacheRequiresPhysicalIndependentPackage !== true) errors.push({ code: "SCHEMA_POLICY", path: "inventory.policy.apacheRequiresPhysicalIndependentPackage", detail: "physical Apache boundary required" });
    if (inventory.policy.manifestHashMode !== "external-envelope") errors.push({ code: "SCHEMA_POLICY", path: "inventory.policy.manifestHashMode", detail: "external envelope required" });
  }
  if (!Array.isArray(inventory.files) || inventory.files.length === 0) errors.push({ code: "SCHEMA_FILES", path: "inventory.files", detail: "non-empty file inventory required" });
  else inventory.files.forEach((file, index) => validateLicenseFile(file, `inventory.files[${index}]`, errors));
  return errors;
}

function issue(results, name, code, affectedPath, detail = "") {
  const item = { code, path: affectedPath };
  if (detail) item.detail = detail;
  if (!results[name].some((existing) => existing.code === code && existing.path === affectedPath && existing.detail === item.detail)) results[name].push(item);
}

function normalizeBytes(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeUniverseEntry(raw, index, options, results) {
  if (!isObject(raw)) {
    issue(results, "schemaErrors", "UNIVERSE_ENTRY", `[${index}]`, "object required");
    return null;
  }
  const entryPath = raw.path;
  if (!safePathValue(entryPath)) {
    issue(results, "boundaryIssues", "PATH_UNSAFE", typeof entryPath === "string" ? entryPath : `[${index}]`);
    if (raw.absolutePath !== undefined) issue(results, "boundaryIssues", "TRAVERSAL_DISTRIBUTION_PATH", typeof entryPath === "string" ? entryPath : `[${index}]`);
    return null;
  }
  if (!MATERIAL_TYPES.has(raw.materialType)) {
    issue(results, "schemaErrors", "UNIVERSE_TYPE", entryPath, "materialType required");
    return null;
  }
  let bytes = normalizeBytes(raw.content ?? raw.bytes);
  let absolutePath = null;
  if (raw.absolutePath !== undefined) {
    if (typeof options.rootDir !== "string" || !path.isAbsolute(options.rootDir) || typeof raw.absolutePath !== "string" || !path.isAbsolute(raw.absolutePath)) {
      issue(results, "boundaryIssues", "ROOT_PATH_INVALID", entryPath);
    } else {
      try {
        const root = realpathSync(options.rootDir);
        absolutePath = path.resolve(raw.absolutePath);
        const stat = lstatSync(absolutePath);
        if (stat.isSymbolicLink()) issue(results, "boundaryIssues", "SYMLINK_DISTRIBUTION_PATH", entryPath);
        const resolved = realpathSync(absolutePath);
        const withinRoot = insideRoot(root, resolved);
        if (!withinRoot) issue(results, "boundaryIssues", "TRAVERSAL_DISTRIBUTION_PATH", entryPath);
        const expectedPath = path.resolve(root, entryPath);
        if (resolved !== expectedPath) issue(results, "boundaryIssues", "PATH_MAPPING_MISMATCH", entryPath);
        if (withinRoot && !stat.isSymbolicLink()) {
          const fileBytes = readFileSync(absolutePath);
          if (bytes && hashBytes(bytes) !== hashBytes(fileBytes)) issue(results, "contentDrift", "UNIVERSE_INPUT_MISMATCH", entryPath);
          bytes = fileBytes;
        } else {
          bytes = null;
        }
      } catch {
        issue(results, "boundaryIssues", "PATH_READ_FAILED", entryPath);
        bytes = null;
      }
    }
  }
  const expected = raw.sha256;
  if (typeof expected !== "string" || !SHA256.test(expected)) issue(results, "schemaErrors", "UNIVERSE_DIGEST", entryPath, "sha256 required");
  if (!bytes) issue(results, "boundaryIssues", "UNVERIFIED_CONTENT", entryPath, "distribution entry needs content bytes or a readable regular file");
  const actual = bytes ? hashBytes(bytes) : null;
  if (bytes && expected && actual !== expected) issue(results, "contentDrift", "UNIVERSE_CONTENT_DRIFT", entryPath);
  let parsedJson = null;
  if (bytes && /\.json$/i.test(entryPath)) {
    try { parsedJson = JSON.parse(bytes.toString("utf8")); } catch { parsedJson = null; }
  }
  return { path: entryPath, materialType: raw.materialType, sha256: actual, bytes, parsedJson, absolutePath };
}

function safePathValue(value) {
  return typeof value === "string" && SAFE_PATH.test(value);
}

function compareRef(ref, label, universe, results, affectedPath = label) {
  if (!isObject(ref) || !safePathValue(ref.path) || !SHA256.test(ref.sha256)) {
    issue(results, "sourceBindingIssues", "REF_INVALID", affectedPath, label);
    return null;
  }
  const target = universe.get(ref.path);
  if (!target) {
    issue(results, "sourceBindingIssues", "REF_MISSING", affectedPath, `${label}:${ref.path}`);
    return null;
  }
  if (target.sha256 !== ref.sha256) issue(results, "contentDrift", "REF_CONTENT_DRIFT", affectedPath, `${label}:${ref.path}`);
  return target;
}

function compareNotice(ref, label, universe, results) {
  if (!safePathValue(ref)) {
    issue(results, "noticeIssues", "NOTICE_PATH_UNSAFE", label);
    return null;
  }
  const target = universe.get(ref);
  if (!target) {
    issue(results, "noticeIssues", "NOTICE_MISSING", label, ref);
    return null;
  }
  if (target.materialType !== "doc") issue(results, "noticeIssues", "NOTICE_NOT_DOCUMENT", label, ref);
  return target;
}

function addUnknown(results, file, code = "UNKNOWN_RIGHTS") {
  issue(results, "unknownRights", code, file.path);
}

function checkJsonReceipt(ref, expectedKind, universe, results, filePath) {
  const target = compareRef(ref, `${filePath}.apacheEvidence`, universe, results, filePath);
  if (!target?.parsedJson || (expectedKind !== null && target.parsedJson.kind !== expectedKind)) {
    issue(results, "boundaryIssues", "APACHE_EVIDENCE_INVALID", filePath, expectedKind);
    return null;
  }
  return target.parsedJson;
}

function verifiedAnswerMatches(answer, expectedFields) {
  try {
    return isObject(answer) && answer.verified === true && expectedFields.every(([key, expected]) => answer[key] === expected);
  } catch {
    return false;
  }
}

function apacheUniverseBinding(root, universe) {
  const files = [...universe.values()]
    .filter((target) => target.path === root || target.path.startsWith(`${root}/`))
    .map((target) => ({ path: target.path, sha256: target.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return { files, sha256: hashBytes(Buffer.from(JSON.stringify(files), "utf8")) };
}

function verifyApacheClosure(root, evidence, manifestRef, buildRef, closureRef, manifest, build, closure, universe, results, filePath, verifier) {
  if (typeof verifier !== "function") {
    issue(results, "boundaryIssues", "APACHE_CLOSURE_UNVERIFIED", filePath, "external source-closure verifier is required");
    return;
  }
  const packageFiles = apacheUniverseBinding(root, universe);
  const targetFor = (ref) => universe.get(ref.path);
  const actual = {
    packageRoot: root,
    packageFiles: packageFiles.files,
    packageFilesSha256: packageFiles.sha256,
    manifest: { path: manifestRef.path, sha256: targetFor(manifestRef)?.sha256 ?? null },
    build: { path: buildRef.path, sha256: targetFor(buildRef)?.sha256 ?? null },
    closure: { path: closureRef.path, sha256: targetFor(closureRef)?.sha256 ?? null },
    manifestReceipt: manifest,
    buildReceipt: build,
    closureReceipt: closure
  };
  let answer = null;
  try { answer = verifier(actual); } catch { answer = null; }
  const valid = verifiedAnswerMatches(answer, [
    ["packageFilesSha256", actual.packageFilesSha256],
    ["manifestSha256", actual.manifest.sha256],
    ["buildSha256", actual.build.sha256],
    ["closureSha256", actual.closure.sha256]
  ]);
  if (!valid) issue(results, "boundaryIssues", "APACHE_CLOSURE_UNVERIFIED", filePath, "external attestation did not bind actual package files and receipts");
}

function checkApache(file, universe, results, { apacheClosureVerifier = null } = {}) {
  if (file.publicScope !== "apache-package") return;
  const evidence = file.apacheEvidence;
  if (!evidence) {
    issue(results, "boundaryIssues", "APACHE_INDEPENDENT_PACKAGE_EVIDENCE_MISSING", file.path);
    return;
  }
  const root = evidence.packageRoot;
  if (!(file.path === root || file.path.startsWith(`${root}/`)) || root === CORE_ROOT || root.startsWith(`${CORE_ROOT}/`)) {
    issue(results, "boundaryIssues", "APACHE_PACKAGE_ROOT_INVALID", file.path);
  }
  if (file.origin.sourcePath && (file.origin.sourcePath === CORE_ROOT || file.origin.sourcePath.startsWith(`${CORE_ROOT}/`))) {
    issue(results, "boundaryIssues", "APACHE_CORE_SOURCE_BOUNDARY", file.path);
  }
  if (file.spdx === "AGPL-3.0-only" || file.grant.spdx === "AGPL-3.0-only") issue(results, "boundaryIssues", "APACHE_AGPL_REEXPORT", file.path);
  if (file.origin.kind === "first-party" && file.spdx !== "Apache-2.0") issue(results, "boundaryIssues", "APACHE_FIRST_PARTY_LICENSE_MISMATCH", file.path);
  const manifest = checkJsonReceipt(evidence.packageManifest, null, universe, results, file.path);
  const build = checkJsonReceipt(evidence.buildReceipt, "better-workflows-apache-independent-build", universe, results, file.path);
  const closure = checkJsonReceipt(evidence.closureReceipt, "better-workflows-apache-closure", universe, results, file.path);
  if (manifest && (manifest.license !== "Apache-2.0" || (manifest.packageRoot !== undefined && manifest.packageRoot !== root))) issue(results, "boundaryIssues", "APACHE_MANIFEST_MISMATCH", file.path);
  if (build && (build.packageRoot !== root || build.independent !== true || !Array.isArray(build.coreImports) || build.coreImports.length !== 0 || !Array.isArray(build.indirectCoreImports) || build.indirectCoreImports.length !== 0)) issue(results, "boundaryIssues", "APACHE_BUILD_NOT_INDEPENDENT", file.path);
  if (closure && (closure.packageRoot !== root || !Array.isArray(closure.coreImports) || closure.coreImports.length !== 0 || !Array.isArray(closure.indirectCoreImports) || closure.indirectCoreImports.length !== 0)) issue(results, "boundaryIssues", "APACHE_CLOSURE_CORE_IMPORT", file.path);
  verifyApacheClosure(root, evidence, evidence.packageManifest, evidence.buildReceipt, evidence.closureReceipt, manifest, build, closure, universe, results, file.path, apacheClosureVerifier);
}

function verifiedUniverseRef(ref, universe) {
  if (!(universe instanceof Map) || !isObject(ref) || !safePathValue(ref.path) || !SHA256.test(ref.sha256)) return null;
  const target = universe.get(ref.path);
  if (!target || !target.bytes || target.sha256 !== ref.sha256) return null;
  return target;
}

function verifiedNoticeRefs(noticeRefs, universe) {
  return universe instanceof Map && Array.isArray(noticeRefs) && noticeRefs.length > 0 && noticeRefs.every((ref) => {
    if (!safePathValue(ref)) return false;
    const target = universe.get(ref);
    return Boolean(target?.bytes) && target.materialType === "doc";
  });
}

function verifiedRightsEvidence(file, universe) {
  return Boolean(
    verifiedUniverseRef({ path: file.rightsholder.evidencePath, sha256: file.rightsholder.evidenceSha256 }, universe)
    && verifiedUniverseRef({ path: file.grant.evidencePath, sha256: file.grant.evidenceSha256 }, universe)
  );
}

function hasVerifiedGeneratedUpstreamRights(file, universe, inventoryByPath) {
  if (file.origin.kind !== "generated" || !(universe instanceof Map)) return false;
  if (file.rightsholder.kind !== "upstream" || file.grant.kind !== "upstream-license") return false;
  if (!isObject(file.origin.sourceOffer) || !isObject(file.generatedFrom)) return false;
  const sourceRef = file.generatedFrom.source;
  const generatorRef = file.generatedFrom.generator;
  const source = verifiedUniverseRef(sourceRef, universe);
  const sourceRecord = inventoryByPath?.get(sourceRef?.path);
  if (!source || !sourceRecord || sourceRecord.sha256 !== sourceRef.sha256 || sourceRecord.origin.kind !== "upstream") return false;
  if (sourceRecord.rightsholder.kind !== "upstream" || sourceRecord.grant.kind !== "upstream-license") return false;
  if (!isObject(sourceRecord.origin.sourceOffer) || stableJson(sourceRecord.origin.sourceOffer) !== stableJson(file.origin.sourceOffer)) return false;
  if (sourceRecord.spdx !== file.spdx || sourceRecord.grant.spdx !== file.grant.spdx) return false;
  if (!verifiedUniverseRef(generatorRef, universe)) return false;
  const sourceBindingValid = (file.origin.sourcePath === null && file.origin.sourceSha256 === null)
    || (file.origin.sourcePath === sourceRef.path && file.origin.sourceSha256 === sourceRef.sha256);
  if (!sourceBindingValid) return false;
  if (!verifiedNoticeRefs(sourceRecord.noticeRefs, universe) || !verifiedNoticeRefs(file.noticeRefs, universe)) return false;
  return verifiedRightsEvidence(sourceRecord, universe) && verifiedRightsEvidence(file, universe);
}

function stripMarkdownQuotedAndFenced(filePath, text) {
  if (!/\.(?:md|markdown)$/i.test(filePath)) return text;
  const kept = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      const markerChar = marker[1][0];
      if (fence === null) fence = markerChar;
      else if (fence === markerChar) fence = null;
      continue;
    }
    if (fence !== null || /^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

function isMitSpdxPayload(value) {
  const payload = value.replace(/\s*(?:\*\/|-->)\s*$/, "").trim();
  return /^SPDX-License-Identifier:\s*MIT(?:\s+(?:AND|OR)\s+[A-Za-z0-9.-]+)*$/i.test(payload);
}

function hasSpdxMitDeclaration(filePath, text) {
  const scanText = stripMarkdownQuotedAndFenced(filePath, text);
  let inBlockComment = false;
  let inHtmlComment = false;
  for (const rawLine of scanText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (inBlockComment) {
      if (isMitSpdxPayload(line.replace(/^\*\s?/, ""))) return true;
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (inHtmlComment) {
      if (isMitSpdxPayload(line)) return true;
      if (line.includes("-->")) inHtmlComment = false;
      continue;
    }
    if (line.startsWith("/*")) {
      const payload = line.slice(2).trim();
      if (isMitSpdxPayload(payload)) return true;
      if (!payload.includes("*/")) inBlockComment = true;
      continue;
    }
    if (line.startsWith("<!--")) {
      const payload = line.slice(4).trim();
      if (isMitSpdxPayload(payload)) return true;
      if (!payload.includes("-->")) inHtmlComment = true;
      continue;
    }
    if (line.startsWith("//") && isMitSpdxPayload(line.slice(2))) return true;
    if (line.startsWith("#") && isMitSpdxPayload(line.slice(1))) return true;
    if (line.startsWith("--") && isMitSpdxPayload(line.slice(2))) return true;
    if (isMitSpdxPayload(line)) return true;
  }
  return false;
}

function hasLicenseDeclaration(file, target, universe, inventoryByPath) {
  const projectOwned = file.origin.kind === "first-party"
    || (file.origin.kind === "generated" && !hasVerifiedGeneratedUpstreamRights(file, universe, inventoryByPath));
  if (!projectOwned) return false;
  if (file.spdx === "MIT") return true;
  if (!target?.bytes) return false;
  const text = target.bytes.toString("utf8");
  if (/package\.json$/i.test(file.path)) {
    try {
      const metadata = JSON.parse(text);
      if (metadata && metadata.license === "MIT") return true;
    } catch {
      // The ordinary content/hash checks report malformed JSON elsewhere.
    }
  }
  const basename = file.path.split("/").at(-1) ?? "";
  const declarationText = stripMarkdownQuotedAndFenced(file.path, text);
  if (/^(?:LICENSE|LICENCE|COPYING)(?:[._-].*)?$/i.test(basename) && /^\s*MIT License\s*$/im.test(declarationText)) return true;
  if (/^\s*(?:license|licence)\s*[:\-]\s*MIT(?:\s+License)?\s*$/im.test(declarationText)) return true;
  if (hasSpdxMitDeclaration(file.path, text)) return true;
  if (/\[!\[[^\]]*license[^\]]*\]\([^)]*\)\]\([^)]*\bMIT\b[^)]*\)/i.test(declarationText)) return true;
  return false;
}

function checkFile(file, universe, results, { privateEvidenceResolver = null, apacheClosureVerifier = null, inventoryByPath = null } = {}) {
  const target = universe.get(file.path);
  if (!target) return;
  if (target.sha256 !== file.sha256) issue(results, "contentDrift", "CONTENT_DRIFT", file.path);
  if (target.materialType !== file.materialType) issue(results, "contentDrift", "TYPE_DRIFT", file.path);
  if (file.spdx !== file.grant.spdx) issue(results, "unknownRights", "SPDX_GRANT_MISMATCH", file.path);
  if (file.publicScope === "core" && ["first-party", "generated"].includes(file.origin.kind) && file.spdx !== "AGPL-3.0-only") {
    issue(results, "boundaryIssues", "CORE_LICENSE_MISMATCH", file.path);
  }
  if (file.publicScope === "proprietary-pack" && (file.spdx !== "LicenseRef-Proprietary" || file.grant.kind !== "proprietary")) issue(results, "boundaryIssues", "PROPRIETARY_LICENSE_MISMATCH", file.path);
  if (file.publicScope === "cloud-deferred" && file.disposition === "include") issue(results, "boundaryIssues", "CLOUD_NOT_CORE_RELEASE", file.path);
  if (file.disposition === "exclude") issue(results, "boundaryIssues", "EXCLUDED_DISTRIBUTION_PATH", file.path);
  else if (file.disposition !== "include") issue(results, "boundaryIssues", "UNRESOLVED_DISTRIBUTION_DISPOSITION", file.path);
  if (!SIMPLE_SPDX.has(file.spdx)) addUnknown(results, file, "UNSUPPORTED_SPDX");
  if (file.rightsholder.kind === "unknown" || file.grant.kind === "unknown" || file.rightsholder.evidenceKind === "unknown" || file.spdx === null) addUnknown(results, file);
  if (file.rightsholder.evidenceKind === "public-license-file" || file.rightsholder.evidenceKind === "upstream-license-file") {
    if (!file.rightsholder.evidencePath || !file.rightsholder.evidenceSha256) addUnknown(results, file, "RIGHTSHOLDER_EVIDENCE_MISSING");
    else compareRef({ path: file.rightsholder.evidencePath, sha256: file.rightsholder.evidenceSha256 }, `${file.path}.rightsholder`, universe, results, file.path);
  }
  if (["contributor-grant", "owner-record"].includes(file.rightsholder.evidenceKind)) {
    if (!file.rightsholder.recordId) addUnknown(results, file, "RIGHTSHOLDER_RECORD_MISSING");
    else if (typeof privateEvidenceResolver !== "function") addUnknown(results, file, "PRIVATE_RIGHTS_UNRESOLVED");
    else {
      let resolved = false;
      try {
        const answer = privateEvidenceResolver(file.rightsholder.recordId);
        resolved = answer === true || (isObject(answer) && answer.approved === true && answer.recordId === file.rightsholder.recordId);
      } catch {
        resolved = false;
      }
      if (!resolved) addUnknown(results, file, "PRIVATE_RIGHTS_UNRESOLVED");
    }
  }
  if (["spdx", "upstream-license", "proprietary"].includes(file.grant.kind)) {
    if (!file.grant.evidencePath || !file.grant.evidenceSha256) addUnknown(results, file, "GRANT_EVIDENCE_MISSING");
    else compareRef({ path: file.grant.evidencePath, sha256: file.grant.evidenceSha256 }, `${file.path}.grant`, universe, results, file.path);
  }
  if (file.grant.kind === "contributor-grant") {
    if (!file.grant.evidencePath || !file.grant.evidenceSha256) addUnknown(results, file, "CONTRIBUTOR_GRANT_EVIDENCE_MISSING");
    else compareRef({ path: file.grant.evidencePath, sha256: file.grant.evidenceSha256 }, `${file.path}.grant`, universe, results, file.path);
    // A source-tree reference alone cannot establish a private contributor's
    // authorization. V1 has no grant-specific trusted private record binding.
    addUnknown(results, file, "CONTRIBUTOR_GRANT_UNVERIFIED");
  }
  if (["upstream", "bundled"].includes(file.origin.kind)) {
    if (!file.origin.sourceOffer || file.rightsholder.kind !== "upstream" || file.grant.kind !== "upstream-license" || file.noticeRefs.length === 0) addUnknown(results, file, "UPSTREAM_RIGHTS_INCOMPLETE");
    for (const ref of file.noticeRefs) compareNotice(ref, file.path, universe, results);
  }
  if (file.origin.kind === "unknown") addUnknown(results, file, "ORIGIN_UNKNOWN");
  if (file.origin.kind === "generated" || file.materialType === "generated") {
    if (!file.generatedFrom) {
      issue(results, "sourceBindingIssues", "GENERATED_SOURCE_MISSING", file.path);
      addUnknown(results, file, "GENERATED_SOURCE_MISSING");
    } else {
      compareRef(file.generatedFrom.source, `${file.path}.generatedFrom.source`, universe, results, file.path);
      compareRef(file.generatedFrom.generator, `${file.path}.generatedFrom.generator`, universe, results, file.path);
      if (file.origin.sourcePath && (file.origin.sourcePath !== file.generatedFrom.source.path || file.origin.sourceSha256 !== file.generatedFrom.source.sha256)) issue(results, "sourceBindingIssues", "GENERATED_ORIGIN_MISMATCH", file.path);
    }
  }
  if (file.origin.kind === "bundled" || file.materialType === "bundled") {
    if (!file.bundledFrom) {
      issue(results, "bundledIssues", "BUNDLED_PROVENANCE_MISSING", file.path);
      addUnknown(results, file, "BUNDLED_PROVENANCE_MISSING");
    } else if (file.origin.sourceOffer) {
      const keys = ["name", "version", "spdx", "sha256"];
      if (keys.some((key) => file.origin.sourceOffer[key] !== (key === "sha256" ? file.bundledFrom.sourceSha256 : file.bundledFrom[key]))) issue(results, "bundledIssues", "SOURCE_OFFER_VERSION_MISMATCH", file.path);
    }
  }
  if (["binary", "bundled"].includes(file.materialType) && !file.correspondingSource) {
    issue(results, "sourceBindingIssues", "CORRESPONDING_SOURCE_MISSING", file.path);
    addUnknown(results, file, "CORRESPONDING_SOURCE_MISSING");
  }
  if (file.correspondingSource) compareRef(file.correspondingSource, `${file.path}.correspondingSource`, universe, results, file.path);
  if (hasLicenseDeclaration(file, target, universe, inventoryByPath)) issue(results, "projectMIT", "FIRST_PARTY_MIT", file.path);
  checkApache(file, universe, results, { apacheClosureVerifier });
}

function emptyResults() {
  return {
    schemaErrors: [],
    missing: [],
    extra: [],
    duplicates: [],
    contentDrift: [],
    unknownRights: [],
    projectMIT: [],
    boundaryIssues: [],
    sourceBindingIssues: [],
    bundledIssues: [],
    noticeIssues: []
  };
}

function readRootFile(rootDir, relativePath, results, label) {
  if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) return null;
  try {
    const root = realpathSync(rootDir);
    const candidate = path.resolve(root, relativePath);
    if (!insideRoot(root, candidate)) {
      issue(results, "boundaryIssues", "OUTER_BINDING_PATH_ESCAPE", label);
      return null;
    }
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      issue(results, "boundaryIssues", "OUTER_BINDING_PATH_UNSAFE", label);
      return null;
    }
    const resolved = realpathSync(candidate);
    if (!insideRoot(root, resolved)) {
      issue(results, "boundaryIssues", "OUTER_BINDING_PATH_ESCAPE", label);
      return null;
    }
    return readFileSync(candidate);
  } catch {
    issue(results, "boundaryIssues", "OUTER_BINDING_PATH_READ_FAILED", label);
    return null;
  }
}

function validateOuterBinding(binding, inventory, universePaths, results, options) {
  if (!isObject(binding)) {
    issue(results, "schemaErrors", "OUTER_BINDING_MISSING", "outerBinding");
    return;
  }
  const keys = Object.keys(binding).sort();
  const allowedKeys = [...OUTER_REQUIRED_KEYS, ...OUTER_OPTIONAL_KEYS].sort();
  const missingKeys = OUTER_REQUIRED_KEYS.filter((key) => !keys.includes(key));
  const extraKeys = keys.filter((key) => !allowedKeys.includes(key));
  if (missingKeys.length || extraKeys.length) issue(results, "schemaErrors", "OUTER_BINDING_KEYS", "outerBinding", `missing=${missingKeys.join(",")};extra=${extraKeys.join(",")}`);
  if (binding.kind !== "license-inventory-envelope") issue(results, "schemaErrors", "OUTER_BINDING_KIND", "outerBinding.kind");
  for (const key of ["manifestPath", "artifactPath"]) if (!safePathValue(binding[key])) issue(results, "boundaryIssues", "OUTER_BINDING_PATH_UNSAFE", `outerBinding.${key}`);
  for (const key of ["manifestSha256", "artifactSha256"]) if (!SHA256.test(binding[key] ?? "")) issue(results, "schemaErrors", "OUTER_BINDING_DIGEST", `outerBinding.${key}`);
  if (binding.manifestPath === binding.artifactPath) issue(results, "boundaryIssues", "MANIFEST_ARTIFACT_CYCLE", "outerBinding");
  if (Array.isArray(inventory.files) && inventory.files.some((file) => isObject(file) && (file.path === binding.manifestPath || file.path === binding.artifactPath))) issue(results, "boundaryIssues", "MANIFEST_IN_COVERAGE_SET", binding.manifestPath);
  if (universePaths.has(binding.manifestPath) || universePaths.has(binding.artifactPath)) {
    // The outer envelope owns these artifacts. They are deliberately excluded from coverage below.
  }

  const actualBinding = { manifestBytes: null, artifactBytes: null };
  for (const [kind, pathKey, digestKey, bytesKey] of [
    ["manifest", "manifestPath", "manifestSha256", "manifestBytes"],
    ["artifact", "artifactPath", "artifactSha256", "artifactBytes"]
  ]) {
    const supplied = normalizeBytes(binding[bytesKey]);
    const actual = supplied ?? readRootFile(options.rootDir, binding[pathKey], results, `outerBinding.${pathKey}`);
    if (!actual) {
      issue(results, "boundaryIssues", "OUTER_BINDING_UNVERIFIED", binding[pathKey], `${kind} bytes or a readable root file are required`);
    } else if (SHA256.test(binding[digestKey] ?? "") && hashBytes(actual) !== binding[digestKey]) {
      issue(results, "contentDrift", "OUTER_BINDING_CONTENT_DRIFT", binding[pathKey]);
    } else {
      actualBinding[bytesKey] = actual;
      if (kind === "manifest") {
        let parsed = null;
        try { parsed = JSON.parse(actual.toString("utf8")); } catch { parsed = null; }
        if (!parsed || stableJson(parsed) !== stableJson(inventory)) issue(results, "boundaryIssues", "OUTER_MANIFEST_MISMATCH", binding[pathKey], parsed ? "manifest JSON differs from inventory" : "manifest must be valid JSON");
      }
    }
  }
  return actualBinding;
}

function verifyOuterDistributionCollisions(binding, actualBinding, universeRecords, results) {
  if (!isObject(binding)) return;
  for (const [kind, pathKey, bytesKey] of [
    ["manifest", "manifestPath", "manifestBytes"],
    ["artifact", "artifactPath", "artifactBytes"]
  ]) {
    const outerPath = binding[pathKey];
    if (!safePathValue(outerPath)) continue;
    const collisions = universeRecords.filter((record) => record.path === outerPath);
    if (collisions.length === 0) continue;
    const actualBytes = actualBinding?.[bytesKey] ?? null;
    if (!actualBytes) {
      issue(results, "boundaryIssues", "OUTER_DISTRIBUTION_COLLISION_UNVERIFIED", outerPath, `${kind} bytes could not be bound to the outer envelope`);
      continue;
    }
    const expectedHash = hashBytes(actualBytes);
    for (const record of collisions) {
      if (!record.bytes || hashBytes(record.bytes) !== expectedHash) {
        issue(results, "boundaryIssues", "OUTER_DISTRIBUTION_COLLISION", outerPath, `${kind} distribution bytes differ from the outer envelope`);
      }
    }
  }
}

function verifyArtifactCoverage(actualArtifactBytes, universe, results, verifier) {
  if (!actualArtifactBytes || typeof verifier !== "function") {
    issue(results, "boundaryIssues", "ARTIFACT_COVERAGE_UNVERIFIED", "outerBinding.artifactPath", "archive bytes and an external artifact-universe verifier are required");
    return false;
  }
  const files = [...universe.values()]
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const actual = {
    artifactSha256: hashBytes(actualArtifactBytes),
    files,
    filesSha256: files.some((entry) => !SHA256.test(entry.sha256 ?? "")) ? null : hashBytes(Buffer.from(stableJson(files), "utf8"))
  };
  let answer = null;
  try { answer = verifier(actual); } catch { answer = null; }
  const verified = verifiedAnswerMatches(answer, [
    ["artifactSha256", actual.artifactSha256],
    ["filesSha256", actual.filesSha256]
  ]);
  if (!verified) issue(results, "boundaryIssues", "ARTIFACT_COVERAGE_UNVERIFIED", "outerBinding.artifactPath", "external verifier did not bind archive bytes to the complete file universe");
  return verified;
}

export function verifyLicenseInventory({ inventory, distributionFiles, outerBinding, rootDir = null, expectedVersion = null, privateEvidenceResolver = null, apacheClosureVerifier = null, artifactCoverageVerifier = null } = {}) {
  const results = emptyResults();
  const shapeErrors = validateLicenseInventoryShape(inventory);
  results.schemaErrors.push(...shapeErrors);
  if (expectedVersion !== null && inventory?.productVersion !== expectedVersion) issue(results, "schemaErrors", "EXPECTED_VERSION_MISMATCH", "inventory.productVersion");
  if (!Array.isArray(distributionFiles)) issue(results, "schemaErrors", "UNIVERSE_MISSING", "distributionFiles");
  const rawUniverse = Array.isArray(distributionFiles) ? distributionFiles : [];
  const universeRecords = [];
  for (const [index, raw] of rawUniverse.entries()) {
    const record = normalizeUniverseEntry(raw, index, { rootDir }, results);
    if (record) universeRecords.push(record);
  }
  const universeDuplicates = [];
  const universeCounts = new Map();
  for (const record of universeRecords) universeCounts.set(record.path, (universeCounts.get(record.path) ?? 0) + 1);
  for (const [filePath, count] of universeCounts) if (count > 1) universeDuplicates.push(filePath);
  results.duplicates.push(...universeDuplicates.map((filePath) => ({ code: "UNIVERSE_DUPLICATE", path: filePath })));
  const universePathSet = new Set(universeRecords.map((record) => record.path));
  const actualOuterBinding = validateOuterBinding(outerBinding, inventory ?? {}, universePathSet, results, { rootDir });
  verifyOuterDistributionCollisions(outerBinding, actualOuterBinding, universeRecords, results);
  const excludedOuter = new Set([outerBinding?.manifestPath, outerBinding?.artifactPath].filter(Boolean));
  const coverageUniverse = universeRecords.filter((record) => !excludedOuter.has(record.path));
  const universe = new Map();
  for (const record of coverageUniverse) if (!universe.has(record.path)) universe.set(record.path, record);
  const artifactCoverageVerified = verifyArtifactCoverage(actualOuterBinding?.artifactBytes, universe, results, artifactCoverageVerifier);
  const inventoryFiles = Array.isArray(inventory?.files) ? inventory.files : [];
  const inventoryByPath = new Map();
  for (const file of inventoryFiles) if (isObject(file) && file.path && !inventoryByPath.has(file.path)) inventoryByPath.set(file.path, file);
  const inventoryCounts = new Map();
  for (const file of inventoryFiles) if (file?.path) inventoryCounts.set(file.path, (inventoryCounts.get(file.path) ?? 0) + 1);
  for (const [filePath, count] of inventoryCounts) if (count > 1) results.duplicates.push({ code: "INVENTORY_DUPLICATE", path: filePath });
  const inventoryPathSet = new Set(inventoryFiles.map((file) => file?.path).filter(Boolean));
  results.missing = [...universe.keys()].filter((filePath) => !inventoryPathSet.has(filePath)).sort();
  results.extra = [...inventoryPathSet].filter((filePath) => !universe.has(filePath)).sort();
  for (const filePath of results.missing) issue(results, "boundaryIssues", "COVERAGE_MISSING", filePath);
  for (const filePath of results.extra) issue(results, "boundaryIssues", "COVERAGE_EXTRA", filePath);
  // Once shape validation fails, do not dereference malformed nested fields. The
  // shape errors already force HOLD and the report remains deterministic.
  if (shapeErrors.length === 0) {
    for (const file of inventoryFiles) if (isObject(file) && universe.has(file.path)) checkFile(file, universe, results, { privateEvidenceResolver, apacheClosureVerifier, inventoryByPath });
  }
  const dedupe = (items) => items.filter((item, index) => items.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(item)) === index);
  for (const key of Object.keys(results)) results[key] = dedupe(results[key]);
  const coverageComplete = results.missing.length === 0 && results.extra.length === 0 && !results.duplicates.length && !results.contentDrift.length;
  const rightsReady = artifactCoverageVerified && coverageComplete && Object.entries(results).filter(([key]) => key !== "missing" && key !== "extra" && key !== "duplicates" && key !== "contentDrift").every(([, items]) => items.length === 0);
  return {
    schemaVersion: LICENSE_INVENTORY_SCHEMA_VERSION,
    coverage: { universeCount: universe.size, inventoryCount: inventoryFiles.length, coveredCount: [...universe.keys()].filter((filePath) => inventoryPathSet.has(filePath)).length, complete: coverageComplete },
    artifactCoverageVerified,
    rightsReady,
    releaseDisposition: rightsReady ? "READY" : "HOLD",
    ...results
  };
}

export function assertLicenseInventory(input) {
  const result = verifyLicenseInventory(input);
  if (!result.rightsReady) {
    const error = new Error(`License inventory is ${result.releaseDisposition}`);
    error.code = "LICENSE_INVENTORY_HOLD";
    error.result = result;
    throw error;
  }
  return result;
}
