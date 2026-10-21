# Building on Better Workflows Core

[繁體中文（台灣）](sdk.zh-TW.md)

This guide is for developers who want their own tool, script or AI agent host to use the same checks the Claude Code plugin uses: completion only on fresh evidence, side effects gated by a policy, and results that never came back settled before anything else runs.

Status: alpha (`6.0.0-alpha.2`). Everything here may change before beta. The [host adapter contract](#5-writing-a-host-adapter-draft) is a draft and is marked as such.

You need Node.js 22.14 or later and Git. Core has no other dependencies.

## Contents

1. [Three ways to integrate](#1-three-ways-to-integrate)
2. [The model in five ideas](#2-the-model-in-five-ideas)
3. [Integrating through the CLI](#3-integrating-through-the-cli)
4. [Integrating through the JavaScript API](#4-integrating-through-the-javascript-api)
5. [Writing a host adapter (draft)](#5-writing-a-host-adapter-draft)
6. [Reference](#6-reference)
7. [Rules that keep the guarantees](#7-rules-that-keep-the-guarantees)

## 1. Three ways to integrate

| You are building | Use | Effort |
|---|---|---|
| A CI job, a release script, a Git hook | The `bw` CLI and its exit codes | Minutes |
| A tool in Node.js that runs commands for someone | The JavaScript API (`import … from "@better-workflows/core"`) | An hour |
| Support for another AI coding agent | A host adapter on top of the API | Days, plus testing on the real agent |

Start with the smallest one that does the job. The CLI already covers most checks a script needs.

## 2. The model in five ideas

Everything Core does follows from five ideas. Once they are clear, the API reads naturally.

**Repository.** Core works inside one Git work tree. `openRepo(cwd)` finds it and returns `{ root, gitDir, commonDir, stateDir }`. Outside a Git work tree it returns `null`, and every integration should then do nothing.

**Policy.** `.better-workflows/policy.json`, written and committed by a person. It says which evidence completion needs (`completion.require`), which commands count as which evidence (`evidence.kinds`), and whether each kind of side effect is `allow`, `ask` or `deny` (`actions`). The agent may read it but never change it. A missing file means defaults; an invalid file means every side effect is denied.

**Ledger.** An append-only, hash-chained log in `.git/better-workflows/ledger.jsonl`. Every fact Core knows is an entry in it. State is never stored separately: `loadState(repo)` folds the ledger into current evidence and actions every time. Because it lives under `.git/`, it is never committed.

**Evidence.** A record that a check ran: its kind (`test`, `lint` …), exit code, and the Git tree of the working files before and after. Evidence is **fresh** only when it passed and its tree is the current tree. Edit one file and the earlier pass becomes **stale**. Completion is allowed when every required kind is fresh.

```text
missing ──run──▶ fresh ──edit──▶ stale ──run again──▶ fresh
              └─ failed / unstable / unattributed (does not count)
```

**Action.** A side effect someone outside the repository can see: `git push`, `gh pr merge`, `npm publish`, a `curl -X POST`, or a command the policy names. Before it runs, Core records `action.begun`; after, `action.ended`. Only exit code 0 is a known success. Anything else, including a timeout or a crash, is **unknown**, because the push may have reached the remote before the connection dropped. While any action is pending or unknown, every further side effect is denied until a read-only probe or a person settles it (`reconcile`). The same action at the same commit is never run twice.

```text
begun ──exit 0──▶ success
  └──── other / none ──▶ unknown ──probe or person──▶ success | failed
```

## 3. Integrating through the CLI

Install once: `npm install -g @better-workflows/core@alpha`. Every command works from anywhere inside the repository.

| Command | Exit codes | Typical use |
|---|---|---|
| `bw check-completion [--json]` | 0 all required evidence fresh, 2 not | Fail a CI job or a release script that would ship untested files |
| `bw check-command <command line>` | 0 allow, 2 deny, 3 ask; prints JSON | Ask Core about a command without running it |
| `bw run --kind <kind> -- <cmd…>` | the command's own exit code | Run a check and record it as evidence. Meant for people and scripts, not for the agent |
| `bw status [--json]` | 0 | Evidence, open actions, policy and the last session |
| `bw reconcile` | 0 all settled, 2 some still unknown | Let the read-only probes settle open actions |
| `bw verify` | 0 chain intact, 2 broken | Check the ledger has not been edited |
| `bw log [--limit n]` | 0 | Print recent ledger entries |

Apart from `bw run`, which passes on its command's exit code, exit 1 means a usage error (wrong arguments, not in a Git work tree) and an internal error exits 2 with a `bw:` message on stderr. When 2 could mean either, read stderr.

A release script that refuses to publish untested files:

```bash
set -e
bw run --kind test -- npm test
bw check-completion
npm publish
```

`bw check-command` lets a tool written in any language consult Core without importing it:

```console
$ bw check-command git push origin main
{
  "decision": "ask",
  "reasons": [
    "git-push: policy default is ask"
  ],
  "actions": [
    "git-push"
  ]
}
$ echo $?
3
```

`check-command` only decides. It records nothing, so it cannot stop a repeat on its own. To record and run, use the API (next section).

## 4. Integrating through the JavaScript API

```js
import { openRepo, headCommit, loadPolicy, loadState, evaluateCommand } from "@better-workflows/core";
```

The package is ESM only.

### 4.1 Ask whether a command may run

```js
const repo = await openRepo(process.cwd());
if (!repo) process.exit(0); // not a Git work tree: stay out of the way

const policyInfo = await loadPolicy(repo);
const evaluation = evaluateCommand({
  command: "git push origin main",
  policyInfo,
  state: await loadState(repo),
  head: await headCommit(repo),
});
// evaluation.decision  "allow" | "ask" | "deny"
// evaluation.reasons   strings a person can read
// evaluation.actions   [{ kind, argv, target }]   side effects found on the line
// evaluation.evidence  [{ kind, argv, attributable, where }]   checks found on the line
// evaluation.opaque    true when the line uses $(…), eval or a nested shell
```

`evaluateCommand` is pure: it reads the state you pass and writes nothing. You can call it as often as you like.

`allow` means Core has no objection. It never grants anything: your tool's own permission rules still apply. `ask` means a person should confirm. `deny` means do not run it.

### 4.2 The full cycle: decide, record, run, report

A tool that runs the command itself has four steps. The example [`examples/sdk/guarded-run.mjs`](../examples/sdk/guarded-run.mjs) does all four in under 100 lines, and the test suite runs it, so it stays correct.

```bash
node examples/sdk/guarded-run.mjs -- npm test
node examples/sdk/guarded-run.mjs -- git push origin main
node examples/sdk/guarded-run.mjs --yes -- npm publish
```

The steps, with the code from that file:

**1. Decide, after settling what is open.**

```js
let evaluation = await decide();
if ((evaluation.actions.length || evaluation.opaque) && openActions(await loadState(repo)).length) {
  await reconcileOpen(repo);     // read-only probes: git ls-remote, gh pr view, npm view …
  evaluation = await decide();
}
if (evaluation.decision === "deny") refuse(2, "denied");
```

**2. Record each side effect before it runs, under the ledger lock.** Two processes can decide at the same moment. Deciding again inside `withLedgerLock` and recording in the same step makes sure only one of them starts the push.

```js
evaluation = await withLedgerLock(repo, async () => {
  const latest = await decide();
  if (latest.decision !== "deny") ids = await beginActions(repo, latest, { command, tree: treeBefore, policyDigest: policyInfo.digest, host: HOST });
  return latest;
});
```

**3. Run the command.** Take the tree before it (`worktreeTree`) so evidence can prove which files it ran on.

**4. Report what happened.** Pass the real exit code, or `null` when you do not know it (killed by a signal, the process vanished). Core turns anything but 0 into `unknown`.

```js
if (ids.length) await endActions(repo, ids, { exitCode, detail });
await recordEvidence(repo, { kind, command, exitCode, excluded, treeBefore, treeAfter, head, host: HOST });
```

`excluded` says why a run cannot count even if it exited 0: `"exit-code"` when the line's exit code belongs to another command (`npm test | tail`), `"directory"` when an exact rule's command ran outside the directory the policy names. Use `evaluation.evidence[i].attributable` and `.where` to work it out; the example shows how.

### 4.3 Check completion

```js
const { policy } = await loadPolicy(repo);
const tree = await worktreeTree(repo, { ignore: policy.evidence.ignore });
const completion = completionStatus(await loadState(repo), policy, await snapshot(repo, policy, tree));
if (!completion.ok) {
  for (const result of completion.results) console.log(describeEvidence(result));
}
```

Each result's `status` is one of `fresh`, `stale`, `failed`, `unstable` (files changed while it ran), `unattributed` (see `excluded` above) or `missing`.

## 5. Writing a host adapter (draft)

> **Draft.** Claude Code and the experimental [Codex adapter](codex.md) share host-neutral lifecycle logic in `src/adapters/shared.mjs`. Adapters normalize events and format host responses; raw host payloads do not enter the shared layer. This internal contract may change before beta.

A wrapper like `guarded-run` only protects commands sent through it; the agent can still run `git push` directly. An adapter is different: the agent host itself calls Core before every tool call and obeys the answer, so nothing slips past.

### 5.1 What the host must offer

Check these against the host's documentation and then on the real host, before writing any code. If one of the first three is missing, the host can only get advisory support.

| Capability | Why Core needs it |
|---|---|
| A hook **before** each shell command that can refuse it, and the host does refuse (fails closed) | Without it, nothing can stop a repeated push |
| The command's **final exit code** after it runs, or a clear signal that it did not finish | Evidence and action results depend on it; a guessed 0 is worse than `null` |
| Stable **session id** and **tool call id** on both sides of the call | To match the "after" event with the action recorded "before" |
| A hook when the agent **stops** that can send it back | To refuse "done" on stale evidence |
| A hook before **file edits** with the target path | To keep the agent out of the policy and the ledger |

Some hosts treat an `ask` answer as `allow`. For those, the adapter must turn `ask` into `deny`.

### 5.2 Event mapping

| Host event | Adapter does | Claude Code event |
|---|---|---|
| Session starts | `appendEvent("session.started", …)`; tell the agent which evidence is required and which actions are open | `SessionStart` |
| Before a file edit | Deny edits under `.better-workflows/` or the Git directory | `PreToolUse` (Edit, Write …) |
| Before a shell command | Deny commands that change protected paths or run `bw init`, `bw run` or `bw reconcile <id>`; then the cycle in [4.2](#42-the-full-cycle-decide-record-run-report) steps 1–2; save the "before" tree for evidence | `PreToolUse` (Bash) |
| After a shell command | Steps in 4.2 step 4, with the exit code only when the host states it | `PostToolUse`, `PostToolUseFailure` |
| The person refused the call at the host's own prompt | If the host proves the command never ran, close the action as `failed` (the Claude Code adapter reads the refusal from the transcript); without proof it stays `unknown` | Read from the transcript at the next event |
| Agent stops | `completionStatus`; if not ok, send it back once with `describeEvidence` lines and record `completion.blocked` | `Stop` |

### 5.3 Skeleton

```js
// src/adapters/<host>.mjs — sketch, not a working adapter
const HOST = "<host>";

export async function handleHook(input) {
  let repo;
  try {
    repo = await openRepo(input.cwd);
    if (!repo) return allow();
    switch (normalizeEventName(input)) {
      case "before-shell": return await beforeShell(repo, normalize(input));
      case "after-shell":  return await afterShell(repo, normalize(input));
      // session-start, before-edit, stop …
    }
    return allow();
  } catch (error) {
    // Never crash: an adapter that throws leaves the host guessing. Before a
    // shell command with a side effect, an internal error must become deny.
    return isSideEffect(input) ? deny(`Better Workflows hook error: ${error.message}`) : allow();
  }
}

// What the shared layer will receive. Every field the host cannot state
// with certainty is null, never a guess.
function normalize(input) {
  return {
    host: HOST,
    sessionId: input.session ?? null,
    toolUseId: input.call_id ?? null,
    command: input.command ?? "",
    cwd: input.cwd,
    finalExitCode: Number.isInteger(input.exit_code) ? input.exit_code : null,
  };
}
```

### 5.4 Testing an adapter

- Record real event JSON from the host into fixtures (success, non-zero exit, interrupted, refused by the person, a long command). Test against those, not against what the documentation suggests.
- Replay [the stale-green demo](../examples/stale-green/demo.mjs) steps through your adapter: stale pass blocked, repeated push refused, unknown deploy blocks the next side effect.
- Prove that every unclear case ends as `null` and `unknown`, never as a pass or a success.

## 6. Reference

### 6.1 Exports

| Export | Signature (abridged) | Returns |
|---|---|---|
| `openRepo` | `(cwd)` | `{ root, gitDir, commonDir, stateDir }` or `null` |
| `headCommit`, `currentBranch` | `(repo)` | commit id / branch name, or `null` |
| `worktreeTree` | `(repo, { ignore })` | Git tree id of the working files, untracked included; never touches the person's index |
| `subtreeDigests` | `(repo, tree, paths)` | `{ path: id or null }` |
| `treeState` | `(repo, { ignore })` | `{ head, tree }` |
| `loadPolicy` | `(repo)` | `{ policy, digest, source, error }`; `source` is the file path, `"default"` or `"invalid"` |
| `normalizePolicy`, `defaultPolicy` | `(raw)`, `()` | normalized policy; `normalizePolicy` throws on invalid input |
| `ruleFor` | `(policy, kind, now?)` | `{ decision, reason }`, with expired authorizations turned into `ask` |
| `POLICY_PATH` | | `".better-workflows/policy.json"` |
| `splitCommand` | `(line)` | `{ commands, attributable, directories, opaque, changesDirectory }` |
| `classifyCommand` | `(line, policy)` | `{ commands, actions, evidence, opaque, changesDirectory }` |
| `BUILTIN_ACTION_KINDS` | | `git-push`, `gh-pr-merge`, `gh-pr-create`, `gh-release`, `gh-api-write`, `package-publish`, `http-write` |
| `evaluateCommand` | `({ command, policyInfo, state, head, now? })` | `{ decision, reasons, actions, evidence, opaque, … }`; pure |
| `actionKey` | `(action, head)` | the digest that identifies "the same action at the same commit" |
| `beginActions` | `(repo, evaluation, { command, tree, policyDigest, host, toolUseId })` | action ids; appends `action.begun` |
| `endActions` | `(repo, ids, { exitCode, detail })` | `"success"` or `"unknown"`; appends `action.ended` |
| `recordEvidence` | `(repo, { kind, command, exitCode, excluded?, treeBefore, treeAfter, head, scope?, scopeBefore?, scopeAfter?, host, session })` | the ledger entry |
| `snapshot` | `(repo, policy, tree)` | `{ tree, digests }` for every declared evidence scope |
| `scopeFor`, `scopeDigests` | `(policy, kind)`, `(scope, digests)` | a kind's scope paths or `null`; the digests for those paths |
| `evidenceStatus`, `completionStatus` | `(state, kind, snap, scope?)`, `(state, policy, snap)` | one result / `{ ok, tree, results }` |
| `describeEvidence`, `sessionSummary`, `describeSession` | | text and counts for people and agents |
| `reconcileOpen` | `(repo, { exec? })` | `[{ id, kind, outcome, detail }]`; runs read-only probes |
| `reconcileManually` | `(repo, id, outcome, note)` | for a person only; an adapter must keep the agent from calling it |
| `PROBES`, `ghFailure` | | the probe per action kind; a readable reason when `gh` is missing or logged out |
| `appendEvent` | `(repo, type, data)` | appends one entry under the lock |
| `readLedger`, `verifyLedger`, `ledgerPath` | `(repo)` | entries (throws on a broken chain) / `{ ok, entries, head }` or `{ ok: false, error }` / the file path |
| `withLedgerLock` | `(repo, fn)` | runs `fn` as the only writer; appends inside reuse the lock |
| `loadState`, `reduceEntries` | `(repo)`, `(entries)` | `{ evidence, actions, sessions, hostSessions, consumedTools }` |
| `openActions`, `latestSession` | `(state)` | actions still `pending` or `unknown` / the last session |
| `canonicalJson`, `digest`, `sha256` | | stable JSON and hashes used across the ledger |

### 6.2 Ledger entries

Each line is `{ seq, at, type, data, prev, hash }`. `hash` covers the entry and `prev`, so editing or removing a line breaks the chain and `readLedger` throws.

| `type` | Written when | Key `data` fields |
|---|---|---|
| `session.started` | A host session starts | `session`, `tree`, `head`, `host` |
| `evidence.recorded` | A check finished | `kind`, `command`, `exitCode`, `treeBefore`, `treeAfter`, `scope*`, `attributed`, `excluded`, `host`, `session` |
| `action.begun` | Before a side effect runs | `id`, `kind`, `key`, `argv`, `target`, `head`, `branch`, `tree`, `expect`, `host`, `toolUseId` |
| `action.ended` | After it ran, or proven never run | `id`, `outcome`, `exitCode`, `detail` |
| `action.reconciled` | A probe or a person settled it | `id`, `outcome`, `method` (`probe` or `manual`), `detail` |
| `completion.blocked` | The agent was sent back at stop | `session`, `missing`, `tree` |
| `tool.consumed` | A host call is consumed before result accounting | `host`, `session`, `toolUseId`; not proof of success |
| `tool.gated` | A hook denied or asked about a call | `decision`, `reason`, `tool`, `command`, `target`, `host`, `session` |

Entries retain the existing unversioned schema. Claude Code and Codex use the same entry types; new host/session correlation fields are optional and old entries remain readable. The additive `tool.consumed` entry prevents completed-call replays; older Core versions do not enforce that guard. Versioning and migration are required before an incompatible schema change.

### 6.3 Stability

| Surface | State |
|---|---|
| Policy file (`version: 1`) | Alpha; frozen at beta |
| CLI commands, exit codes, `--json` output | Alpha; frozen at beta |
| JavaScript exports in 6.1 | Alpha; may change before beta |
| Ledger entries | Alpha; additive host metadata, versioning before incompatible changes |
| Host adapter contract (section 5) | Draft |

## 7. Rules that keep the guarantees

These are the rules every integration must follow. Breaking one quietly removes the protection the person is relying on.

1. **When unsure, say `null`.** An exit code you did not see is `null`. Core treats it as unknown and asks for a check. Guessing 0 turns a lost push into a "success" and allows a duplicate.
2. **Record before, not after.** `beginActions` runs before the side effect. Recording after it means a crash in between leaves no trace.
3. **Decide again under the lock.** The first decision can be out of date by the time you record.
4. **Fail closed on side effects.** If your integration errors before a command with a side effect, deny it. For anything else, step aside.
5. **The person owns the policy and settles by hand.** The agent may read `.better-workflows/` and the ledger, never change them, and never call `bw run`, `bw init` or `bw reconcile <id>`.
6. **Never edit the ledger.** Append through the API. A broken chain stops every integration in that repository until a person repairs it.
7. **Nothing leaves the machine.** Core sends nothing anywhere. Probes only read from the provider the action wrote to. Keep it that way in anything built on it.
