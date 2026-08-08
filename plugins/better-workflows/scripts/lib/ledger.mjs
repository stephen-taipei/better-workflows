import { atomicWriteJson, assertMutableRun, digestObject, listJsonRecords, loadRun, nowIso, readJson, safeJoin, withRunLock } from "./core.mjs";

const LEDGER_SCHEMA_VERSION = 1;
const EVENT_TYPES = new Set(["start", "complete", "fail", "block", "release", "cancel"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const STAGE_KINDS = new Set(["regular", "review", "side-effect", "authorization"]);
const STAGE_BUDGETS = new Map([
  ["regular", 3],
  ["review", 5],
  ["side-effect", 1],
  ["authorization", 1]
]);

function ledgerPath(runDir) {
  return safeJoin(runDir, "ledger.json");
}

function normalizeStage(stage) {
  const id = String(stage.id ?? "");
  if (!SAFE_ID.test(id)) throw new Error(`Invalid ledger task id: ${id}`);
  const dependencies = stage.dependsOn ?? stage.dependencies ?? [];
  if (!Array.isArray(dependencies)) throw new Error(`Ledger task ${id} dependencies must be an array`);
  for (const dependency of dependencies) {
    if (!SAFE_ID.test(String(dependency))) throw new Error(`Ledger task ${id} has an invalid dependency`);
  }
  const requiredEvidence = stage.requiredEvidence ?? [];
  if (!Array.isArray(requiredEvidence)) throw new Error(`Ledger task ${id} requiredEvidence must be an array`);
  for (const kind of requiredEvidence) {
    if (!SAFE_ID.test(String(kind))) throw new Error(`Ledger task ${id} has an invalid required evidence kind`);
  }
  const kind = String(stage.kind ?? "regular");
  if (!STAGE_KINDS.has(kind)) throw new Error(`Ledger task ${id} kind is invalid`);
  const attemptBudget = Number(stage.attemptBudget ?? STAGE_BUDGETS.get(kind));
  if (attemptBudget !== STAGE_BUDGETS.get(kind)) {
    throw new Error(`Ledger task ${id} must use the ${kind} attempt budget of ${STAGE_BUDGETS.get(kind)}`);
  }
  return {
    id,
    goal: String(stage.goal ?? stage.description ?? id),
    dependencies: [...dependencies].map(String),
    requiredEvidence: [...requiredEvidence].map(String),
    attemptBudget,
    kind
  };
}

function assertStaticTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("Execution ledger tasks must be non-empty");
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate ledger task: ${task.id}`);
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) throw new Error(`Unknown ledger dependency: ${task.id}->${dependency}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  function visit(id) {
    if (visiting.has(id)) throw new Error(`Ledger dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.id);
}

function normalizeLedger(value) {
  if (!value || value.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    throw new Error("Execution ledger schemaVersion must be 1");
  }
  if (!SAFE_ID.test(String(value.runId ?? ""))) throw new Error("Execution ledger runId is invalid");
  if (!DIGEST.test(String(value.contractDigest ?? ""))) throw new Error("Execution ledger contractDigest is invalid");
  const tasks = value.tasks.map(normalizeStage);
  assertStaticTasks(tasks);
  if (!Array.isArray(value.events)) throw new Error("Execution ledger events must be an array");
  return { ...value, tasks, events: value.events };
}

function initialTaskState(task) {
  return {
    id: task.id,
    state: "pending",
    attempts: 0,
    lastEvidence: [],
    lastError: null,
    blockedReason: null,
    releaseAuthority: null
  };
}

function eventId(event) {
  return String(event?.eventId ?? "");
}

function assertExpectedLedgerDigest(event, ledger) {
  if (event.expectedLedgerDigest === undefined) return;
  if (!DIGEST.test(String(event.expectedLedgerDigest))) {
    throw new Error("Ledger transition expectedLedgerDigest must be a SHA-256 digest");
  }
  if (String(event.expectedLedgerDigest) !== digestObject(ledger)) {
    throw new Error("Ledger transition expected digest is stale");
  }
}

function eventEvidenceKinds(event) {
  const evidenceKinds = event.evidenceKinds ?? [];
  const evidence = event.evidence ?? [];
  if (!Array.isArray(evidenceKinds) || !Array.isArray(evidence)) return null;
  return new Set([...evidenceKinds, ...evidence].map(String));
}

function reduceLedger(ledger, typedEvidenceKinds = new Set()) {
  const tasks = new Map(ledger.tasks.map((task) => [task.id, initialTaskState(task)]));
  const seenEvents = new Set();
  const blockers = [];
  const byId = new Map(ledger.tasks.map((task) => [task.id, task]));
  for (const event of ledger.events) {
    if (!event || !EVENT_TYPES.has(event.type) || !SAFE_ID.test(event.taskId ?? "")) {
      blockers.push(`invalid-event:${eventId(event) || "unknown"}`);
      continue;
    }
    if (!SAFE_ID.test(eventId(event)) || seenEvents.has(eventId(event))) {
      blockers.push(`duplicate-event:${eventId(event) || "unknown"}`);
      continue;
    }
    if (event.actor !== undefined && event.actor !== "root") {
      blockers.push(`non-root-event:${eventId(event)}`);
      continue;
    }
    if ((event.evidenceKinds !== undefined && !Array.isArray(event.evidenceKinds)) ||
        (event.evidence !== undefined && !Array.isArray(event.evidence))) {
      blockers.push(`invalid-event:${eventId(event)}`);
      continue;
    }
    seenEvents.add(eventId(event));
    const task = byId.get(event.taskId);
    const state = tasks.get(event.taskId);
    if (!task) {
      blockers.push(`unknown-task:${event.taskId}`);
      continue;
    }
    const dependenciesReady = task.dependencies.every((id) => tasks.get(id)?.state === "complete");
    if (event.type === "start") {
      if (state.state !== "pending" || !dependenciesReady) {
        blockers.push(`invalid-start:${task.id}`);
        continue;
      }
      if (state.attempts >= task.attemptBudget) {
        blockers.push(`budget-exhausted:${task.id}`);
        state.state = "blocked";
        state.blockedReason = "attempt-budget-exhausted";
        state.releaseAuthority = event.releaseAuthority ?? null;
        continue;
      }
      state.state = "in_progress";
      state.attempts += 1;
      state.lastError = null;
    } else if (event.type === "complete") {
      if (state.state !== "in_progress") {
        blockers.push(`invalid-complete:${task.id}`);
        continue;
      }
      const evidence = eventEvidenceKinds(event);
      if (task.requiredEvidence.some((kind) => !typedEvidenceKinds.has(kind))) {
        blockers.push(`complete-without-typed-evidence:${task.id}`);
        continue;
      }
      state.state = "complete";
      state.lastEvidence = [...new Set([
        ...task.requiredEvidence.filter((kind) => typedEvidenceKinds.has(kind)),
        ...[...evidence].filter((kind) => typedEvidenceKinds.has(kind))
      ])].sort();
      state.lastError = null;
    } else if (event.type === "fail") {
      if (state.state !== "in_progress") {
        blockers.push(`invalid-fail:${task.id}`);
        continue;
      }
      state.lastError = String(event.reason ?? "task failed");
      if (state.attempts >= task.attemptBudget) {
        state.state = "blocked";
        state.blockedReason = "attempt-budget-exhausted";
        state.releaseAuthority = event.releaseAuthority ?? null;
        blockers.push(`budget-exhausted:${task.id}`);
      } else {
        state.state = "pending";
      }
    } else if (event.type === "block") {
      if (!["pending", "in_progress"].includes(state.state)) {
        blockers.push(`invalid-block:${task.id}`);
        continue;
      }
      state.state = "blocked";
      state.blockedReason = String(event.reason ?? "blocked");
      state.releaseAuthority = event.releaseAuthority ?? null;
    } else if (event.type === "release") {
      if (state.state !== "blocked" || typeof event.releaseAuthority !== "string" || !event.releaseAuthority) {
        blockers.push(`unauthorized-release:${task.id}`);
        continue;
      }
      state.state = "pending";
      state.blockedReason = null;
      state.releaseAuthority = event.releaseAuthority;
    } else if (event.type === "cancel") {
      if (["complete", "cancelled"].includes(state.state)) {
        blockers.push(`invalid-cancel:${task.id}`);
        continue;
      }
      state.state = "cancelled";
      state.lastError = event.reason ? String(event.reason) : null;
    }
  }
  const readySet = ledger.tasks
    .filter((task) => {
      const state = tasks.get(task.id);
      return state.state === "pending" && task.dependencies.every((id) => tasks.get(id)?.state === "complete");
    })
    .map((task) => task.id)
    .sort();
  const taskStates = [...tasks.values()].sort((a, b) => a.id.localeCompare(b.id));
  const complete = blockers.length === 0 && taskStates.every((task) => ["complete", "cancelled"].includes(task.state));
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    runId: ledger.runId,
    taskStates,
    readySet,
    nextSlice: readySet[0] ?? null,
    blockers: [...new Set(blockers)].sort(),
    complete
  };
}

export async function initializeLedger(root, runDir, contract, runIdOverride = null) {
  if (contract.schemaVersion !== 2) return null;
  const tasks = contract.executionStages.map(normalizeStage);
  assertStaticTasks(tasks);
  const ledger = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    runId: runIdOverride ?? pathRunId(runDir),
    contractDigest: digestObject(contract),
    createdAt: nowIso(),
    tasks,
    events: []
  };
  await atomicWriteJson(root, ledgerPath(runDir), ledger);
  return ledger;
}

function pathRunId(runDir) {
  return String(runDir).split(/[\\/]/).pop();
}

export async function deriveLedgerStatus(root, runId) {
  const runDir = safeJoin(root, "runs", runId);
  const ledger = normalizeLedger(await readJson(root, ledgerPath(runDir)));
  const run = {
    manifest: await readJson(root, safeJoin(runDir, "manifest.json")),
    contract: await readJson(root, safeJoin(runDir, "contract.json")),
    state: await readJson(root, safeJoin(runDir, "state.json")),
    root,
    runDir,
    requireReconciled: true
  };
  if (ledger.runId !== runId) throw new Error("Execution ledger runId is stale");
  const records = await listJsonRecords(root, safeJoin(runDir, "evidence"));
  const typedKinds = new Set();
  const evidenceBlockers = [];
  if (run.contract.schemaVersion === 2) {
    const { validateTypedEvidenceRecord } = await import("./evidence.mjs");
    for (const record of records.filter((item) => item.schemaVersion === 2 && item.typedAdmission)) {
      try {
        await validateTypedEvidenceRecord(record, run);
        if (!record.stale) typedKinds.add(record.kind);
      } catch {
        evidenceBlockers.push(`invalid-typed-evidence:${record.id ?? "unknown"}`);
      }
    }
  } else {
    for (const record of records.filter((item) => item.schemaVersion === 2 && item.typedAdmission)) typedKinds.add(record.kind);
  }
  if (ledger.contractDigest !== digestObject(run.contract)) throw new Error("Ledger contract digest is stale");
  const reduced = reduceLedger(ledger, typedKinds);
  if (evidenceBlockers.length === 0) return reduced;
  return {
    ...reduced,
    blockers: [...new Set([...reduced.blockers, ...evidenceBlockers])].sort(),
    complete: false
  };
}

export async function ledgerStatus(root, runId) {
  return deriveLedgerStatus(root, runId);
}

export async function transitionLedger(root, runId, event) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Ledger transition");
    const target = ledgerPath(runDir);
    const ledger = normalizeLedger(await readJson(root, target));
  if (ledger.runId !== runId) throw new Error("Execution ledger runId is stale");
  if (!event || !SAFE_ID.test(event.eventId ?? "")) throw new Error("Ledger transition requires a unique eventId");
  if (!EVENT_TYPES.has(event.type)) throw new Error(`Unknown ledger event type: ${event.type}`);
  if (event.actor !== undefined && event.actor !== "root") throw new Error("Ledger transitions are root-owned");
  assertExpectedLedgerDigest(event, ledger);
  const records = await listJsonRecords(root, safeJoin(runDir, "evidence"));
  const typedKinds = new Set();
  if (run.contract.schemaVersion === 2) {
    const { validateTypedEvidenceRecord } = await import("./evidence.mjs");
    for (const record of records.filter((item) => item.schemaVersion === 2 && item.typedAdmission)) {
      try {
        await validateTypedEvidenceRecord(record, { ...run, root, requireReconciled: true });
        if (!record.stale) typedKinds.add(record.kind);
      } catch {
        throw new Error(`Ledger transition rejected: invalid-typed-evidence:${record.id ?? "unknown"}`);
      }
    }
  } else {
    for (const record of records.filter((item) => item.schemaVersion === 2 && item.typedAdmission)) {
      typedKinds.add(record.kind);
    }
  }
  const before = reduceLedger(ledger, typedKinds);
  if (before.blockers.length > 0) {
    throw new Error(`Ledger transition rejected: ${before.blockers.join(", ")}`);
  }
  const nextLedger = { ...ledger, events: [...ledger.events, { ...event, actor: "root", at: event.at ?? nowIso() }] };
  const after = reduceLedger(nextLedger, typedKinds);
  const newBlockers = after.blockers.filter((item) => !before.blockers.includes(item));
  if (newBlockers.length > 0) throw new Error(`Ledger transition rejected: ${newBlockers.join(", ")}`);
    await atomicWriteJson(root, target, nextLedger);
    return after;
  });
}

export async function compileLedger(root, runId, packet) {
  return withRunLock(root, runId, async () => compileLedgerLocked(root, runId, packet));
}

async function compileLedgerLocked(root, runId, packet) {
  const run = await loadRun(root, runId);
  assertMutableRun(run, "Ledger compilation");
  if (run.contract.schemaVersion !== 2 || run.contract.controlPlane?.designPacketPolicy !== "pilot-v1") {
    throw new Error("Design packet compilation is not enabled for this run");
  }
  if (!packet || packet.schemaVersion !== 1 || !Array.isArray(packet.tasks)) {
    throw new Error("Design packet must use schemaVersion 1 and contain tasks");
  }
  const topLevelKeys = new Set(["schemaVersion", "id", "objective", "constraints", "acceptanceIds", "tasks"]);
  const unknownTopLevel = Object.keys(packet).filter((key) => !topLevelKeys.has(key));
  if (unknownTopLevel.length > 0) throw new Error(`Design packet contains unknown field(s): ${unknownTopLevel.sort().join(", ")}`);
  if (!SAFE_ID.test(String(packet.id ?? ""))) throw new Error("Design packet id is invalid");
  if (typeof packet.objective !== "string" || !packet.objective.trim()) throw new Error("Design packet objective is required");
  if (!Array.isArray(packet.constraints) || packet.constraints.some((item) => typeof item !== "string")) {
    throw new Error("Design packet constraints must be an array of strings");
  }
  if (!Array.isArray(packet.acceptanceIds) || packet.acceptanceIds.some((item) => !SAFE_ID.test(String(item)))) {
    throw new Error("Design packet acceptanceIds must be an array of safe ids");
  }
  if (packet.tasks.length === 0) throw new Error("Design packet tasks must be non-empty");
  const forbiddenKey = /^(?:shell|command|commands|script)$/i;
  function rejectForbiddenKeys(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (forbiddenKey.test(key)) throw new Error("Design packet may not embed shell commands");
      rejectForbiddenKeys(nested);
    }
  }
  rejectForbiddenKeys(packet);
  const runDir = safeJoin(root, "runs", runId);
  const target = ledgerPath(runDir);
  const existing = await readJson(root, target);
  const existingById = new Map((existing.tasks ?? []).map((task) => [task.id, task]));
  const taskKeys = new Set(["id", "goal", "dependsOn", "requiredEvidence", "attemptBudget"]);
  const packetStages = packet.tasks.map((task) => {
    if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error("Design packet task must be an object");
    const unknown = Object.keys(task).filter((key) => !taskKeys.has(key));
    if (unknown.length > 0) throw new Error(`Design packet task ${task.id ?? "unknown"} contains unknown field(s): ${unknown.sort().join(", ")}`);
    const existingTask = existingById.get(String(task.id ?? ""));
    if (!existingTask) throw new Error(`Design packet task is not in the static ledger: ${task.id ?? "unknown"}`);
    return { ...task, kind: existingTask.kind };
  });
  const tasks = packetStages.map(normalizeStage);
  assertStaticTasks(tasks);
  if (existing.tasks && JSON.stringify(existing.tasks) !== JSON.stringify(tasks)) {
    throw new Error("Compiled design packet would drift ledger task identity");
  }
  const next = { ...existing, designPacket: packet, tasks };
  await atomicWriteJson(root, target, next);
  return deriveLedgerStatus(root, runId);
}
