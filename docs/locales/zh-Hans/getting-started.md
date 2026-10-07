<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# 入门指南

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · **简体中文** · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 覆盖 macOS × Node 22\/24 上的 Codex、Gemini CLI 与 Qwen Code。Claude Code、Linux 与 Windows 资格认证推迟至 V5\.1。GA 要求至少 30 个自然日金丝雀观察期、连续 20 次合格启动以及三个不同仓库。

| [概览](../../../README.md) | [详细说明](../../../docs/details/en.md) | **快速入门** | [工作流](workflows.md) | [架构](architecture.md) | [安全](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[41 个本地化版本的概览与官网入口](../../../docs/LANGUAGES.md)。命令和标识符保持规范的英文形式。

V5\.0 RC1（`5.0.0-rc.1`，标签 `V5.0.rc1`）现已公开发布。其发布范围仅涵盖 Auto，支持 macOS Node 22\/24 上的 Codex、Gemini CLI 与 Qwen Code。Linux 与 Windows 认证以及 Claude Code 认证均推迟至 V5\.1。GA `5.0.0` 仍处于待定状态，直至记录满至少 30 个自然日金丝雀周期、连续 20 次合格启动以及三个不同代码仓。

## 使用要求

- Node\.js 22\.14 或更高版本，供内置的 `sbw` 辅助工具使用。
- 受信任的本地代码仓。Better Workflows 并未声明对恶意代码仓代码进行沙箱隔离。

v4 的状态根目录不依赖特定 AI 智能体平台：如果已设置 `SBW_STATE_ROOT`，则优先使用；其次使用 `XDG_STATE_HOME/better-workflows`，否则使用 `~/.better-workflows`。默认位置不再位于 `CODEX_HOME` 之下。如果要继续使用现有的 v3 Codex 状态而不移动数据，请明确将 `SBW_STATE_ROOT` 设置为该状态所在的确切 `<CODEX_HOME>/sbw` 目录，再调用 `sbw`。

V5\.0 GA（`5.0.0`）仍处于待定状态。下方的安装命令针对公开发布的 V5\.0 RC1（`5.0.0-rc.1`，标签 `V5.0.rc1`）。

## 安装

### Codex — 推荐采用的参考环境

```bash
# Install the publicly available V5.0.rc1 release candidate.
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
node plugins/better-workflows/scripts/sbw.mjs version --json
node plugins/better-workflows/scripts/sbw.mjs update status --json
# Before the first check, status is unknown. Choose one update mode; manual is
# the default. off disables network access even for an explicit check, while an
# explicit check can query manual or automatic mode without the 24-hour throttle.
node plugins/better-workflows/scripts/sbw.mjs update configure --mode off
node plugins/better-workflows/scripts/sbw.mjs update configure --mode manual
node plugins/better-workflows/scripts/sbw.mjs update configure --mode automatic
node plugins/better-workflows/scripts/sbw.mjs update check --json
# automatic is opt-in, interactive-only, best effort, and at most once/24h;
# success and failure both consume the slot. Automatic checks are skipped in CI,
# --json, and non-interactive paths. It never auto-installs; only fixed public
# metadata is used.
```

安装后请打开新的 Codex 任务，以刷新其技能目录。

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI 会复制扩展。安装后请重启会话；之后可使用 `gemini extensions update better-workflows` 更新。

扩展的上下文会依据自身已加载的源路径定位桥接层，而非依据你的项目工作目录。如果采用标准的用户范围安装，等效的手动检查如下：

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

对于通过链接方式加载或工作区范围的扩展，请使用 AI 智能体平台显示的确切扩展根目录。不得用名称相近的检出目录替代。

### Qwen Code

安装扩展的本地副本前，请先锁定发布版本：

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code 也会复制扩展，因此安装后请重启会话，并使用 `qwen extensions update better-workflows` 进行后续更新。

如果采用标准的用户范围安装，等效的手动桥接层检查如下：

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

通过链接方式或工作区范围安装时，同样必须遵守使用确切根目录的规则。

## 使用 Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

每个入口都会保留所要求的 Goal。如果已有不相关且仍处于活动状态的 Goal，必须明确编辑或清除；系统绝不会在未明确说明的情况下将其替换。

## 预览流程路径

能力快照为只读操作，不会触发提供商登录或模型语义探测：

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

如果要进行可供审阅的交接，请创建并使用一份私密、仅限单次使用的可验证记录：

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

可验证记录会在 24 小时后过期；如果重复使用，或工作区、范围、Profiles、目录、能力或插件包发生偏移，系统会拒绝操作，不会在不确定的情况下放行。

## 验证安装

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## 修改仓库之前

Auto 会先对工作区进行只读预检：

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

非 Git 任务和只读任务不会创建工作树。会进行更改的 Git 任务必须创建或复用归该任务所有的 `TaskWorkspaceLeaseV1`。如果源工作目录包含未提交的更改，流程会在进行任何 stash、复制、提交或创建工作树之前停止。如果 HEAD 处于分离状态，或缺少目标，则必须明确指定集成目标。受保护的目标或远程目标，会转入受治理规则管控的 PR 交付流程。

如果 Codex 或其他 AI 智能体平台已为当前任务创建干净的工作树，请在编辑前先登记该工作树，不要创建嵌套工作树：

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

登记时必须具备独立的 `codex/*` 任务分支，且该分支位于未变动的基点；同时必须使用相同的 Git 公共目录，并保有干净的源检出目录。Better Workflows 会使用该工作树，但在清理时保留归 AI 智能体平台所有的分支和路径。如果目标受到保护，请先运行证据工作流，再通过 `workspace reconcile --run-id <run-id>` 绑定该工作流的确切 PR 合并和远程同步可验证记录。

下一步：[选择合适的工作流](workflows.md)或浏览 [CLI 参考](cli-reference.md)。
