#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  VERSION,
  addEvidence,
  addFinding,
  atomicWriteJson,
  buildContract,
  cleanupRuns,
  consumeActionToken,
  createRun,
  digestObject,
  ensureStateRoot,
  evaluateCompletion,
  getStateRoot,
  inspectRun,
  issueActionToken,
  listJsonRecords,
  loadDefaults,
  loadRun,
  nowIso,
  pluginRoot,
  readJson,
  reconcileAction,
  safeJoin,
  setRunStatus,
  sha256,
  updateState,
  validateContract
} from "./lib/core.mjs";
import { captureSentinel, compareSentinels } from "./lib/git.mjs";
import {
  doctorAgy,
  doctorCodex,
  runAgyCritic,
  runCodexCritic
} from "./lib/providers.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(pluginRoot(), "templates");
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(error, code = 1) {
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      },
      null,
      2
    )}\n`
  );
  process.exitCode = code;
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    let key;
    let value;
    if (equal > 2) {
      key = token.slice(2, equal);
      value = token.slice(equal + 1);
    } else {
      key = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }
    if (Object.hasOwn(options, key)) {
      options[key] = Array.isArray(options[key])
        ? [...options[key], value]
        : [options[key], value];
    } else {
      options[key] = value;
    }
  }
  return { positional, options };
}

function values(value, fallback = []) {
  if (value === undefined) return fallback;
  return Array.isArray(value) ? value : [value];
}

function integer(value, fallback = 0) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Expected integer, received: ${value}`);
  return parsed;
}

async function loadTemplate(name) {
  if (!SAFE_LABEL.test(name)) throw new Error(`Invalid template name: ${name}`);
  const target = path.join(TEMPLATE_DIR, `${name}.json`);
  return JSON.parse(await readFile(target, "utf8"));
}

async function listTemplates() {
  const files = (await readdir(TEMPLATE_DIR)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(files.map((name) => loadTemplate(name.slice(0, -5))));
}

async function writeSentinel(root, runId, label, sentinel, suffix = "") {
  if (!SAFE_LABEL.test(label)) throw new Error(`Invalid sentinel label: ${label}`);
  const { runDir } = await loadRun(root, runId);
  const name = suffix ? `${label}.${suffix}.json` : `${label}.json`;
  await atomicWriteJson(root, safeJoin(runDir, "sentinels", name), sentinel);
  return safeJoin(runDir, "sentinels", name);
}

async function captureForRun(root, runId) {
  const defaults = await loadDefaults();
  const run = await loadRun(root, runId);
  return captureSentinel(run.manifest.cwd, run.contract, defaults);
}

function summarizeSentinel(sentinel, manifest) {
  const skippedReasons = {};
  for (const item of sentinel.skipped ?? []) {
    const reason = item.reason ?? "unspecified";
    skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
  }
  return {
    digest: sentinel.digest,
    complete: sentinel.complete,
    manifest,
    checkedAt: sentinel.checkedAt,
    counts: {
      tracked: sentinel.scopeDigest?.records?.length ?? 0,
      untracked: sentinel.untracked?.records?.length ?? 0,
      submodules: Array.isArray(sentinel.submodules?.value)
        ? sentinel.submodules.value.length
        : 0,
      symlinks: sentinel.symlinks?.records?.length ?? 0,
      attributes: sentinel.attributes?.records?.length ?? 0,
      highRiskIgnored: sentinel.highRiskIgnored?.records?.length ?? 0,
      skipped: sentinel.skipped?.length ?? 0
    },
    skippedReasons,
    uncertainty: sentinel.complete ? null : "bounded-sentinel-incomplete"
  };
}

async function captureCommand(root, runId, label) {
  const sentinel = await captureForRun(root, runId);
  const target = await writeSentinel(root, runId, label, sentinel);
  await updateState(
    root,
    runId,
    (state) => ({
      ...state,
      lastSentinel: { label, digest: sentinel.digest, path: target },
      lastSentinelVerified: true,
      lastSentinelComplete: sentinel.complete
    }),
    "sentinel.captured"
  );
  return { ok: true, runId, label, target, sentinel };
}

async function verifyCommand(root, runId, label) {
  const { runDir } = await loadRun(root, runId);
  const baseline = await readJson(root, safeJoin(runDir, "sentinels", `${label}.json`));
  const current = await captureForRun(root, runId);
  const comparison = compareSentinels(baseline, current);
  if (!comparison.same) {
    const suffix = `after-${Date.now()}`;
    const target = await writeSentinel(root, runId, label, current, suffix);
    await updateState(
      root,
      runId,
      (state) => ({
        ...state,
        status: "indeterminate",
        lastSentinelVerified: false,
        lastSentinelComplete: false,
        sentinelDrift: { label, changed: comparison.changed, currentPath: target }
      }),
      "sentinel.drift"
    );
    return {
      ok: false,
      runId,
      label,
      changed: comparison.changed,
      current: summarizeSentinel(current, target)
    };
  }
  await updateState(
    root,
    runId,
    (state) => ({
      ...state,
      status: state.status === "indeterminate" ? "running" : state.status,
      lastSentinel: { label, digest: current.digest },
      lastSentinelVerified: true,
      lastSentinelComplete: current.complete,
      sentinelDrift: null
    }),
    "sentinel.verified"
  );
  return {
    ok: true,
    runId,
    label,
    digest: current.digest,
    sentinel: summarizeSentinel(current, safeJoin(runDir, "sentinels", `${label}.json`))
  };
}

async function fingerprintPath(cwd, candidate) {
  const absolute = path.resolve(cwd, candidate);
  const relative = path.relative(cwd, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Evidence dependency escapes workspace: ${candidate}`);
  }
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      return {
        path: relative || ".",
        type: "symlink",
        target: await readlink(absolute),
        mode: info.mode
      };
    }
    if (!info.isFile()) {
      return {
        path: relative || ".",
        type: info.isDirectory() ? "directory" : "other",
        mode: info.mode,
        mtimeMs: Math.trunc(info.mtimeMs)
      };
    }
    const contents = await readFile(absolute);
    return {
      path: relative || ".",
      type: "file",
      mode: info.mode,
      size: info.size,
      digest: sha256(contents)
    };
  } catch (error) {
    if (error.code === "ENOENT") return { path: relative || ".", type: "missing" };
    throw error;
  }
}

async function enrichEvidence(root, runId, record) {
  const run = await loadRun(root, runId);
  const inputFiles = values(record.dependencyInputs?.files);
  const files = [];
  for (const candidate of inputFiles) files.push(await fingerprintPath(run.manifest.cwd, candidate));
  return {
    ...record,
    dependencies: {
      contractDigest: run.manifest.contractDigest,
      workflowVersion: VERSION,
      files,
      policyDigest: digestObject({
        authority: run.contract.authority,
        sensitivity: run.contract.sensitivity,
        volatileExclusions: run.contract.volatileExclusions,
        highRiskIgnored: run.contract.highRiskIgnored
      }),
      promptDigest: record.dependencies?.promptDigest ?? null,
      model: record.dependencies?.model ?? null,
      remoteRevision: record.dependencies?.remoteRevision ?? run.contract.remoteRevision ?? null
    }
  };
}

async function refreshEvidence(root, runId) {
  const run = await loadRun(root, runId);
  const evidence = await listJsonRecords(root, safeJoin(run.runDir, "evidence"));
  const stale = [];
  const fresh = [];
  for (const record of evidence) {
    let current = [];
    let isStale =
      record.dependencies?.contractDigest !== run.manifest.contractDigest ||
      record.dependencies?.workflowVersion !== VERSION;
    if (!Array.isArray(record.dependencyInputs?.files)) isStale = true;
    else {
      for (const candidate of record.dependencyInputs.files) {
        current.push(await fingerprintPath(run.manifest.cwd, candidate));
      }
      if (digestObject(current) !== digestObject(record.dependencies?.files ?? [])) isStale = true;
    }
    const next = {
      ...record,
      stale: isStale,
      freshnessCheckedAt: nowIso(),
      currentDependencyFiles: current
    };
    await atomicWriteJson(root, safeJoin(run.runDir, "evidence", `${record.id}.json`), next);
    (isStale ? stale : fresh).push(record.id);
  }
  return { stale, fresh };
}

async function currentVerifiedDigest(root, runId) {
  const run = await loadRun(root, runId);
  if (!run.state.lastSentinelVerified || !run.state.lastSentinel?.label) {
    throw new Error("A verified sentinel is required");
  }
  const verification = await verifyCommand(root, runId, run.state.lastSentinel.label);
  if (!verification.ok) throw new Error("Current tree no longer matches the verified sentinel");
  return verification.digest;
}

async function providerEvidence(root, runId, result, prompt, acceptanceIds) {
  const id = `critic-${result.metadata.provider}-${Date.now()}`;
  const record = {
    id,
    kind: "independent-critic",
    summary: `${result.metadata.provider} ${result.review.verdict}: ${result.review.summary}`,
    status: "complete",
    acceptanceIds,
    sourceDigest: sha256(prompt),
    dependencyInputs: { files: [] },
    dependencies: {
      promptDigest: sha256(prompt),
      model: result.metadata.requestedModel
    },
    producer: result.metadata,
    review: result.review
  };
  return addEvidence(root, runId, await enrichEvidence(root, runId, record));
}

async function commandRun(root, options) {
  const templateName = String(options.template ?? "");
  const template = await loadTemplate(templateName);
  let contract;
  if (options.contract) {
    contract = validateContract(JSON.parse(await readFile(path.resolve(String(options.contract)), "utf8")));
    if (contract.template !== templateName) throw new Error("Contract template does not match --template");
  } else {
    contract = buildContract({
      template: templateName,
      templateDefinition: template,
      goal: String(options.goal ?? `${templateName} workflow`),
      scope: values(options.scope, ["."]).map(String),
      risk: {
        risk: integer(options.risk),
        uncertainty: integer(options.uncertainty),
        blastRadius: integer(options["blast-radius"]),
        irreversibility: integer(options.irreversibility),
        evidenceGap: integer(options["evidence-gap"])
      },
      sensitivity: String(options.sensitivity ?? "internal"),
      authority: values(options.authority).map(String),
      agyAllowed: options["allow-agy"] === true || options["allow-agy"] === "true",
      agySanitized: options.sanitized === true || options.sanitized === "true",
      volatileExclusions: values(options["volatile-exclusion"]).map(String),
      highRiskIgnored: values(options["high-risk-ignored"]).map(String),
      remoteRevision: options["remote-revision"] ? String(options["remote-revision"]) : null
    });
    if (options["require-agy"] === true || options["require-agy"] === "true") {
      contract.agy.required = true;
    }
  }
  const result = await createRun({
    root,
    contract,
    requestedMode: String(options.mode ?? "auto"),
    cwd: process.cwd()
  });
  if (result.direct) {
    return {
      ok: true,
      ...result,
      instruction: "Direct mode: continue in the root without helper state or subagents."
    };
  }
  const initial = await captureCommand(root, result.runId, "initial");
  return {
    ok: true,
    ...result,
    sentinel: summarizeSentinel(initial.sentinel, initial.target)
  };
}

async function commandDoctor(root, options) {
  await ensureStateRoot(root);
  const info = await stat(root);
  const defaults = await loadDefaults();
  const codex = await doctorCodex().catch((error) => ({ ok: false, error: error.message }));
  let agy = { ok: null, skipped: true };
  if (options.agy === true || options.agy === "true") {
    agy = await doctorAgy({
      model: String(options.model ?? defaults.providers.agy.primaryModel)
    }).catch((error) => ({ ok: false, error: error.message }));
  }
  return {
    ok: codex.ok && (agy.ok !== false),
    version: VERSION,
    stateRoot: root,
    stateMode: (info.mode & 0o777).toString(8),
    codex,
    agy,
    agyPolicy: {
      transport: defaults.providers.agy.transport,
      confidentialAllowed: false,
      maxPromptBytes: defaults.providers.agy.maxPromptBytes
    }
  };
}

async function commandEval() {
  const tests = (await readdir(path.join(SCRIPT_DIR, "tests")))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => path.join(SCRIPT_DIR, "tests", name));
  if (tests.length === 0) throw new Error("No tests found");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", ...tests], {
      cwd: pluginRoot(),
      shell: false,
      stdio: "inherit",
      env: process.env
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, tests: "passed" });
      else reject(new Error(`Test suite failed with exit ${code}`));
    });
  });
}

function help() {
  return {
    usage: [
      "dw run --template <name> --mode <auto|direct|verified|deep|critical> --goal <text> [--scope <path>]",
      "dw status <run-id>",
      "dw inspect <run-id>",
      "dw resume <run-id>",
      "dw cancel <run-id> [--reason <text>]",
      "dw sentinel capture|verify <run-id> --label <label>",
      "dw evidence add <run-id> --file <json>",
      "dw finding add|update <run-id> --file <json>",
      "dw critic codex|agy <run-id> --model <model> --prompt-file <file>",
      "dw action issue|consume|reconcile <run-id> ...",
      "dw complete <run-id>",
      "dw doctor [--agy --model <model>]",
      "dw eval",
      "dw cleanup [--older-than-days 30] [--apply]",
      "dw templates"
    ]
  };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [command, subcommand, runId] = positional;
  const root = getStateRoot();
  if (!command || command === "help" || options.help) return help();
  if (command === "templates") return { ok: true, templates: await listTemplates() };
  if (command === "run") return commandRun(root, options);
  if (command === "status") {
    const run = await loadRun(root, subcommand);
    return {
      ok: true,
      runId: subcommand,
      template: run.manifest.template,
      mode: run.manifest.mode,
      status: run.state.status,
      updatedAt: run.state.updatedAt,
      lastSentinelVerified: run.state.lastSentinelVerified,
      lastSentinelComplete: run.state.lastSentinelComplete === true
    };
  }
  if (command === "inspect") return { ok: true, ...(await inspectRun(root, subcommand)) };
  if (command === "cancel") {
    return {
      ok: true,
      state: await setRunStatus(root, subcommand, "cancelled_superseded", {
        cancellationReason: String(options.reason ?? "cancelled by root")
      })
    };
  }
  if (command === "resume") {
    const run = await loadRun(root, subcommand);
    const freshness = await refreshEvidence(root, subcommand);
    const sentinel = await captureForRun(root, subcommand);
    const same = run.state.lastSentinel?.digest === sentinel.digest;
    const status = same ? "running" : "stale";
    await setRunStatus(root, subcommand, status, {
      lastSentinelVerified: same,
      lastSentinelComplete: same && sentinel.complete,
      resumeFreshness: freshness
    });
    return { ok: same, runId: subcommand, status, freshness, currentDigest: sentinel.digest };
  }
  if (command === "sentinel") {
    if (!runId || !options.label) throw new Error("sentinel requires run id and --label");
    if (subcommand === "capture") {
      const captured = await captureCommand(root, runId, String(options.label));
      return {
        ok: true,
        runId: captured.runId,
        label: captured.label,
        sentinel: summarizeSentinel(captured.sentinel, captured.target)
      };
    }
    if (subcommand === "verify") return verifyCommand(root, runId, String(options.label));
    throw new Error("sentinel subcommand must be capture or verify");
  }
  if (command === "evidence") {
    if (subcommand !== "add" || !runId || !options.file) {
      throw new Error("evidence usage: dw evidence add <run-id> --file <json>");
    }
    const record = JSON.parse(await readFile(path.resolve(String(options.file)), "utf8"));
    return { ok: true, evidence: await addEvidence(root, runId, await enrichEvidence(root, runId, record)) };
  }
  if (command === "finding") {
    if (!["add", "update"].includes(subcommand) || !runId || !options.file) {
      throw new Error("finding usage: dw finding add|update <run-id> --file <json>");
    }
    const record = JSON.parse(await readFile(path.resolve(String(options.file)), "utf8"));
    return {
      ok: true,
      finding: await addFinding(root, runId, record, { update: subcommand === "update" })
    };
  }
  if (command === "critic") {
    if (!["codex", "agy"].includes(subcommand) || !runId || !options["prompt-file"]) {
      throw new Error("critic usage: dw critic codex|agy <run-id> --model <model> --prompt-file <file>");
    }
    const run = await loadRun(root, runId);
    const prompt = await readFile(path.resolve(String(options["prompt-file"])), "utf8");
    const acceptanceIds = values(options.acceptance, run.contract.acceptance.map((item) => item.id)).map(String);
    const defaults = await loadDefaults();
    try {
      if (subcommand === "codex" && !options.model) {
        throw new Error("Codex critic requires --model");
      }
      const result =
        subcommand === "codex"
          ? await runCodexCritic({
              model: String(options.model),
              effort: String(options.effort ?? "high"),
              prompt
            })
          : await runAgyCritic({
              model: String(options.model ?? defaults.providers.agy.primaryModel),
              prompt,
              contract: run.contract,
              config: defaults
            });
      const evidence = await providerEvidence(root, runId, result, prompt, acceptanceIds);
      return { ok: true, evidence, review: result.review, metadata: result.metadata };
    } catch (error) {
      if (subcommand === "agy" && run.manifest.mode === "critical") {
        await setRunStatus(root, runId, "blocked_external_reviewer", {
          externalReviewerError: error.message
        });
      }
      throw error;
    }
  }
  if (command === "action") {
    if (!runId) throw new Error("action requires run id");
    if (subcommand === "issue") {
      const run = await loadRun(root, runId);
      const template = await loadTemplate(run.manifest.template);
      const action = String(options.action ?? "");
      const requiredEvidence = template.actionGates?.[action];
      if (!Array.isArray(requiredEvidence) || requiredEvidence.length === 0) {
        throw new Error(`No pre-action evidence gate is defined for: ${action}`);
      }
      const digest = await currentVerifiedDigest(root, runId);
      const defaults = await loadDefaults();
      return {
        ok: true,
        action: await issueActionToken(
          root,
          runId,
          {
            action,
            provider: String(options.provider ?? ""),
            resource: String(options.resource ?? ""),
            scope: options.scope ? String(options.scope) : undefined,
            remoteRevision: String(options["remote-revision"] ?? ""),
            ttlSeconds: options.ttl ? integer(options.ttl) : undefined,
            requiredEvidence
          },
          digest,
          defaults
        )
      };
    }
    if (subcommand === "consume") {
      if (!options.token) throw new Error("action consume requires --token");
      const digest = await currentVerifiedDigest(root, runId);
      return {
        ok: true,
        action: await consumeActionToken(root, runId, String(options.token), digest)
      };
    }
    if (subcommand === "reconcile") {
      if (!options.attempt || !options.outcome) {
        throw new Error("action reconcile requires --attempt and --outcome");
      }
      return {
        ok: true,
        action: await reconcileAction(
          root,
          runId,
          String(options.attempt),
          String(options.outcome),
          options.receipt ? String(options.receipt) : null
        )
      };
    }
    throw new Error("action subcommand must be issue, consume, or reconcile");
  }
  if (command === "complete") {
    const run = await loadRun(root, subcommand);
    if (!run.state.lastSentinel?.label) throw new Error("No sentinel is available for completion");
    const current = await verifyCommand(root, subcommand, run.state.lastSentinel.label);
    if (!current.ok) return { ok: false, status: "indeterminate", changed: current.changed };
    const result = await evaluateCompletion(root, subcommand);
    if (!result.ok) {
      await setRunStatus(root, subcommand, "inconclusive", { completionBlockers: result.blockers });
      return { ok: false, status: "inconclusive", blockers: result.blockers };
    }
    const state = await setRunStatus(root, subcommand, "completed", { completedAt: nowIso() });
    return { ok: true, state };
  }
  if (command === "doctor") return commandDoctor(root, options);
  if (command === "eval") return commandEval();
  if (command === "cleanup") {
    const defaults = await loadDefaults();
    return cleanupRuns(root, {
      olderThanDays: integer(options["older-than-days"], defaults.retentionDays),
      apply: options.apply === true || options.apply === "true"
    });
  }
  throw new Error(`Unknown command: ${command}`);
}

main()
  .then((result) => {
    print(result);
    if (result?.ok === false) process.exitCode = 2;
  })
  .catch((error) => fail(error));
