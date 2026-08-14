import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const SIGNER_PATH = "/private/var/db/better-workflows/bin/bw-host-trust.mjs";
const LAUNCHER_PATH = "/private/var/db/better-workflows/bin/bw-host-exec-launcher";
const RUNTIME_PREFIX = "/private/var/db/better-workflows/bin/bw-host-node.";
const HOST_BUNDLE_KIND = "better-workflows-host-bundle";
const HOST_BUNDLE_REQUIRED_KEYS = [
  "schemaVersion",
  "kind",
  "protocolVersion",
  "bundleVersion",
  "signerPath",
  "signerDigest",
  "launcherPath",
  "launcherDigest",
  "runtimePath",
  "runtimeDigest",
  "supportedConsentSchemas",
  "issuer",
  "keyId",
  "issuedAt",
  "signature"
];

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function validateHostBundleManifest(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle) ||
      Object.keys(bundle).sort().join("\0") !== HOST_BUNDLE_REQUIRED_KEYS.slice().sort().join("\0")) {
    throw new Error("Root-owned host bundle manifest fields are invalid");
  }
  if (bundle.schemaVersion !== 1 || bundle.kind !== HOST_BUNDLE_KIND || bundle.protocolVersion !== 1 ||
      typeof bundle.bundleVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(bundle.bundleVersion) ||
      bundle.signerPath !== SIGNER_PATH || bundle.launcherPath !== LAUNCHER_PATH ||
      !SHA256.test(bundle.signerDigest ?? "") || !SHA256.test(bundle.launcherDigest ?? "") ||
      !SHA256.test(bundle.runtimeDigest ?? "") ||
      typeof bundle.runtimePath !== "string" || bundle.runtimePath !== `${RUNTIME_PREFIX}${bundle.runtimeDigest}` ||
      JSON.stringify(bundle.supportedConsentSchemas) !== JSON.stringify([4]) ||
      bundle.issuer !== "better-workflows-local-host" ||
      typeof bundle.keyId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(bundle.keyId) ||
      typeof bundle.issuedAt !== "string" || !Number.isFinite(Date.parse(bundle.issuedAt)) ||
      typeof bundle.signature !== "string" || bundle.signature.length < 16 || bundle.signature.length > 4096) {
    throw new Error("Root-owned host bundle manifest binding is invalid");
  }
  return bundle;
}

// The root signer is authoritative. When the installed signer has not yet
// exposed a first-class hostBundle field, derive a legacy-compatible protocol
// binding from the signed readiness receipt returned by the root-owned status
// command. This deliberately validates compatibility, not repository source
// bytes, so ordinary plugin edits cannot invalidate the host installation.
export function hostBundleFromStatus(status) {
  const runtime = status?.runtime;
  const signer = status?.signer;
  const receipt = status?.readinessReceipt;
  const binding = receipt?.binding ?? {};
  const hostBundle = status?.hostBundle?.supported === false
    ? (() => { throw new Error(status.hostBundle.error ?? "Root-owned host bundle manifest is invalid"); })()
    : status?.hostBundle ?? {
    schemaVersion: 1,
    protocolVersion: 1,
    bundleVersion: binding.signer?.version ?? signer?.version ?? null,
    signerPath: signer?.path ?? SIGNER_PATH,
    signerDigest: binding.signer?.digest ?? signer?.digest ?? null,
    launcherPath: binding.launcher?.path ?? status?.launcher?.path ?? LAUNCHER_PATH,
    launcherDigest: binding.launcher?.digest ?? status?.launcher?.digest ?? null,
    runtimePath: binding.runtime?.path ?? runtime?.path ?? null,
    runtimeDigest: binding.runtime?.digest ?? runtime?.digest ?? null,
    readinessReceiptDigest: receipt?.digest ?? null,
    readinessBindingDigest: receipt?.bindingDigest ?? null,
    legacyCompatible: true
  };
  if (status?.hostBundle && status.hostBundle.supported !== false) validateHostBundleManifest(hostBundle);
  if (hostBundle.schemaVersion !== 1 || hostBundle.protocolVersion !== 1 ||
      hostBundle.bundleVersion !== signer?.version || hostBundle.signerDigest !== signer?.digest ||
      hostBundle.signerPath !== SIGNER_PATH || hostBundle.launcherPath !== LAUNCHER_PATH ||
      (hostBundle.launcherDigest !== status?.launcher?.digest && hostBundle.launcherDigest !== binding.launcher?.digest) ||
      hostBundle.runtimePath !== runtime?.path || hostBundle.runtimeDigest !== runtime?.digest ||
      !SHA256.test(hostBundle.signerDigest ?? "") || !SHA256.test(hostBundle.launcherDigest ?? "") ||
      !SHA256.test(hostBundle.runtimeDigest ?? "") ||
      ((hostBundle.readinessReceiptDigest ?? null) !== null && !SHA256.test(hostBundle.readinessReceiptDigest)) ||
      ((hostBundle.readinessBindingDigest ?? null) !== null && !SHA256.test(hostBundle.readinessBindingDigest))) {
    throw new Error("Root-owned host bundle protocol binding is invalid");
  }
  if (status?.hostBundle && (hostBundle.kind !== "better-workflows-host-bundle" ||
      !Array.isArray(hostBundle.supportedConsentSchemas) ||
      JSON.stringify(hostBundle.supportedConsentSchemas) !== JSON.stringify([4]) ||
      typeof hostBundle.signature !== "string" || hostBundle.signature.length < 16)) {
    throw new Error("Root-owned host bundle signature or consent schema binding is invalid");
  }
  if (signer?.path !== SIGNER_PATH) throw new Error("Root-owned host signer path is invalid");
  return hostBundle;
}

export function assertHostBundleMatchesStatus(hostBundle, status) {
  const expected = hostBundleFromStatus(status);
  if (hostBundleDigest(hostBundle) !== hostBundleDigest(expected)) {
    throw new Error("Host bundle binding changed after the root-owned status check");
  }
  return hostBundle;
}

export function hostBundleDigest(hostBundle) {
  return createHash("sha256").update(canonical(hostBundle), "utf8").digest("hex");
}

export async function loadHostBundleFromStatusFile(path) {
  return hostBundleFromStatus(JSON.parse(await readFile(path, "utf8")));
}
