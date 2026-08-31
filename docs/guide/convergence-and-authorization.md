# Convergence and interaction authorization

| [Overview](../../README.md) | [Workflows](workflows.md) | [Security](security.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: |

Better Workflows must converge. Exact bindings, evidence, required checks, and
provider reconciliation remain mandatory, but changing a run ID, state root,
package ID, nonce, or execution ID must never reset a bounded repair loop.

## Default interaction mode

The default interaction mode is `auto-deduplicated`:

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
  genuinely missing authority; do not repeat the same question in later turns.
- Never ask for an administrator password in chat, copy it, pipe it, or retry a
  privileged prompt. Use a matching installed standing grant with `sudo -n`, or
  trigger one exact native macOS administrator interaction and then observe that
  session. If it is unavailable or fails, record HOLD once.

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
