import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { spawnCapture } from "./process-capture.mjs";

export const FORMAL_SUITE_CONCURRENCY = 3;
export const FORMAL_SUITE_TIMEOUT_MS = 40 * 60 * 1000;
export const FORMAL_SUITE_CLEANUP_GRACE_MS = 5 * 1000;
export const FORMAL_SUITE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const SUITE_ARGUMENTS = Object.freeze([
  "--experimental-vm-modules",
  "--test",
  "--test-concurrency=1"
]);

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return value;
}

function normalizeSuites(testPaths) {
  if (!Array.isArray(testPaths) || testPaths.length === 0) {
    throw new Error("Formal suite runner requires at least one test path");
  }
  const suites = Array.from(testPaths, (testPath, index) => requireAbsolutePath(testPath, `Formal suite path ${index}`));
  if (new Set(suites).size !== suites.length) {
    throw new Error("Formal suite runner rejects duplicate test paths");
  }
  return suites.slice().sort();
}

function outputBuffer(value, label) {
  if (value === undefined || value === null) return Buffer.alloc(0);
  if (typeof value === "string" || value instanceof Uint8Array) return Buffer.from(value);
  throw new Error(`${label} must be a string or bytes`);
}

const outputDigest = (value) => typeof value === "string" || value instanceof Uint8Array
  ? createHash("sha256").update(value).digest("hex") : null;

export const formalSuiteCommand = (nodePath, testPath) => [nodePath, ...SUITE_ARGUMENTS, testPath];

// Diagnostic observations only. Missing capture facts remain unknown; a digest
// or caller-created object is not execution or publication authority.
export function formalCaptureObservation(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  return {
    pid: Number.isSafeInteger(result.pid) && result.pid > 0 ? result.pid : null,
    exitStatusObserved: (result.code === null || (Number.isSafeInteger(result.code) && result.code >= 0)) &&
      (result.signal === null || (typeof result.signal === "string" && result.signal.length > 0)),
    exitCode: Number.isSafeInteger(result.code) && result.code >= 0 ? result.code : null,
    signal: typeof result.signal === "string" ? result.signal : null,
    timedOut: typeof result.timedOut === "boolean" ? result.timedOut : null,
    outputExceeded: typeof result.outputExceeded === "boolean" ? result.outputExceeded : null,
    groupTerminated: typeof result.groupTerminated === "boolean" ? result.groupTerminated : null,
    stdoutSha256: result.stdout === undefined || result.stdout === null ? null : outputDigest(result.stdout),
    stderrSha256: result.stderr === undefined || result.stderr === null ? null : outputDigest(result.stderr)
  };
}

export function formalCaptureSucceeded(result) {
  return result?.code === 0 && result.signal === null && result.timedOut === false &&
    result.outputExceeded === false && result.groupTerminated === true;
}

function assertCaptureResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("suite capture returned no result object");
  }
  const codeIsValid = result.code === null || (Number.isSafeInteger(result.code) && result.code >= 0);
  const signalIsValid = result.signal === null || (typeof result.signal === "string" && result.signal.length > 0);
  if (!codeIsValid || !signalIsValid || (result.code === null) === (result.signal === null)) {
    throw new Error("suite capture returned an invalid exit status");
  }
  if (typeof result.timedOut !== "boolean" || typeof result.outputExceeded !== "boolean") {
    throw new Error("suite capture returned invalid bound status");
  }
  if (result.groupTerminated !== true) {
    throw new Error("suite process-group cleanup could not be proven");
  }
  outputBuffer(result.stdout, "suite stdout");
  outputBuffer(result.stderr, "suite stderr");
  return result;
}

function suiteFailure(testPath, result) {
  if (result.code === 0 && result.signal === null && !result.timedOut && !result.outputExceeded) return null;
  const diagnostics = Buffer.concat([
    outputBuffer(result.stderr, "suite stderr"),
    outputBuffer(result.stdout, "suite stdout")
  ]).toString("utf8").trim();
  const outcome = result.timedOut
    ? `timeout after ${FORMAL_SUITE_TIMEOUT_MS}ms`
    : result.outputExceeded
      ? `output above ${FORMAL_SUITE_MAX_OUTPUT_BYTES} bytes`
      : result.signal !== null
        ? `signal ${result.signal}`
        : `exit ${result.code}`;
  const message = `Test suite failed for ${path.basename(testPath)} with ${outcome}${diagnostics ? `: ${diagnostics}` : ""}`;
  return Object.freeze({ testPath, message });
}

function suiteFailureError(failures) {
  const message = failures.length === 1
    ? failures[0].message
    : `Test suites failed (${failures.length}):\n${failures.map((failure) => `- ${failure.message}`).join("\n")}`;
  const error = new Error(message);
  error.code = "FORMAL_SUITE_FAILURE";
  error.failures = failures.map((failure) => ({ ...failure }));
  return error;
}

function infrastructureError(testPath, cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(`Formal suite runner infrastructure failed for ${path.basename(testPath)}: ${detail}`, {
    cause: cause instanceof Error ? cause : undefined
  });
  error.code = "FORMAL_SUITE_INFRASTRUCTURE";
  return error;
}

function cancellationError(source) {
  const error = new Error(`Formal suite evaluation cancelled by ${source}`);
  error.code = "FORMAL_SUITE_CANCELLED";
  return error;
}

export async function runFormalSuites({
  testPaths,
  cwd = process.cwd(),
  repositoryRoot = cwd,
  env = process.env,
  nodePath = process.execPath,
  capture = spawnCapture,
  signalSource = process,
  signal = null
} = {}) {
  const suites = normalizeSuites(testPaths);
  requireAbsolutePath(cwd, "Formal suite cwd");
  requireAbsolutePath(repositoryRoot, "Formal suite repository root");
  requireAbsolutePath(nodePath, "Formal suite node path");
  const relativePaths = suites.map((testPath) => {
    const relative = path.relative(repositoryRoot, testPath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Formal suite path must remain inside its repository root");
    }
    return relative.split(path.sep).join("/");
  });
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("Formal suite environment must be an object");
  }
  if (typeof capture !== "function") throw new Error("Formal suite capture must be a function");
  if (signalSource !== null &&
      (typeof signalSource.once !== "function" || typeof signalSource.off !== "function")) {
    throw new Error("Formal suite signal source must support once/off");
  }
  if (signal !== null &&
      (typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
    throw new Error("Formal suite abort signal is invalid");
  }

  const controller = new AbortController();
  const failures = new Array(suites.length);
  const infrastructureFailures = new Array(suites.length);
  const observations = suites.map((testPath, index) => ({
    path: relativePaths[index],
    command: formalSuiteCommand(nodePath, testPath),
    cwd,
    status: "NOT_RUN",
    startedAt: null,
    finishedAt: null,
    elapsedMs: null,
    terminal: null
  }));
  const report = () => ({
    schemaVersion: 1,
    authority: "none",
    expectedSuites: relativePaths.slice(),
    observations: structuredClone(observations)
  });
  let nextIndex = 0;
  let stopReason = null;
  const stop = (reason) => {
    stopReason ??= reason instanceof Error ? reason : new Error(String(reason));
    if (!controller.signal.aborted) controller.abort(stopReason);
  };
  const forwardTerm = () => stop(cancellationError("SIGTERM"));
  const forwardInt = () => stop(cancellationError("SIGINT"));
  const forwardAbort = () => stop(cancellationError("parent abort"));

  signalSource?.once("SIGTERM", forwardTerm);
  signalSource?.once("SIGINT", forwardInt);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });

  const runSuite = async (index) => {
    const testPath = suites[index];
    const observation = observations[index];
    observation.status = "UNKNOWN";
    observation.startedAt = new Date().toISOString();
    const start = performance.now();
    const finish = () => {
      observation.finishedAt = new Date().toISOString();
      observation.elapsedMs = Math.max(0, performance.now() - start);
    };
    let result;
    try {
      result = await capture(nodePath, [...SUITE_ARGUMENTS, testPath], {
        cwd,
        env,
        timeoutMs: FORMAL_SUITE_TIMEOUT_MS,
        cleanupGraceMs: FORMAL_SUITE_CLEANUP_GRACE_MS,
        maxOutputBytes: FORMAL_SUITE_MAX_OUTPUT_BYTES,
        abortSignal: controller.signal
      });
    } catch (error) {
      // A capture rejection means the owned supervisor, output contract, or
      // process-group cleanup failed. Preserve it even when cancellation was
      // already requested; cancellation is acceptable only after every active
      // capture proves cleanup.
      infrastructureFailures[index] = infrastructureError(testPath, error);
      observation.status = "INFRASTRUCTURE_FAILURE";
      observation.terminal = formalCaptureObservation(error?.execution);
      observation.error = infrastructureFailures[index].message;
      finish();
      stop(infrastructureFailures[index]);
      return;
    }
    try {
      observation.terminal = formalCaptureObservation(result);
      finish();
      assertCaptureResult(result);
      if (controller.signal.aborted) {
        observation.status = "CANCELLED";
        return;
      }
      const failure = suiteFailure(testPath, result);
      observation.status = failure ? "FAILED" : "PASSED";
      if (!failure) return;
      failures[index] = failure;
      if (result.timedOut || result.outputExceeded) stop(suiteFailureError([failure]));
    } catch (error) {
      infrastructureFailures[index] = infrastructureError(testPath, error);
      observation.status = "INFRASTRUCTURE_FAILURE";
      observation.error = infrastructureFailures[index].message;
      stop(infrastructureFailures[index]);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(FORMAL_SUITE_CONCURRENCY, suites.length) }, async () => {
      while (!controller.signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= suites.length) return;
        await runSuite(index);
      }
    }));
    const observedInfrastructureFailures = infrastructureFailures.filter(Boolean);
    if (observedInfrastructureFailures.length > 0) throw observedInfrastructureFailures[0];
    if (stopReason) throw stopReason;
    const observedFailures = failures.filter(Boolean);
    if (observedFailures.length > 0) throw suiteFailureError(observedFailures);
    return { ok: true, tests: suites.length, formalSuites: report() };
  } catch (error) {
    error.formalSuites = report();
    throw error;
  } finally {
    signalSource?.off("SIGTERM", forwardTerm);
    signalSource?.off("SIGINT", forwardInt);
    signal?.removeEventListener("abort", forwardAbort);
  }
}
