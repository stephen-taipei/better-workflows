# Convergence and interaction authorization

| [Overview](../../README.md) | [Workflows](workflows.md) | [Security](security.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: |

Better Workflows must converge. Exact bindings, evidence, required checks, and
provider reconciliation remain mandatory, but changing a run ID, state root,
package ID, nonce, or execution ID must never reset a bounded repair loop.

## Default interaction mode

The default interaction mode is `auto-deduplicated`:

- An ordinary Better Workflows route is implicitly approved for its bounded
  in-process SOP interaction. This removes the repeated “please approve this
  same step” loop and does not wait for the user to copy a command or provide a
  password.
- This implicit decision is an interaction UX result only. It never issues an
  action token, authorizes a provider, discloses a new private package, or
  bypasses a required review, signer, check, merge, deploy, or cleanup gate.
- A new recipient/model/provider, private disclosure package, or other
  material boundary still requires its own explicit authorization. Native
  macOS administrator prompts remain owned by the installed signer; the agent
  must observe that session rather than collect credentials in chat.

- Reuse a current standing user directive without asking again when repository,
  goal, recipient/provider/model, disclosed data scope, side-effect kinds, and
  safety constraints are materially unchanged.
- A freshness-only refresh may create a new exact receipt while preserving its
  predecessor and scope digest. Prompt suppression is not an authority grant;
  every TaskContract, action token, evidence gate, and provider receipt still
  binds the current exact values.
- A consumed source finding, changed candidate bytes, new repository, new data
  recipient/model/provider, broader disclosure, or added side effect is a
  material scope change. It is HOLD unless an existing standing directive
  expressly covers that changed scope.
- Use strict per-request prompting only when the user explicitly asks for
  strict interaction mode. Otherwise produce at most one structured HOLD for a
  genuinely missing material authority; do not repeat the same question in
  later turns.
- Never ask for an administrator password in chat, copy it, pipe it, or retry a
  privileged prompt. Use a matching installed standing grant with `sudo -n`, or
  trigger one exact native macOS administrator interaction and then observe that
  session. If it is unavailable or fails, record HOLD once.

## Main-agent approval bridge

The root/main agent is the interaction coordinator. It may carry a user's
standing directive forward and suppress a duplicate question, but the bridge is
an interaction decision only; it is never an action token or provider
authority. A caller can inspect a stable, non-secret request fingerprint with:

```bash
sbw interaction preview --scope-file <material-scope.json>
```

The scope file must describe the repository, goal digest, recipient/provider/
model, disclosed data scope, target, side-effect kinds, and safety constraints.
For a review or delivery request it should also include the exact source,
base/head, contract, package, instruction, diff-manifest, reviewer, and
execution identities. An SOP route can return one bounded implicit
`auto-approved` decision for that fingerprint; a generic material-scope or
private-disclosure request emits at most one reusable HOLD. Supplying a
validated `--standing-file` can return `auto-approved` only when all material
fields match exactly; timestamps and receipt freshness may be renewed with a
predecessor link. `--strict` always requires a new user decision.

Any new package, instruction, reviewer/execution identity, recipient/provider/
model, repository, candidate bytes, or side-effect kind is material drift—even
when the goal text is unchanged. A consumed BLOCK is therefore a new
authorization boundary, not a stale renewal. In every outcome, the result
explicitly says that technical gates remain required and grants no action
authority. Do not put passwords, tokens, or other credentials in a scope or
standing file.

## Campaign-wide repair budget

Every review-enabled run carries a repository campaign identity. The first
blocked package establishes the baseline. At most five subsequent repair waves
are allowed across all successor runs, state roots, packages, nonces, and
execution identities for that same campaign. The ledger is stored under the
stable user host ledger root `~/.better-workflows/campaigns`, not inside a
disposable run state, clone, worktree, or `CODEX_HOME`.

When `campaign.exhausted=true`, do not create another run or review package for
the same goal. Terminalize as `campaign-repair-budget-exhausted`, preserve all
receipts, and either redesign the workflow as a materially different goal or
return the bounded BLOCK to the user. Renaming a goal, branch, run, state root,
or package to evade the budget is prohibited.

## Cost and convergence telemetry

Every governed run should retain a small, sanitized cost record alongside its
normal receipts: route mode, interaction decision, elapsed wall time, terminal
outcome (`success`, `partial`, `blocked`, or `inconclusive`), repair-wave count,
resume count, and (when a provider supplies it) input/output token totals. The
record is diagnostic metadata only; it never changes an action gate. Aggregate
these fields by repository and template to expose prompt loops, repeated
infrastructure replacements, scope drift, and resume MTTR. A missing metric is
`unknown`, never zero, and must not be used to claim an efficiency improvement.

## Shadow replay and pilot exit criteria

The v1/v2 transition is an observe-only comparison, not a second authority
path. When a representative task batch is available, replay the same sanitized
inputs against the immutable v1 and v2 contracts with the same source/base
bindings. Shadow runs must be read-only: they may write isolated receipts and
metrics, but cannot issue provider tokens, disclose private material, or mutate
Git, worktrees, or remote state. Compare terminal outcome, scope-drift count,
resume MTTR, repair waves, prompt count, and unknown/inconclusive rate from
`sbw metrics summary`; an absent metric stays unknown.

Do not claim that v2 is better from a single green run. A pilot may graduate
only after an operator-configured batch has complete pair coverage, no
unexplained v1/v2 binding differences, no new P0/P1 findings, and a documented
review of false blocks, false completions, and infrastructure interruptions.
Retire v1 for a template only when its v2 replacement has the same acceptance
surface, a tested migration reader, a published rollback path, and a bounded
deprecation date. Until those conditions are recorded, v1 remains a read-only
compatibility reader and v2 remains the sole candidate for new runs; neither
profile can bypass current freshness, review, action, or reconciliation gates.

## One launcher per governed operation

Formal evaluation must use:

```bash
sbw eval --formal --expected-head <sha> --expected-base <sha> \
  --launch-root </private/tmp/bw-*-formal-eval-*>
```

The Node launcher owns process inventory, fixed PATH discovery, physical 0700
state/cache/TMP creation, host boot and sleep/wake binding, caffeinate, exact
source pre/postflight, and the terminal receipt. Do not replace it with zsh,
sed, grep/rg pipelines, pgrep regexes, or hand-built environment wrappers.
An exact SHA receives one primary attempt and at most one separately classified
infrastructure replacement using `--replacement-reason`. A third attempt is
rejected; source or fixture failures require a repaired SHA.

Independent native review must use:

```bash
sbw review launch-native <run-id> \
  --base <sha> --head <sha> --package <package-id> \
  --package-file <package.json> --diff-manifest <manifest.json> \
  --instruction <instruction.md> --authorization <authorization.json> \
  --model <model> --reviewer-id <id> --execution-id <id> \
  --result <new-absolute-result.json>
```

The runner validates the frozen `BASE...HEAD` path set before launch, keeps the
review tool-capable by omitting model-time `--output-schema`, captures only the
final message, and independently validates complete scope coverage and the
final JSON. It records one consumed model attempt per immutable package; changing
an output path or execution ID cannot create a second attempt. Ad-hoc
`codex exec` review commands are not review evidence.

The sanitized incident corpus at
`plugins/better-workflows/fixtures/sop-incidents-v4.json` is required regression
input. A fix is incomplete if it reintroduces any listed convergence, launcher,
review-scope, or fixture-amplification failure.
