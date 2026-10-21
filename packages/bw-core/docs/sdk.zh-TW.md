# 在 Better Workflows Core 之上開發

[English](sdk.md)

這份指南寫給想讓自己的工具、script 或 AI agent host 使用和 Claude Code plugin 同一套檢查的開發者：證據要對得上目前的檔案才算完成、副作用要先經過 policy 判定、結果沒回來的動作要先對帳才能做下一件事。

狀態：alpha（`6.0.0-alpha.2`）。本文所有內容在 beta 前都可能改變。[host adapter 契約](#5-撰寫-host-adapter草案)是草案，文中會標明。

需要 Node.js 22.14 以上與 Git。Core 沒有其他依賴。

## 目錄

1. [三種介接方式](#1-三種介接方式)
2. [五個概念看懂整個模型](#2-五個概念看懂整個模型)
3. [透過 CLI 介接](#3-透過-cli-介接)
4. [透過 JavaScript API 介接](#4-透過-javascript-api-介接)
5. [撰寫 host adapter（草案）](#5-撰寫-host-adapter草案)
6. [參考](#6-參考)
7. [守住保證的規則](#7-守住保證的規則)

## 1. 三種介接方式

| 你要做的是 | 用什麼 | 工作量 |
|---|---|---|
| CI job、發佈 script、Git hook | `bw` CLI 與它的 exit code | 幾分鐘 |
| 用 Node.js 寫、替別人執行指令的工具 | JavaScript API（`import … from "@better-workflows/core"`） | 一小時左右 |
| 讓另一個 AI coding agent 支援 BW | 在 API 之上寫 host adapter | 幾天，另加在真實 agent 上測試 |

從能完成任務的最小方式開始。一般 script 需要的檢查，CLI 已經涵蓋大部分。

## 2. 五個概念看懂整個模型

Core 的行為都來自下面五個概念。理解之後，API 讀起來就很直覺。

**Repository。** Core 在單一 Git work tree 裡運作。`openRepo(cwd)` 會找到它並回傳 `{ root, gitDir, commonDir, stateDir }`。不在 Git work tree 裡時回傳 `null`，這時任何介接都應該什麼都不做。

**Policy。** `.better-workflows/policy.json`，由人撰寫並 commit。它規定完成需要哪些證據（`completion.require`）、哪些指令算哪一種證據（`evidence.kinds`），以及每一種副作用是 `allow`、`ask` 還是 `deny`（`actions`）。agent 可以讀，但不能改。檔案不存在就用預設值；檔案無效則所有副作用一律 deny。

**帳本（ledger）。** 位於 `.git/better-workflows/ledger.jsonl`，只能追加、以 hash 串接成鏈的紀錄。Core 知道的每一件事都是其中一筆。狀態從不另外存：`loadState(repo)` 每次都從帳本重新歸納出目前的證據與動作。因為放在 `.git/` 底下，帳本永遠不會被 commit。

**證據（evidence）。** 一筆「某個檢查跑過」的紀錄：種類（`test`、`lint` …）、exit code，以及執行前後工作檔案的 Git tree。只有通過、而且 tree 等於目前 tree 的證據才**有效**（`fresh`）。改了任何一個檔案，之前的通過結果就**過期**了（`stale`）。所有必要種類的證據都有效時，才允許完成。

```text
missing（沒有）──執行──▶ fresh（有效）──修改檔案──▶ stale（過期）──再執行──▶ fresh（有效）
                    └─ failed / unstable / unattributed（都不算數）
```

**動作（action）。** repository 外部看得到的副作用：`git push`、`gh pr merge`、`npm publish`、`curl -X POST`，或 policy 指名的指令。執行前 Core 寫入 `action.begun`，執行後寫入 `action.ended`。只有 exit code 0 算確定成功。其他情況（包括逾時或當機）都是 **unknown**，因為 push 可能在連線中斷前已經送到 remote。只要還有 pending 或 unknown 的動作，之後所有副作用都會被 deny，直到唯讀 probe 或人把它對帳清楚（`reconcile`）。同一個動作在同一個 commit 上絕不執行兩次。

```text
begun ──exit 0──▶ success
  └──── 其他／沒有結果 ──▶ unknown ──probe 或人──▶ success | failed
```

## 3. 透過 CLI 介接

安裝一次：`npm install -g @better-workflows/core@alpha`。在 repository 內任何位置都能執行。

| 指令 | Exit code | 常見用途 |
|---|---|---|
| `bw check-completion [--json]` | 0 必要證據都有效，2 還有缺或過期 | 讓會發佈未測檔案的 CI job 或發佈 script 失敗 |
| `bw check-command <指令列>` | 0 allow、2 deny、3 ask；輸出 JSON | 不執行，只問 Core 這個指令能不能跑 |
| `bw run --kind <種類> -- <指令…>` | 指令本身的 exit code | 執行檢查並記為證據。給人和 script 用，不給 agent 用 |
| `bw status [--json]` | 0 | 證據、未結動作、policy 與上一個 session |
| `bw reconcile` | 0 全部對帳完成，2 仍有 unknown | 讓唯讀 probe 對帳未結動作 |
| `bw verify` | 0 鏈完整，2 已損毀 | 檢查帳本沒被改過 |
| `bw log [--limit n]` | 0 | 印出最近的帳本紀錄 |

除了 `bw run` 會傳回指令本身的 exit code 之外，exit 1 代表用法錯誤（參數錯、不在 Git work tree 裡），內部錯誤則是 exit 2 並在 stderr 印出 `bw:` 開頭的訊息。2 可能有兩種意思時，請看 stderr。

拒絕發佈未測檔案的發佈 script：

```bash
set -e
bw run --kind test -- npm test
bw check-completion
npm publish
```

`bw check-command` 讓任何語言寫的工具不必 import 也能詢問 Core：

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

`check-command` 只做判斷，不寫任何紀錄，所以它本身擋不住重複執行。要記錄並執行，請用 API（下一節）。

## 4. 透過 JavaScript API 介接

```js
import { openRepo, headCommit, loadPolicy, loadState, evaluateCommand } from "@better-workflows/core";
```

套件只提供 ESM。

### 4.1 詢問指令能不能執行

```js
const repo = await openRepo(process.cwd());
if (!repo) process.exit(0); // 不是 Git work tree：不介入

const policyInfo = await loadPolicy(repo);
const evaluation = evaluateCommand({
  command: "git push origin main",
  policyInfo,
  state: await loadState(repo),
  head: await headCommit(repo),
});
// evaluation.decision  "allow" | "ask" | "deny"
// evaluation.reasons   人看得懂的理由
// evaluation.actions   [{ kind, argv, target }]   這行指令裡的副作用
// evaluation.evidence  [{ kind, argv, attributable, where }]   這行指令裡的檢查
// evaluation.opaque    使用 $(…)、eval 或巢狀 shell 時為 true
```

`evaluateCommand` 是純函式：只讀你傳入的 state，不寫任何東西，要呼叫幾次都可以。

`allow` 表示 Core 沒有意見，它從不授予任何權限，你的工具自己的權限規則照樣適用。`ask` 表示應該由人確認。`deny` 表示不要執行。

### 4.2 完整流程：判斷、記錄、執行、回報

自己執行指令的工具有四個步驟。範例 [`examples/sdk/guarded-run.mjs`](../examples/sdk/guarded-run.mjs) 用不到 100 行做完四步，測試套件會實際執行它，所以範例會一直保持正確。

```bash
node examples/sdk/guarded-run.mjs -- npm test
node examples/sdk/guarded-run.mjs -- git push origin main
node examples/sdk/guarded-run.mjs --yes -- npm publish
```

各步驟與範例中的程式碼：

**1. 先對帳未結動作，再判斷。**

```js
let evaluation = await decide();
if ((evaluation.actions.length || evaluation.opaque) && openActions(await loadState(repo)).length) {
  await reconcileOpen(repo);     // 唯讀 probe：git ls-remote、gh pr view、npm view …
  evaluation = await decide();
}
if (evaluation.decision === "deny") refuse(2, "denied");
```

**2. 每個副作用執行前，在帳本鎖內先記錄。** 兩個 process 可能同時做出判斷。在 `withLedgerLock` 裡重新判斷、並在同一步寫入紀錄，就能確保只有一個 process 會真的開始 push。

```js
evaluation = await withLedgerLock(repo, async () => {
  const latest = await decide();
  if (latest.decision !== "deny") ids = await beginActions(repo, latest, { command, tree: treeBefore, policyDigest: policyInfo.digest, host: HOST });
  return latest;
});
```

**3. 執行指令。** 執行前先取 tree（`worktreeTree`），證據才能證明它是在哪些檔案上跑的。

**4. 回報結果。** 傳入真正的 exit code；不知道時（被 signal 中止、process 消失）傳 `null`。Core 會把非 0 的結果都當成 `unknown`。

```js
if (ids.length) await endActions(repo, ids, { exitCode, detail });
await recordEvidence(repo, { kind, command, exitCode, excluded, treeBefore, treeAfter, head, host: HOST });
```

`excluded` 說明為什麼即使 exit 0 也不能算數：`"exit-code"` 表示這行的 exit code 屬於另一個指令（`npm test | tail`），`"directory"` 表示 exact 規則的指令沒有在 policy 指定的目錄執行。用 `evaluation.evidence[i].attributable` 和 `.where` 判斷，範例裡有寫法。

### 4.3 檢查能否完成

```js
const { policy } = await loadPolicy(repo);
const tree = await worktreeTree(repo, { ignore: policy.evidence.ignore });
const completion = completionStatus(await loadState(repo), policy, await snapshot(repo, policy, tree));
if (!completion.ok) {
  for (const result of completion.results) console.log(describeEvidence(result));
}
```

每個 result 的 `status` 是下列其中之一：`fresh`（有效）、`stale`（過期，檔案在那次執行後改過）、`failed`（失敗）、`unstable`（執行期間檔案有變）、`unattributed`（無法歸屬，見上面的 `excluded`）、`missing`（從沒跑過）。

## 5. 撰寫 host adapter（草案）

> **草案。** Claude Code 與實驗中的 [Codex adapter](codex.md) 共用 `src/adapters/shared.mjs` 的 host 中立生命週期邏輯。各 adapter 正規化事件並組裝 host 回應；原始 host payload 不會進入 shared。這個內部契約在 beta 前仍可能調整。

像 `guarded-run` 這種 wrapper 只保護經過它的指令，agent 仍然可以直接執行 `git push`。adapter 不一樣：是 agent host 本身在每次工具呼叫前問 Core 並遵守答案，所以沒有漏網的指令。

### 5.1 host 必須提供的能力

動手寫程式前，先對照 host 的文件，再到真實 host 上確認。前三項缺任何一項，這個 host 就只能做到建議性質的支援。

| 能力 | Core 為什麼需要 |
|---|---|
| 每個 shell 指令**執行前**的 hook，能拒絕，而且 host 真的會拒絕（fail closed） | 沒有它，就擋不住重複 push |
| 指令執行後的**最終 exit code**，或明確表示沒有跑完 | 證據與動作結果都靠它；猜一個 0 比給 `null` 更糟 |
| 呼叫前後都帶著穩定的 **session id** 與 **tool call id** | 用來把「執行後」事件對回「執行前」記錄的動作 |
| agent **停止**時的 hook，而且能把它送回去繼續 | 用來在證據過期時拒絕「完成了」 |
| **修改檔案**前的 hook，帶目標路徑 | 讓 agent 碰不到 policy 和帳本 |

有些 host 會把 `ask` 當成 `allow`。遇到這種 host，adapter 必須把 `ask` 改成 `deny`。

### 5.2 事件對應

| Host 事件 | Adapter 要做的事 | Claude Code 對應事件 |
|---|---|---|
| Session 開始 | `appendEvent("session.started", …)`；告訴 agent 需要哪些證據、有哪些未結動作 | `SessionStart` |
| 修改檔案前 | deny `.better-workflows/` 與 Git 目錄底下的修改 | `PreToolUse`（Edit、Write …） |
| shell 指令執行前 | deny 會改動受保護路徑、或執行 `bw init`、`bw run`、`bw reconcile <id>` 的指令；接著做 [4.2](#42-完整流程判斷記錄執行回報) 的第 1、2 步；保存執行前的 tree 供證據使用 | `PreToolUse`（Bash） |
| shell 指令執行後 | 做 4.2 的第 4 步，只有 host 明確給出 exit code 時才帶數字 | `PostToolUse`、`PostToolUseFailure` |
| 人在 host 的提示中拒絕了這次呼叫 | 若 host 能證明指令沒有執行，把動作結束為 `failed`（Claude Code adapter 從 transcript 讀出拒絕紀錄）；無法證明就維持 `unknown` | 下一個事件時從 transcript 讀取 |
| Agent 停止 | `completionStatus`；不通過就用 `describeEvidence` 的內容送回一次，並記錄 `completion.blocked` | `Stop` |

### 5.3 骨架

```js
// src/adapters/<host>.mjs — 示意，不是可用的 adapter
const HOST = "<host>";

export async function handleHook(input) {
  let repo;
  try {
    repo = await openRepo(input.cwd);
    if (!repo) return allow();
    switch (normalizeEventName(input)) {
      case "before-shell": return await beforeShell(repo, normalize(input));
      case "after-shell":  return await afterShell(repo, normalize(input));
      // session-start、before-edit、stop …
    }
    return allow();
  } catch (error) {
    // 絕不讓例外往外丟：adapter 當掉會讓 host 只能猜。有副作用的 shell 指令
    // 執行前若發生內部錯誤，一律轉成 deny。
    return isSideEffect(input) ? deny(`Better Workflows hook error: ${error.message}`) : allow();
  }
}

// 共用層收到的內容。host 無法確定的欄位一律是 null，不要猜。
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

### 5.4 測試 adapter

- 從 host 錄下真實事件 JSON 當 fixture（成功、非 0 exit、中斷、被人拒絕、長時間指令），測試以這些為準，不以文件的描述為準。
- 讓 [stale-green demo](../examples/stale-green/demo.mjs) 的步驟經過你的 adapter 重跑一次：過期的通過結果被擋、重複 push 被拒、結果不明的 deploy 擋住下一個副作用。
- 證明所有不明確的情況最後都是 `null` 與 `unknown`，絕不會變成通過或成功。

## 6. 參考

### 6.1 Exports

| Export | 簽章（節錄） | 回傳 |
|---|---|---|
| `openRepo` | `(cwd)` | `{ root, gitDir, commonDir, stateDir }` 或 `null` |
| `headCommit`、`currentBranch` | `(repo)` | commit id／branch 名稱，或 `null` |
| `worktreeTree` | `(repo, { ignore })` | 工作檔案（含 untracked）的 Git tree id；不會動到使用者的 index |
| `subtreeDigests` | `(repo, tree, paths)` | `{ 路徑: id 或 null }` |
| `treeState` | `(repo, { ignore })` | `{ head, tree }` |
| `loadPolicy` | `(repo)` | `{ policy, digest, source, error }`；`source` 是檔案路徑、`"default"` 或 `"invalid"` |
| `normalizePolicy`、`defaultPolicy` | `(raw)`、`()` | 正規化後的 policy；`normalizePolicy` 遇到無效輸入會 throw |
| `ruleFor` | `(policy, kind, now?)` | `{ decision, reason }`；過期的授權會變成 `ask` |
| `POLICY_PATH` | | `".better-workflows/policy.json"` |
| `splitCommand` | `(line)` | `{ commands, attributable, directories, opaque, changesDirectory }` |
| `classifyCommand` | `(line, policy)` | `{ commands, actions, evidence, opaque, changesDirectory }` |
| `BUILTIN_ACTION_KINDS` | | `git-push`、`gh-pr-merge`、`gh-pr-create`、`gh-release`、`gh-api-write`、`package-publish`、`http-write` |
| `evaluateCommand` | `({ command, policyInfo, state, head, now? })` | `{ decision, reasons, actions, evidence, opaque, … }`；純函式 |
| `actionKey` | `(action, head)` | 用來識別「同一個 commit 上的同一個動作」的 digest |
| `beginActions` | `(repo, evaluation, { command, tree, policyDigest, host, toolUseId })` | 動作 id；寫入 `action.begun` |
| `endActions` | `(repo, ids, { exitCode, detail })` | `"success"` 或 `"unknown"`；寫入 `action.ended` |
| `recordEvidence` | `(repo, { kind, command, exitCode, excluded?, treeBefore, treeAfter, head, scope?, scopeBefore?, scopeAfter?, host, session })` | 該筆帳本紀錄 |
| `snapshot` | `(repo, policy, tree)` | 每個宣告的證據 scope 的 `{ tree, digests }` |
| `scopeFor`、`scopeDigests` | `(policy, kind)`、`(scope, digests)` | 某種類的 scope 路徑或 `null`；這些路徑的 digest |
| `evidenceStatus`、`completionStatus` | `(state, kind, snap, scope?)`、`(state, policy, snap)` | 單一結果／`{ ok, tree, results }` |
| `describeEvidence`、`sessionSummary`、`describeSession` | | 給人與 agent 看的文字與統計 |
| `reconcileOpen` | `(repo, { exec? })` | `[{ id, kind, outcome, detail }]`；執行唯讀 probe |
| `reconcileManually` | `(repo, id, outcome, note)` | 只給人用；adapter 必須擋住 agent 呼叫它 |
| `PROBES`、`ghFailure` | | 每種動作的 probe；`gh` 沒裝或沒登入時的可讀理由 |
| `appendEvent` | `(repo, type, data)` | 在鎖內追加一筆 |
| `readLedger`、`verifyLedger`、`ledgerPath` | `(repo)` | 紀錄陣列（鏈損毀時 throw）／`{ ok, entries, head }` 或 `{ ok: false, error }`／檔案路徑 |
| `withLedgerLock` | `(repo, fn)` | 以唯一寫入者身分執行 `fn`；其中的追加會沿用同一把鎖 |
| `loadState`、`reduceEntries` | `(repo)`、`(entries)` | `{ evidence, actions, sessions, hostSessions, consumedTools }` |
| `openActions`、`latestSession` | `(state)` | 仍為 `pending` 或 `unknown` 的動作／最後一個 session |
| `canonicalJson`、`digest`、`sha256` | | 帳本共用的穩定 JSON 與 hash |

### 6.2 帳本紀錄

每一行是 `{ seq, at, type, data, prev, hash }`。`hash` 涵蓋該筆內容與 `prev`，所以改動或刪除任何一行都會讓鏈斷掉，`readLedger` 會 throw。

| `type` | 寫入時機 | 主要 `data` 欄位 |
|---|---|---|
| `session.started` | host session 開始 | `session`、`tree`、`head`、`host` |
| `evidence.recorded` | 檢查結束 | `kind`、`command`、`exitCode`、`treeBefore`、`treeAfter`、`scope*`、`attributed`、`excluded`、`host`、`session` |
| `action.begun` | 副作用執行前 | `id`、`kind`、`key`、`argv`、`target`、`head`、`branch`、`tree`、`expect`、`host`、`toolUseId` |
| `action.ended` | 執行後，或證明從未執行 | `id`、`outcome`、`exitCode`、`detail` |
| `action.reconciled` | probe 或人完成對帳 | `id`、`outcome`、`method`（`probe` 或 `manual`）、`detail` |
| `completion.blocked` | agent 停止時被送回 | `session`、`missing`、`tree` |
| `tool.consumed` | host 呼叫在結果入帳前標記為已消耗 | `host`、`session`、`toolUseId`；不代表成功 |
| `tool.gated` | hook deny 或 ask 某次呼叫 | `decision`、`reason`、`tool`、`command`、`target`、`host`、`session` |

紀錄沿用既有未編版號的 schema。Claude Code 與 Codex 使用相同紀錄類型；新增的 host/session 關聯欄位可省略，舊紀錄仍可讀取。新增的 `tool.consumed` 紀錄阻止已完成呼叫重播；舊版 Core 不會執行這項防護。不相容的 schema 變更必須先提供版本號與遷移方式。

### 6.3 穩定度

| 介面 | 狀態 |
|---|---|
| Policy 檔（`version: 1`） | Alpha；beta 時凍結 |
| CLI 指令、exit code、`--json` 輸出 | Alpha；beta 時凍結 |
| 6.1 的 JavaScript exports | Alpha；beta 前可能改變 |
| 帳本紀錄 | Alpha；新增 host 欄位維持相容，不相容變更前加版本號 |
| Host adapter 契約（第 5 節） | 草案 |

## 7. 守住保證的規則

每個介接都必須遵守這些規則。違反任何一條，使用者依賴的保護就會悄悄失效。

1. **不確定就給 `null`。** 沒看到的 exit code 就是 `null`，Core 會當成 unknown 並要求檢查。猜 0 會把遺失的 push 變成「成功」，然後允許重複執行。
2. **先記錄，再執行。** `beginActions` 要在副作用之前呼叫。事後才記錄，中間一當機就什麼都沒留下。
3. **在鎖內重新判斷。** 等到要記錄時，第一次的判斷可能已經過時。
4. **副作用一律 fail closed。** 介接在有副作用的指令前出錯，就 deny。其他情況則不介入。
5. **Policy 屬於人，手動對帳也由人做。** agent 可以讀 `.better-workflows/` 和帳本，但不能改，也不能呼叫 `bw run`、`bw init` 或 `bw reconcile <id>`。
6. **絕不直接編輯帳本。** 一律透過 API 追加。鏈一斷，該 repository 裡所有介接都會停擺，直到有人修復。
7. **資料不離開這台機器。** Core 不傳送任何東西到任何地方，probe 只從動作寫入的那個 provider 讀取。在它之上做的東西也要維持這一點。
