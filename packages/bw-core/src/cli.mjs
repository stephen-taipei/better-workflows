import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { completionStatus, describeEvidence, recordEvidence } from "./evidence.mjs";
import { evaluateCommand } from "./actions.mjs";
import { readLedger, verifyLedger } from "./ledger.mjs";
import { loadPolicy, POLICY_PATH } from "./policy.mjs";
import { reconcileManually, reconcileOpen } from "./reconcile.mjs";
import { openRepo, headCommit, treeState, worktreeTree } from "./repo.mjs";
import { loadState, openActions } from "./state.mjs";

const USAGE = `Usage: bw <command>

  status                         Evidence, open actions and policy for this repository
  init                           Write ${POLICY_PATH} (requires passing tests to complete)
  run --kind <kind> -- <cmd...>  Run a command and record its result as evidence
  check-completion               Exit 0 when required evidence is fresh, 2 otherwise
  check-command <command line>   Decide whether a command may run (exit 0 allow, 2 deny, 3 ask)
  reconcile                      Check unfinished or unknown actions with read-only probes
  reconcile <id> --outcome success|failed --note <text>
                                 Settle an action by hand after checking it yourself
  verify                         Verify the ledger hash chain
  log [--limit n]                Print recent ledger entries`;

class UsageError extends Error {}

function print(io, value, json) {
  io.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${value}\n`);
}

function takeFlag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined) throw new UsageError(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

async function requireRepo(cwd) {
  const repo = await openRepo(cwd);
  if (!repo) throw new UsageError("Not inside a Git work tree");
  return repo;
}

function runInherited(argv, cwd) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code, signal) => resolve(signal ? null : code));
  });
}

const COMMANDS = {
  async status(args, { cwd, io }) {
    const json = args.includes("--json");
    const repo = await requireRepo(cwd);
    const [policyInfo, state, { head, tree }] = await Promise.all([loadPolicy(repo), loadState(repo), treeState(repo)]);
    const completion = completionStatus(state, policyInfo.policy, tree);
    const open = openActions(state).map(({ id, kind, status, command }) => ({ id, kind, status, command }));
    const result = { head, tree, policy: { source: policyInfo.source, error: policyInfo.error }, completion, openActions: open };
    if (json) return print(io, result, true), 0;
    const lines = [`HEAD ${head ?? "(none)"}  tree ${tree}`, `policy: ${policyInfo.source}${policyInfo.error ? ` (${policyInfo.error})` : ""}`];
    lines.push(completion.results.length ? "completion evidence:" : "completion evidence: none required");
    for (const item of completion.results) lines.push(`  ${item.status === "fresh" ? "✓" : "✗"} ${describeEvidence(item)}`);
    lines.push(open.length ? "open actions:" : "open actions: none");
    for (const action of open) lines.push(`  ${action.id} ${action.kind} ${action.status}: ${action.command}`);
    print(io, lines.join("\n"));
    return 0;
  },

  async init(args, { cwd, io }) {
    const repo = await requireRepo(cwd);
    const file = path.join(repo.root, POLICY_PATH);
    await mkdir(path.dirname(file), { recursive: true });
    const policy = { version: 1, completion: { require: ["test"] }, actions: { default: "ask", rules: {} }, opaque: "ask" };
    try {
      await writeFile(file, `${JSON.stringify(policy, null, 2)}\n`, { flag: "wx" });
    } catch (error) {
      if (error.code === "EEXIST") throw new UsageError(`${POLICY_PATH} already exists`);
      throw error;
    }
    print(io, `Wrote ${POLICY_PATH}`);
    return 0;
  },

  async run(args, { cwd, io }) {
    const dash = args.indexOf("--");
    if (dash < 0 || dash === args.length - 1) throw new UsageError("run needs -- followed by the command");
    const command = args.slice(dash + 1);
    const options = args.slice(0, dash);
    const kind = takeFlag(options, "--kind");
    if (!kind) throw new UsageError("run needs --kind");
    const repo = await requireRepo(cwd);
    const treeBefore = await worktreeTree(repo);
    const exitCode = await runInherited(command, cwd);
    const [treeAfter, head] = await Promise.all([worktreeTree(repo), headCommit(repo)]);
    await recordEvidence(repo, { kind, command: command.join(" "), exitCode, treeBefore, treeAfter, head, host: "cli" });
    io.stderr.write(`bw: recorded ${kind} evidence (exit ${exitCode ?? "signal"})${treeBefore !== treeAfter ? "; files changed during the run" : ""}\n`);
    return exitCode ?? 1;
  },

  async "check-completion"(args, { cwd, io }) {
    const repo = await requireRepo(cwd);
    const [policyInfo, state, tree] = await Promise.all([loadPolicy(repo), loadState(repo), worktreeTree(repo)]);
    const completion = completionStatus(state, policyInfo.policy, tree);
    if (args.includes("--json")) print(io, completion, true);
    else for (const item of completion.results) print(io, `${item.status === "fresh" ? "✓" : "✗"} ${describeEvidence(item)}`);
    return completion.ok ? 0 : 2;
  },

  async "check-command"(args, { cwd, io }) {
    if (!args.length) throw new UsageError("check-command needs a command line");
    const repo = await requireRepo(cwd);
    const [policyInfo, state, head] = await Promise.all([loadPolicy(repo), loadState(repo), headCommit(repo)]);
    const result = evaluateCommand({ command: args.join(" "), policyInfo, state, head });
    print(io, { decision: result.decision, reasons: result.reasons, actions: result.actions.map((a) => a.kind) }, true);
    return { allow: 0, deny: 2, ask: 3 }[result.decision];
  },

  async reconcile(args, { cwd, io }) {
    const repo = await requireRepo(cwd);
    if (args.length && !args[0].startsWith("--")) {
      const id = args.shift();
      const outcome = takeFlag(args, "--outcome");
      const note = takeFlag(args, "--note");
      await reconcileManually(repo, id, outcome, note);
      print(io, `${id} reconciled as ${outcome}`);
      return 0;
    }
    const results = await reconcileOpen(repo);
    if (!results.length) print(io, "No open actions.");
    for (const result of results) print(io, `${result.id} ${result.kind}: ${result.outcome} (${result.detail})`);
    return results.some((result) => result.outcome === "unknown") ? 2 : 0;
  },

  async verify(args, { cwd, io }) {
    const result = await verifyLedger(await requireRepo(cwd));
    print(io, result.ok ? `Ledger OK: ${result.entries} entries, head ${result.head}` : `Ledger BROKEN: ${result.error}`);
    return result.ok ? 0 : 2;
  },

  async log(args, { cwd, io }) {
    const limit = Number(takeFlag(args, "--limit") ?? 20);
    const entries = await readLedger(await requireRepo(cwd));
    for (const entry of entries.slice(-limit)) print(io, `${entry.seq} ${entry.at} ${entry.type} ${JSON.stringify(entry.data)}`);
    return 0;
  },
};

export async function main(argv, { cwd = process.cwd(), io = process } = {}) {
  const [name, ...args] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    print(io, USAGE);
    return name ? 0 : 1;
  }
  const command = COMMANDS[name];
  if (!command) {
    io.stderr.write(`bw: unknown command ${name}\n\n${USAGE}\n`);
    return 1;
  }
  try {
    return await command(args, { cwd, io });
  } catch (error) {
    io.stderr.write(`bw: ${error.message}\n`);
    return error instanceof UsageError ? 1 : 2;
  }
}
