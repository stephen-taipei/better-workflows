<!-- Generated from docs/guide/cli-reference.md; source-sha256: ec70ac76f8954078ccebb620d79dc0cacf952122f33062a66307d5003483e961; edit scripts/cli-reference-source.mjs. -->
# CLI 參考

[English](../en/cli-reference.md) · [繁體中文](../zh-Hant/cli-reference.md) · **繁體中文（台灣）** · [繁體中文（香港）](../zh-Hant-HK/cli-reference.md) · [简体中文](../zh-Hans/cli-reference.md) · [Tiếng Việt](../vi/cli-reference.md) · [Українська](../uk/cli-reference.md) · [Türkçe](../tr/cli-reference.md) · [ไทย](../th/cli-reference.md) · [Svenska](../sv/cli-reference.md) · [Slovenčina](../sk/cli-reference.md) · [Русский](../ru/cli-reference.md) · [Română](../ro/cli-reference.md) · [Português](../pt/cli-reference.md) · [Português \(Brasil\)](../pt-BR/cli-reference.md) · [Polski](../pl/cli-reference.md) · [Nederlands](../nl/cli-reference.md) · [Norsk bokmål](../nb/cli-reference.md) · [မြန်မာ](../my/cli-reference.md) · [Bahasa Melayu](../ms/cli-reference.md) · [ລາວ](../lo/cli-reference.md) · [한국어](../ko/cli-reference.md) · [ខ្មែរ](../km/cli-reference.md) · [日本語](../ja/cli-reference.md) · [Italiano](../it/cli-reference.md) · [Bahasa Indonesia](../id/cli-reference.md) · [Magyar](../hu/cli-reference.md) · [Hrvatski](../hr/cli-reference.md) · [हिन्दी](../hi/cli-reference.md) · [עברית](../he/cli-reference.md) · [Français](../fr/cli-reference.md) · [Filipino](../fil/cli-reference.md) · [Suomi](../fi/cli-reference.md) · [Español](../es/cli-reference.md) · [Español \(México\)](../es-MX/cli-reference.md) · [Ελληνικά](../el/cli-reference.md) · [Deutsch](../de/cli-reference.md) · [Dansk](../da/cli-reference.md) · [Čeština](../cs/cli-reference.md) · [Català](../ca/cli-reference.md) · [العربية](../ar/cli-reference.md)

[README](../../../README.md) · [參與貢獻](contributing.md) · [行為準則](conduct.md) · [資安政策](security.md) · [專案治理](governance.md) · [使用支援](support.md)

[41 個語系版本的在地化總覽與官網入口](../../../docs/LANGUAGES.md)\. Commands and identifiers remain canonical in English\.

Run from a checkout with\:

```bash
node plugins/better-workflows/scripts/sbw.mjs <command>
# V5 is under development; it is not a published release or install target.
sbw version --json
sbw update status --json
# Before the first check, status is unknown. off disables network access even
# for an explicit check; manual is the default and an explicit check may query
# in manual or automatic mode without the automatic 24-hour throttle.
sbw update configure --mode off
sbw update configure --mode manual
sbw update configure --mode automatic
sbw update check --json
# Choose one mode. automatic is opt-in, interactive-only, best effort, and
# checked at most once per 24 hours; both success and failure consume the slot.
# Automatic checks are skipped in CI, --json, and non-interactive paths.
# It never auto-installs.
# Checks use fixed public release metadata only and send no private payload.
```

A verified global `sbw` binary is optional\. `sbw help` is the canonical source for exact options in the installed build\.

## 診斷與路由

```bash
sbw doctor
sbw doctor --capabilities
sbw route preview --goal "<goal>" --scope <path>
sbw route preview --goal "<goal>" --scope <path> \
  --mutation modify --acceptance-defined \
  --risk 0 --uncertainty 0 --blast-radius 1 \
  --irreversibility 0 --evidence-gap 0 \
  --basic-check "<targeted check>" \
  --integration-target <local-branch>
sbw route profile validate --file <profile.json>
sbw route profile install --file <profile.json>
sbw route profile show
```

The recorded preview includes `AutoRiskAssessmentV1`\. Auto takes its fast path only when every low\-risk condition passes\. `--protected-target`\, any hard exclusion\, an unknown mutation intent\, missing acceptance\, an omitted risk score\, or a missing targeted\-check plan promotes the route to evidence\-required\. A Git mutation also requires an existing local integration target\; its current exact revision is bound into the assessment\, while a missing\, remote\, or protected target uses the governed route\. Omitted risk scores normalize to the conservative value `3`\, never to zero\.

## 主機與工作區

For V5\.0 RC\, release qualification covers only the Auto entrypoint on macOS with Codex\, Gemini CLI\, and Qwen Code\. Claude Code and Linux\/Windows qualification are deferred to V5\.1\. The Tier 1 labels in `host-support-v1` describe the v4 host bridge\; `--os` diagnostics do not expand this release scope\, and out\-of\-scope conformance returns `HOLD`\.

```bash
sbw host list
sbw host doctor [host-id] [--os macos|linux|windows]
sbw host conformance [host-id] [--os macos|linux|windows] [--write-receipt]

sbw workspace preflight [--intent read-only|modify] \
  [--task-id <id>] [--integration-target <local-branch>] \
  [--profile-target <local-branch>]
sbw workspace create --goal "<goal>" [--task-id <id>] \
  [--integration-target <local-branch>] [--profile-target <local-branch>]
sbw workspace register --task-id <id> --base-revision <sha> \
  --integration-target <local-branch> [--source-checkout <path>] \
  [--source-branch <local-branch>]
sbw workspace validate --repository-id <id> --task-id <id> \
  --check-file <checks.json>
sbw workspace rebind --repository-id <id> --task-id <id> \
  --integration-target <local-branch>
sbw workspace integrate --repository-id <id> --task-id <id>
sbw workspace reconcile --repository-id <id> --task-id <id> \
  --run-id <governed-run-id>
sbw workspace cleanup --repository-id <id> --task-id <id>
sbw workspace status --repository-id <id> --task-id <id>
sbw workspace completion-notice --repository-id <id> --task-id <id>
```

The workspace commands never infer cleanup ownership from a branch prefix or path\. `register` reuses a clean exact\-base host worktree without taking deletion authority over it\. `integrate` supports only a clean\, non\-protected local target\. Protected or remote delivery must continue through the governed PR and provider reconciliation commands\; `reconcile` accepts only the matching successful merge and remote\-sync actions from that governed run\. Until both terminal receipts exist\, the task lease and recovery resources remain in place\. `completion-notice` derives the message for Auto\'s fast path from the route\-bound lease\, successful actual checks\, current target reconciliation\, and exact cleanup receipt\; it rejects caller\-supplied completion claims\.

## 執行、證據與發現

```bash
sbw run --template auto --mode auto --goal "<goal>" --scope <path>
sbw run --route-receipt <route-receipt-id>

# Persist one immutable WorkflowPlanV1 from a native TaskContractV3 or V3 draft.
sbw workflow plan --contract <native-v3.json|v3-draft.json> \
  [--plan-id <id>] [--goal <exact>] [--scope <exact-path>] \
  [--template auto; required for draft]

# Re-observe the plan's source, policy, template, and route bindings. FRESH is
# planning-only: it executes no task and grants no action or effect authority.
# A binding mismatch or observation failure returns HOLD with blockers.
sbw verify plan <plan-id> [--goal <exact>] [--scope <exact-path>] \
  [--template auto]

# Evaluate one declared verification task against the clean, exact plan source.
# --repository must be an absolute normalized Git worktree path; a subdirectory
# is accepted and canonicalized to its worktree root. --epoch is non-negative,
# and --unrelated-head, when supplied, is a lowercase SHA-256 digest.
sbw verify run <plan-id> \
  --repository </absolute/path-or-subdirectory> \
  --task-id <id> --run-id <id> --epoch <n> \
  [--unrelated-head <sha256>] [--json]

# Inspect one task without evaluating it. --receipt is optional, state-root
# relative, and must name a regular, non-symlinked, single-link JSON file no
# larger than 512 KiB.
sbw verify explain <plan-id> \
  --repository </absolute/path-or-subdirectory> --task-id <id> \
  [--receipt <state-root-relative-json>] [--json]
# A run result is PASS, FAIL, HOLD, or UNKNOWN, but always has accepted=false
# and effectAuthorized=false. A persisted receipt may expose claimedStatus,
# but the current file-based explain path returns UNKNOWN with
# receiptTrusted=false because in-process provenance does not survive JSON
# persistence.

sbw run --plan <plan-id> --command-binding-file <private-json> \
  [--requested-model <model>] [--expires-at <ISO-8601>]
sbw status <run-id>
sbw campaign status <run-id>
sbw campaign renewal-request <run-id> --additional-repairs <1|2> --reason "<reason>"
sbw campaign renew <run-id> --file <host-signed-renewal-approval.json>
sbw resume <run-id>
sbw metrics list [--limit <1..500>]
sbw metrics summary [--limit <1..500>]
sbw metrics shadow --baseline-file <sanitized.json> \
  --candidate-file <sanitized.json> --binding-file <binding.json>
sbw source rebind <run-id> --reason <text>
sbw sentinel capture <run-id> --label <label>
sbw sentinel verify <run-id> --label <label>
sbw evidence add <run-id> --file <evidence.json>
sbw evidence replay
sbw evidence replay <run-id>
sbw evidence replay [<run-id>] --no-open
sbw evidence replay [<run-id>] --no-open --port <0..65535>
sbw finding add <run-id> --file <finding.json>
sbw finding update <run-id> --file <finding.json>
sbw ledger status <run-id>
sbw ledger transition <run-id> --file <event.json>
sbw review package <run-id> --base <sha> --head <sha> --scope <path> \
  --diff-manifest <json> --instruction-digest <sha256> --sentinel-digest <sha256>
sbw review diff <run-id> --package <package-id> [--native-evidence <evidence-id>]
sbw review status <run-id>
sbw review finding <run-id> --file <finding.json>
sbw review repair <run-id> --package <package-id> --file <result.json>
sbw review broad <run-id> --package <package-id> --head <sha> --sentinel-digest <sha256>
sbw review launch-native <run-id> --base <sha> --head <sha> \
  --package <package-id> --package-file <package.json> \
  --diff-manifest <manifest.json> --instruction <instruction.md> \
  --authorization <authorization.json> --model <model> \
  --reviewer-id <id> --execution-id <id> --result <new-absolute-result.json>
sbw complete <run-id>
```

`sbw run --plan` is the first native V3 CLI execution slice\. It reads the fresh persisted `WorkflowPlanV1` and a caller\-provided `NativeCommandBindingV1` from a private\, bounded\, symlink\-free JSON file\. The plan must contain exactly one dependency\-free task\; the command binding must match the plan\'s source\, policy\, scope\, task\, and unit bindings\. The CLI creates the canonical `sbw-YYYYMMDDTHHMMSSZ-12hex` run identity and state\-relative artifact paths\, collects approval from the real interactive TTY\, constructs one runner\, and calls `execute()` once\. SIGINT and SIGTERM request the runner\'s owned stop and wait for its receipt\; a signal during approval closes the CLI\-owned input and returns `HOLD`\. Noninteractive invocations cannot fabricate approval\. This slice does not execute a full workflow DAG\, and legacy `sbw run` options remain on their existing path\.

`evidence replay` starts a foreground\-only\, read\-only cinema at `http://localhost:9300` and opens a single\-use bootstrap URL in the default browser\. With a run ID it opens that recorded reel directly\; without one it shows the local run library\. Press `Ctrl+C` to stop it\. The ordinary launch path never invokes `sudo`\, the host signer\, providers\, action issuance\, or completion\. It reads bounded\, symlink\-free snapshots from `SBW_STATE_ROOT`\, serves only allowlisted sanitized metadata\, and marks active runs `UNSEALED`\. Recorded outcomes are presentation\-only and are not live re\-verification\. For a manual handoff\, `--no-open` does not launch a browser and prints a short\-lived\, single\-use `bootstrapUrl`\; open that URL rather than the clean URL\. The bootstrap transfers a per\-process bearer through the URL fragment\, stores it only in that `localhost:9300` tab\'s `sessionStorage`\, removes the fragment from browser history\, and sends it only in the replay API header\. Replay never sets a localhost cookie\, so the bearer is not forwarded to a different localhost port\. If the default browser opener fails or times out\, the URL given to that possibly late opener is revoked and a newly issued `bootstrapUrl` is printed with the warning for manual opening\. A spawned opener counts as successful only after its terminal exit is zero\. Opening a clean URL without its session\, or reusing an expired\/single\-use bootstrap URL in a browser\, shows one recovery state that hides the inactive player and tells the operator to stop the foreground server and launch a fresh replay command\.

`metrics list` and `metrics summary` are read\-only views over the same run records\. They expose sanitized mode\, outcome\, elapsed time\, resume\/scope\-drift\, replacement counts\, and friction flags\/counts\, plus provider token totals only when observed\. Missing values remain `null` and are accompanied by warnings\; the summary never treats unknown usage or terminal time as zero and cannot authorize an action\. Repository grouping uses a one\-way `repositoryDigest`\; local checkout paths are never included in exported metrics\. Prompt counts are also `null` when no interaction observation event was recorded\; an absent observation is never reported as zero\. The summary also includes an observe\-only `CostAnomalyReportV1` with bounded baseline\/recent windows\. Material wall\-time or provider\-token increases are reported as P1\/P2 investigation candidates\; insufficient or missing observations remain explicit unknowns\.

`metrics shadow` compares two operator\-selected\, sanitized metric batches only when their `ShadowReplayBindingV1` records match exactly\. It rejects filesystem paths\, prompts\, provider payloads\, duplicate runs\, missing fields\, and binding drift before producing a `ShadowReplayComparisonV1`\. The result remains `observe-only`\/`shadow-only` with `accepted: false`\.

`source rebind` is root\-only and pre\-review\/pre\-side\-effect\. It invalidates all prior complete evidence and resets the v2 execution ledger\, so the next sentinel\, evidence\, and review must be captured from the rebound source\. Successful governed `git.commit` actions already record their source transition and refresh the sentinel\; do not rebind them\. For an ordered manual commit plan\, use the versioned `staged-batches-v1` plan\, reconcile one exact batch at a time\, and refresh evidence before issuing the next batch\.

Ledger transition files may include `expectedLedgerDigest`\; when present it must match the current canonical `ledger.json` digest\. Transitions are root\-owned\, and stale expected digests or non\-root actors fail closed\.

`actions.dispatch` is currently deferred\. GitHub workflow dispatch resolves a mutable ref and cannot atomically bind execution to the preflight\-attested workflow bytes\, so the governed lifecycle rejects new dispatch tokens and executable provider paths\. Existing dispatch records can still be validated or reconciled read\-only\; do not treat a post\-dispatch head check as authorization\.

Governed GitHub actions record an absolute `gh` executable path and content digest at token issuance\. Provider probes and fixed\-argv wrappers use that recorded identity\; a PATH or executable drift fails closed\. A non\-zero PR creation wrapper exit after preflight remains sent\-or\-indeterminate\, so keep the `pull/new` reservation and reconcile with a pinned provider query rather than treating it as an immediate failure\. An explicitly recorded `not-sent` preflight failure can release the reservation directly\; a fresh provider proof of exact absence can reconcile the same unknown attempt as failure\, while a provider object or identity drift remains fail\-closed\.

Creation reservations are namespaced by provider repository\, action\, and resource\; an unknown PR in one repository cannot poison another repository\'s `pull/new` slot\.

Use `sbw action execute` for wrapper\-backed `git.push`\, `pr.create`\, and `pr.merge`\; `execute` consumes the token internally\. Direct `action consume` is reserved for non\-wrapper side effects that the root performs before a separate reconciliation\. The core lifecycle rejects contract `deferredActions` across issue\, consume\, execute\, reconcile\, completion\, and cleanup\.

For governed `git.push`\, `--remote-revision` remains the protected task\/base revision used by the contract and review gates\. The action binding separately captures the exact current source commit \(`expectedRevision`\) that the pinned credential dry\-run and fixed\-argv push will transfer\. Remote\-authorization evidence must bind its `payload.remoteRevision` to that source commit\; PR merge authorization continues to bind its payload to the protected base revision\.

## Graph View — 圖形檢視

```bash
sbw graph validate
sbw graph validate --template auto
sbw graph validate --run <run-id>
sbw graph inspect --template auto [--format json|mermaid]
sbw graph inspect --run <run-id> [--format json|mermaid]
```

`inspect` accepts exactly one target\. JSON is canonical\; Mermaid stays in the JSON envelope\'s `content`\. Success exits `0`\, structural diagnostics exit `2`\, and usage\/system errors exit `1`\.

## 模型研判

```bash
sbw deliberation roster \
  --allow-external-providers \
  --sanitized \
  --reasoning-effort auto \
  --refresh

sbw deliberation deliberate \
  --prompt-file <sanitized-case.md> \
  --reasoning-effort auto \
  --allow-external-providers \
  --sanitized
```

Gemini models are reached through Antigravity CLI \(`agy`\) in this runtime\. `agy` is transport metadata\, not a second model brand\.

## 儲存庫驗證

```bash
npm test --prefix plugins/better-workflows
```
