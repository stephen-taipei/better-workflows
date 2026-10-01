import {
  POSIX_BEFORE_LAUNCH_MAX_MS,
  POSIX_MAX_OUTPUT_BYTES,
  assertTrustedPosixOwnedResourceAdapter,
  bindPosixOwnedRecoveryLaunchVerifierV1,
  createPosixOwnedProcessAdapter,
  queryPosixOwnedRecoveryTaskEffectV1,
  readPosixOwnedProcessLaunchEvidenceV1
} from "./posix-owned-process-adapter.mjs";

export const OWNED_PROCESS_ADAPTER_KIND = "OwnedProcessAdapterV1";
export const OWNED_PROCESS_BACKEND_POSIX = "posix-process-group-v1";
export const OWNED_PROCESS_BACKEND_WINDOWS_JOB_OBJECT = "windows-job-object-v1";
export const OWNED_PROCESS_BEFORE_LAUNCH_MAX_MS = POSIX_BEFORE_LAUNCH_MAX_MS;
export const OWNED_PROCESS_MAX_OUTPUT_BYTES = POSIX_MAX_OUTPUT_BYTES;

// Production consumers must enter through this selector. The exact resource
// adapter returned by a concrete producer is retained in this private map so a
// copied, proxied, derived, deserialized, or generic fixture adapter cannot be
// promoted into production process-control authority by matching public shape.
const TRUSTED_OWNED_PROCESS_ADAPTERS = new WeakMap();
const POSIX_BACKEND = Object.freeze({
  kind: OWNED_PROCESS_BACKEND_POSIX,
  assertTrusted: assertTrustedPosixOwnedResourceAdapter,
  bindRecoveryLaunchVerifier: bindPosixOwnedRecoveryLaunchVerifierV1,
  readLaunchEvidence: readPosixOwnedProcessLaunchEvidenceV1,
  queryRecoveryTaskEffect: queryPosixOwnedRecoveryTaskEffectV1
});

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = "HOLD";
  return error;
}

function assertPlatform(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 32 || !/^[a-z0-9_-]+$/.test(value)) {
    throw failure("EOWNED_PROCESS_PLATFORM", "owned process platform is invalid");
  }
  return value;
}

export function createOwnedProcessAdapterV1(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw failure("EOWNED_PROCESS_INPUT", "owned process adapter options are invalid");
  }
  const platform = assertPlatform(options.platform ?? process.platform);
  let concrete;
  let backend;

  if (platform === "darwin" || platform === "linux") {
    concrete = createPosixOwnedProcessAdapter({ ...options, platform });
    backend = POSIX_BACKEND;
  } else if (platform === "win32") {
    // This is a fail-closed implementation boundary, not a simulated
    // JobObject or a Windows support claim. A real native producer replaces
    // this HOLD after its artifact and state-security contracts are wired.
    throw failure(
      "EWINDOWS_JOB_OBJECT_ADAPTER_UNAVAILABLE",
      "Windows Job Object owned process adapter is not available in this candidate"
    );
  } else {
    throw failure("EUNSUPPORTED_OWNED_PROCESS_ADAPTER", "owned process adapter is unsupported on this platform");
  }

  if (!concrete || typeof concrete !== "object" || !concrete.resourceAdapter ||
      typeof concrete.startOwned !== "function" || typeof concrete.stopOwned !== "function") {
    throw failure("EOWNED_PROCESS_PRODUCER", "owned process producer returned an invalid adapter");
  }
  TRUSTED_OWNED_PROCESS_ADAPTERS.set(concrete.resourceAdapter, backend);
  return Object.freeze({
    kind: OWNED_PROCESS_ADAPTER_KIND,
    backend: backend.kind,
    resourceAdapter: concrete.resourceAdapter,
    startOwned: concrete.startOwned,
    stopOwned: concrete.stopOwned
  });
}

function backendFor(resourceAdapter) {
  if (!resourceAdapter || (typeof resourceAdapter !== "object" && typeof resourceAdapter !== "function")) return null;
  const selected = TRUSTED_OWNED_PROCESS_ADAPTERS.get(resourceAdapter);
  if (selected) return selected;
  // Preserve the historical direct POSIX producer as a compatibility route.
  // Its module-private WeakSet still rejects copied or caller-created shapes.
  try {
    assertTrustedPosixOwnedResourceAdapter(resourceAdapter);
    return POSIX_BACKEND;
  } catch {
    return null;
  }
}

export function assertTrustedOwnedProcessResourceAdapterV1(resourceAdapter) {
  const backend = backendFor(resourceAdapter);
  if (!backend) throw failure("EOWNED_PROCESS_AUTHORITY", "resource adapter was not produced by the owned process selector");
  backend.assertTrusted(resourceAdapter);
  return resourceAdapter;
}

export function readOwnedProcessAdapterBackendV1(resourceAdapter) {
  assertTrustedOwnedProcessResourceAdapterV1(resourceAdapter);
  return backendFor(resourceAdapter).kind;
}

export function bindOwnedRecoveryLaunchVerifierV1(resourceAdapter, verifier) {
  assertTrustedOwnedProcessResourceAdapterV1(resourceAdapter);
  return backendFor(resourceAdapter).bindRecoveryLaunchVerifier(resourceAdapter, verifier);
}

export function readOwnedProcessLaunchEvidenceV1(resourceAdapter, handle) {
  assertTrustedOwnedProcessResourceAdapterV1(resourceAdapter);
  return backendFor(resourceAdapter).readLaunchEvidence(resourceAdapter, handle);
}

export function queryOwnedRecoveryTaskEffectV1(resourceAdapter, input, options) {
  assertTrustedOwnedProcessResourceAdapterV1(resourceAdapter);
  return backendFor(resourceAdapter).queryRecoveryTaskEffect(resourceAdapter, input, options);
}

export const createOwnedProcessAdapter = createOwnedProcessAdapterV1;
export default createOwnedProcessAdapterV1;
