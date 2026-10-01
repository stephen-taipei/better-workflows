// SPDX-License-Identifier: AGPL-3.0-only
import path from "node:path";

const FLAGS = ["formal", "formal-child", "formal-full"];
const PARENT = ["expected-head", "expected-base", "launch-root", "replacement-reason"];
const FULL = ["node22", "node24", "predecessor-completion"];
const REASONS = new Set(["host-sleep", "sandbox-host-capability", "launch-environment", "command-interruption"]);
const own = (value, key) => Object.hasOwn(value, key);
const absolute = value => typeof value === "string" && !value.includes("\0") && path.isAbsolute(value) && path.resolve(value) === value;

// Pure admission before automatic-update hooks or evaluator dispatch. Missing,
// duplicate and false mode flags must never silently become a bare evaluation.
export function parseEvalInvocation(positional, options) {
  if (!Array.isArray(positional) || positional.length !== 1 || positional[0] !== "eval" ||
      !options || typeof options !== "object" || Array.isArray(options)) throw new Error("eval accepts no extra positional arguments");
  for (const [key, value] of Object.entries(options)) {
    if (![...FLAGS, ...PARENT, ...FULL].includes(key)) throw new Error(`Unknown eval option --${key}`);
    if (Array.isArray(value)) throw new Error(`Duplicate eval option --${key}`);
  }
  const modes = FLAGS.filter(key => own(options, key));
  if (modes.length > 1) throw new Error("Formal evaluator modes are mutually exclusive");
  if (modes.some(key => options[key] !== true && options[key] !== "true")) throw new Error("Formal evaluator mode flags must be true");
  const mode = modes[0] ?? "bare";
  if (mode === "bare" || mode === "formal-child") {
    if ([...PARENT, ...FULL].some(key => own(options, key))) throw new Error("Evaluator parent bindings require --formal or --formal-full");
    return { mode, bindings: {} };
  }
  if (mode !== "formal-full" && FULL.some(key => own(options, key))) throw new Error("Full evaluator bindings require --formal-full");
  const required = ["expected-head", "expected-base", "launch-root", ...(mode === "formal-full" ? ["node22", "node24"] : [])];
  for (const key of required) {
    if (typeof options[key] !== "string" || !options[key]) throw new Error(`Formal evaluator requires one value for --${key}`);
  }
  for (const key of ["expected-head", "expected-base"]) {
    if (!/^[a-f0-9]{40}$/.test(options[key])) throw new Error(`Formal evaluator requires a complete SHA for --${key}`);
  }
  if (!absolute(options["launch-root"]) || !/^\/private\/tmp\/bw-[A-Za-z0-9._-]+-formal-eval-[A-Za-z0-9._-]+$/.test(options["launch-root"])) {
    throw new Error("Formal evaluator launch root must be a canonical /private/tmp/bw-*-formal-eval-* path");
  }
  if (own(options, "replacement-reason") && !REASONS.has(options["replacement-reason"])) throw new Error("Formal evaluator replacement reason is invalid");
  const bindings = { expectedHead: options["expected-head"], expectedBase: options["expected-base"],
    launchRoot: options["launch-root"], replacementReason: options["replacement-reason"] ?? null };
  if (mode === "formal-full") {
    if (![options.node22, options.node24].every(absolute)) throw new Error("Full evaluator runtime paths must be canonical absolute paths");
    bindings.nodePaths = { node22: options.node22, node24: options.node24 };
    if (own(options, "predecessor-completion")) {
      if (!absolute(options["predecessor-completion"]) || !bindings.replacementReason) throw new Error("Full evaluator predecessor completion requires an absolute path and replacement reason");
      bindings.predecessorCompletionPath = options["predecessor-completion"];
    }
  }
  return { mode, bindings };
}

export function fullFormalCliResult(result) {
  return { ...result, ok: result?.schemaVersion === 1 && result.kind === "FullFormalCompletionV1" &&
    result.operationCompletion === "OBSERVED" && result.qualificationStatus === "passed" && result.releaseEligible === false };
}

// Thin routing only. The production handlers retain all runtime admission,
// source, shared-budget, cleanup and completion checks.
export async function runEvalCommand(positional, options, context, handlers) {
  const { mode, bindings } = parseEvalInvocation(positional, options);
  if (mode === "bare" || mode === "formal-child") return handlers.suites();
  const common = { cwd: context.cwd, scriptPath: context.scriptPath, ...bindings };
  if (mode === "formal") return handlers.legacy({ ...common, nodePath: context.nodePath });
  return fullFormalCliResult(await handlers.full(common));
}
