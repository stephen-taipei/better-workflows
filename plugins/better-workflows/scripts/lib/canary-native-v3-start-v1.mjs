// SPDX-License-Identifier: AGPL-3.0-only
// Native V3 observation adapter. Caller-supplied configuration and a local
// journal do not authenticate the launcher or confer canary/release authority.
import { validateCanaryCohortV1 } from "./canary-cohort-v1.mjs";
import { withCanaryRunStartV1 } from "./canary-start-boundary-v1.mjs";

export const CANARY_NATIVE_V3_START_KIND = "CanaryNativeV3StartV1";

export class CanaryNativeV3StartError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CanaryNativeV3StartError";
    this.code = code;
    this.status = "HOLD";
  }
}

function fail(code, message) {
  throw new CanaryNativeV3StartError(code, message);
}

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail("ECANARY_NATIVE_V3_INVALID", `${label} must be a plain record`);
  }
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
    fail("ECANARY_NATIVE_V3_INVALID", `${label} has unexpected or missing fields`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail("ECANARY_NATIVE_V3_INVALID", `${label}.${key} must be an enumerable data field`);
    }
  }
}

/**
 * Records one natural start before Native V3 dispatch. The cohort and route
 * must be independently pinned by the eventual protected canary launcher;
 * this adapter only prevents an opted-in CLI execution from dispatching when
 * its local observation cannot be written and reconciled.
 */
export async function withCanaryNativeV3StartV1({ configuration, prepared, dispatch, now = () => new Date() }) {
  exact(configuration, [
    "schemaVersion", "kind", "planId", "expectedSourceBinding", "cohort",
    "journalPath", "route", "facts", "evidenceRefs"
  ], "canary Native V3 configuration");
  if (configuration.schemaVersion !== 1 || configuration.kind !== CANARY_NATIVE_V3_START_KIND) {
    fail("ECANARY_NATIVE_V3_INVALID", "Canary Native V3 configuration version or kind is invalid");
  }
  exact(configuration.expectedSourceBinding, ["revision", "digest"], "expected source binding");
  exact(prepared, ["planId", "runId", "sourceBinding"], "prepared Native V3 identity");
  exact(prepared.sourceBinding, ["revision", "digest"], "prepared source binding");
  if (configuration.planId !== prepared.planId ||
      configuration.expectedSourceBinding.revision !== prepared.sourceBinding.revision ||
      configuration.expectedSourceBinding.digest !== prepared.sourceBinding.digest) {
    fail("ECANARY_NATIVE_V3_BINDING", "Canary configuration is not bound to the prepared plan and source");
  }
  if (typeof prepared.runId !== "string" || typeof dispatch !== "function" || typeof now !== "function") {
    fail("ECANARY_NATIVE_V3_INVALID", "Canary Native V3 dispatch identity is invalid");
  }
  const cohort = validateCanaryCohortV1(configuration.cohort);
  const at = now();
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    fail("ECANARY_NATIVE_V3_INVALID", "Canary start clock did not return a valid time");
  }
  return withCanaryRunStartV1({
    cohort,
    journalPath: configuration.journalPath,
    route: configuration.route,
    start: {
      runId: prepared.runId,
      at: at.toISOString(),
      candidateRevision: cohort.registration.revision,
      sourceRevision: prepared.sourceBinding.revision,
      sourceDigest: prepared.sourceBinding.digest,
      facts: configuration.facts,
      evidenceRefs: configuration.evidenceRefs
    },
    dispatch
  });
}
