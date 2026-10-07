<!-- Generated from docs/guide/security.md; source-sha256: 07f9bf8812f6c52c36d33db446c1f75e984154fef0da6a6baac0300d2a3480a8; edit scripts/security-source.mjs. -->
# Sicherheit

[English](../en/security-guide.md) · [繁體中文](../zh-Hant/security-guide.md) · [繁體中文（台灣）](../zh-Hant-TW/security-guide.md) · [繁體中文（香港）](../zh-Hant-HK/security-guide.md) · [简体中文](../zh-Hans/security-guide.md) · [Tiếng Việt](../vi/security-guide.md) · [Українська](../uk/security-guide.md) · [Türkçe](../tr/security-guide.md) · [ไทย](../th/security-guide.md) · [Svenska](../sv/security-guide.md) · [Slovenčina](../sk/security-guide.md) · [Русский](../ru/security-guide.md) · [Română](../ro/security-guide.md) · [Português](../pt/security-guide.md) · [Português \(Brasil\)](../pt-BR/security-guide.md) · [Polski](../pl/security-guide.md) · [Nederlands](../nl/security-guide.md) · [Norsk bokmål](../nb/security-guide.md) · [မြန်မာ](../my/security-guide.md) · [Bahasa Melayu](../ms/security-guide.md) · [ລາວ](../lo/security-guide.md) · [한국어](../ko/security-guide.md) · [ខ្មែរ](../km/security-guide.md) · [日本語](../ja/security-guide.md) · [Italiano](../it/security-guide.md) · [Bahasa Indonesia](../id/security-guide.md) · [Magyar](../hu/security-guide.md) · [Hrvatski](../hr/security-guide.md) · [हिन्दी](../hi/security-guide.md) · [עברית](../he/security-guide.md) · [Français](../fr/security-guide.md) · [Filipino](../fil/security-guide.md) · [Suomi](../fi/security-guide.md) · [Español](../es/security-guide.md) · [Español \(México\)](../es-MX/security-guide.md) · [Ελληνικά](../el/security-guide.md) · **Deutsch** · [Dansk](../da/security-guide.md) · [Čeština](../cs/security-guide.md) · [Català](../ca/security-guide.md) · [العربية](../ar/security-guide.md)

[README](../../../README.md) · [Mitwirken](contributing.md) · [Verhaltenskodex](conduct.md) · [Sicherheit](security.md) · [Projektführung](governance.md) · [Hilfe](support.md)

[Überblick in 41 Sprach\- und Regionalversionen und offizielle Web\-Einstiegspunkte](../../../docs/LANGUAGES.md)\. This normative security guide remains canonical in English\.

## Grenzen der Autorität

| Surface | May do | Must not do |
| --- | --- | --- |
| Root | Edit\, integrate\, accept risk\, invoke authorized side effects\, complete | Bypass freshness\, evidence\, or reconciliation gates |
| Native delegated role | Research\, review\, test analysis\, refutation | Edit\, deploy\, mutate Git\/provider state\, accept risk |
| External critic | Return advisory analysis of an authorized sanitized dossier | Receive secrets\/private source or perform side effects |
| `sbw` | Validate and record deterministic state | Execute generated shell commands or invent authority |
| Graph View | Add structural failure diagnostics | Authorize\, schedule\, or relax policy |

If private history or sensitive operational material is the only proposed evidence and cannot be sanitized\, reject the proposal without harvesting or transmitting that source\. Persist only a redacted `REJECTED_WITH_EVIDENCE` rationale\.

## Isolation des Aufgaben\-Arbeitsbaums

`task-worktree-v1` grants a deliberately narrow local capability\: discover a repository\, create a unique task branch and worktree from an exact base SHA\, make bounded commits there\, validate a candidate integration\, compare\-and\-swap a clean non\-protected local target\, and remove exact resources owned by the same `TaskWorkspaceLeaseV1`\.

It does not authorize push\, PR merge\, deploy\, release\, protected\-branch bypass\, force removal\, `git worktree prune`\, stash\, patch copying\, or temporary commits in a dirty source checkout\. Read\-only and non\-Git work do not create worktrees\. Detached HEAD\, a missing or renamed target\, dirty source or target\, ownership conflict\, repeated target drift\, merge conflict\, failed validation\, and unknown provider state all stop before integration or cleanup\.

Repository locks bind the owning host\, PID\, and OS\-observed process incarnation\. Crash recovery quarantines and removes only an exact lock whose owner is proven absent or replaced\; a live\, cross\-host\, malformed\, or unobservable lock is preserved\. Lease lookup never truncates a large registry\: it scans every record within the bounded limit and otherwise stops\.

Cleanup requires terminal integration proof\, a clean task worktree\, exact lease ownership\, and target reconciliation\. Failure preserves the task branch and worktree as recovery state\. Names\, path prefixes\, or globs are never used as cleanup authority\. Integration and cleanup are restart\-safe at their mutation boundaries\: the lease records a candidate before creation and records each resource removal before proceeding\. A repeated cleanup call must reconcile and return the same digested receipt\. Nested repositories and submodules require independent leases\; multiple\-repository integration is serialized and is not atomic\.

Host\-provided worktrees are accepted only through explicit registration while the worktree and separate source checkout are clean\, the task branch is a distinct `codex/*` ref\, and both share the same Git common directory and exact base commit\. Their lease records `resourceOrigin: host-provided`\; cleanup removes Better Workflows integration candidates but preserves the host branch and worktree\.

## Auto\-Fast\-Path\-Prüfungsisolation

The Auto fast path does not run arbitrary package\-manager scripts\. Its bounded check runner accepts only the current Node\.js executable\, rejects flags that can weaken the runner\, enables the Node 22\.14\+ Permission Model\, denies child processes\, workers\, native addons\, WASI\, inspector access\, and filesystem reads outside the task worktree and task scratch\. Filesystem writes are limited to that scratch\, and a source\-digested guard denies standard Node network surfaces\. The scratch directory is removed before the check can pass\. The same guarded check is repeated on the complete local integration candidate\.

This is a seat belt for trusted repository checks\, not a sandbox for malicious code\. Node\'s own [Permission Model documentation](https://nodejs.org/download/release/v22.23.1/docs/api/permissions.html) states that it does not provide a malicious\-code security boundary\, and Node 24 does not expose the later `--allow-net` permission\. If a check needs npm\/pnpm\, child processes\, native code\, workers\, network access\, checkout\-external files or symlinked dependency stores\, or an OS\-enforced hostile\-code sandbox\, stop using the Auto fast path and continue through the governed evidence route\.

Protected integration is not accepted from prose or a standalone JSON file\. `workspace reconcile` reads the private governed run and requires exactly one successful `pr.merge` action plus its matching successful `remote.sync` action\, both bound to the validated task head and target\. Merge commits must contain the task head\. Squash cleanup is allowed only when the provider receipt binds that exact reviewed head and its merge commit\, and the synchronized local target contains that commit\.

## Lokaler Zustand

- Private state directories use mode `0700`\.
- Private state files use mode `0600`\.
- General receipts store digests and bounded metadata\, not raw prompts\, credentials\, or conversation history\. Reconciled side\-effect action records retain structured provider receipts privately so their terminal state can be independently verified\; those receipts are never included in external handoffs\.
- Unknown remote outcomes require a read\-only provider query and reconciliation\; they are never blindly retried\.
- Failed governed `pr.create` attempts keep their reservation until a paginated GitHub API query over all PR pages proves that no matching head\/base PR exists\; malformed or non\-empty provider results remain fail\-closed\.
- A consumed owned\-resource creation with outcome `unknown` keeps its reservation and cannot be retried blindly\. An operator may reconcile that same attempt as `success` only after a fresh provider\-side proof is bound to the consumed action\'s native marker\, actor\, source\, and provider object\; it may reconcile as `failure` only after a fresh pinned\-provider absence proof for the exact resource\. An unpinned or local absence snapshot cannot release the reservation\. Provider presence\, malformed results\, or identity drift remain fail\-closed\, and expiry reaping never releases an unknown reservation automatically\.
- Provider\-execution reservations are idempotent only for the same run\, action attempt\, token\, execution identity\, and recorded outcome\. A consumed owned\-resource attempt may make one controlled transition from an `unknown` provider reservation to its verified terminal provider receipt\; a superseded identity\, second execution identity\, outcome mismatch\, legacy\-format record\, or another action attempt remains rejected\. This lets a verified receipt resume after a crash between reservation and action\-record persistence without permitting replay\.
- `actions.dispatch` remains deferred\. GitHub Actions workflow dispatch accepts a mutable ref and cannot atomically bind provider execution to the preflight\-attested workflow bytes\; a post\-dispatch head check cannot undo side effects from an unauthorized revision\. Historical dispatch receipts may still be reconciled read\-only\, but new tokens and executable provider paths fail closed until an immutable provider binding exists\.
- GitHub provider probes are bound to the absolute executable path and content digest recorded when the action token is issued\. A PATH\, executable\, or provider\-authorization drift fails closed before the provider call\; governed GitHub invocations never fall back to an ambient bare `gh` command\.
- A non\-zero `pr.create` wrapper exit after preflight is `sent-or-indeterminate`\, not authoritative failure\. A recorded preflight failure marked `not-sent` may release the `pull/new` reservation directly\; a sent\-or\-indeterminate outcome remains unknown until a pinned provider query proves exact absence or canonical ownership\. Verified absence may then reconcile the same attempt as failure and release the reservation\.
- Creation reservation\, consumption\, release\, and expiry reaping are serialized by a per\-resource lease and namespaced by provider repository\, action\, and resource\. An expired lease cannot be reclaimed while another consumer is finalizing the same creation attempt\; legacy unscoped reservations remain fail\-closed\.
- Contract `deferredActions` are rejected across issue\, consume\, execute\, reconcile\, completion\, and cleanup paths\.
- Plugin\-cache ready finalization and failure cleanup share the same versioned publication lock\, so marker transitions cannot race target removal\. Cleanup requires the exact pending marker `runId` and action `attemptId`\; a foreign replacement marker and its target are never removed by the failed attempt\.
- Reclaiming a stale publication lock does not transfer pending\-marker ownership\. Before staging a missing target\, the publisher requires any existing pending marker to match the complete source binding\, `runId`\, and `attemptId`\; a foreign marker remains untouched and publication fails closed\. Lock owners bind an OS\-observable process\-start digest\. A proven stale path is atomically renamed to a same\-version quarantine and its inode\/content identity is rechecked before deletion\; a pathname replacement stays quarantined and blocks later publishers\.
- Governed `pr.create` actions bind the provider receipt to the exact candidate source commit observed when the action token is issued\; a PR from another source head cannot be reconciled or registered as run\-owned\.
- Successful governed pull\-request creation is canonicalized from `pull/new` to the verified `pull/<number>` resource before its creation reservation is released\. The registered PR remains run\-owned\, and a verified merged PR is a terminal cleanup receipt for that owned resource\.

## Transport externer Modelle

Antigravity CLI \(`agy`\) is permitted only after explicit external\-egress authorization and only for sanitized\, non\-confidential material within the configured byte limit\. Command\-line argument transport is treated as exposed metadata\.

The roster cache proves only a specific CLI\/model pair and reasoning\-effort profile for at most 24 hours\. Expiry\, refresh\, roster changes\, executable path changes\, or binary digest changes invalidate it\.

## Grenze des Bedrohungsmodells

Better Workflows assumes trusted local repositories and local tools\. It does not claim to isolate hostile repository code\, compromised executables\, privileged malware\, or an untrusted host administrator\.
