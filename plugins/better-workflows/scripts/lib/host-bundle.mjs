import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const SIGNER_PATH = "/private/var/db/better-workflows/bin/bw-host-trust.mjs";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
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
  const hostBundle = status?.hostBundle ?? {
    schemaVersion: 1,
    protocolVersion: 1,
    bundleVersion: binding.signer?.version ?? signer?.version ?? null,
    signerDigest: binding.signer?.digest ?? signer?.digest ?? null,
    launcherDigest: binding.launcher?.digest ?? status?.launcher?.digest ?? null,
    runtimeDigest: binding.runtime?.digest ?? runtime?.digest ?? null,
    readinessReceiptDigest: receipt?.digest ?? null,
    readinessBindingDigest: receipt?.bindingDigest ?? null,
    legacyCompatible: true
  };
  if (hostBundle.schemaVersion !== 1 || hostBundle.protocolVersion !== 1 ||
      hostBundle.bundleVersion !== signer?.version || hostBundle.signerDigest !== signer?.digest ||
      hostBundle.runtimeDigest !== runtime?.digest ||
      (hostBundle.readinessReceiptDigest !== null && !SHA256.test(hostBundle.readinessReceiptDigest)) ||
      (hostBundle.readinessBindingDigest !== null && !SHA256.test(hostBundle.readinessBindingDigest))) {
    throw new Error("Root-owned host bundle protocol binding is invalid");
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
