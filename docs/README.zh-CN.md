<div align="center">

# Better Workflows

### Goal-first · 证据驱动 · Fail-closed

Codex 的受治理工作流编排：小改动保持快速，重要 side effects 保持严谨。

| Primitive | 治理内容 | 证据边界 |
| --- | --- | --- |
| **Prompt** | 成果 | 文本不授予权限 |
| **Context** | 输入 | 必须有 fresh digests |
| **Harness** | 工具 | 只信任 allowlisted producers |
| **Loop** | 尝试 | 重试保持有界 |
| **Graph** | 状态 | 只读；不是 scheduler 或授权来源 |

绝不采集敏感或私人历史；只能用已遮蔽的 `REJECTED_WITH_EVIDENCE` disposition 拒绝。

**模型品牌名单：** Codex · Claude · Gemini（通过 Antigravity `agy`）·
GPT-OSS（通过 `agy`）· Grok · Cursor · Kimi · Qwen · Kiro。`agy` 是
transport metadata，不是另一个模型品牌；是否可用仍须通过最新 semantic roster probe。

[![Version](https://img.shields.io/badge/version-3.1.2-2563EB?style=flat-square)](../plugins/better-workflows/package.json)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A524-3C873A?style=flat-square)](../plugins/better-workflows/package.json)
[![Dependencies](https://img.shields.io/badge/runtime_dependencies-0-0F766E?style=flat-square)](../plugins/better-workflows/package.json)
[![License](https://img.shields.io/badge/license-MIT-64748B?style=flat-square)](../LICENSE)

[English](../README.md) · [繁體中文](README.zh-TW.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

| **概览** | [详细说明](details/zh-CN.md) | [快速开始](guide/getting-started.md) | [工作流](guide/workflows.md) | [架构](guide/architecture.md) | [安全](guide/security.md) | [CLI](guide/cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

## 先看最重要的部分

| **ROOT 掌握修改权** | **ACTION 前必须有证据** | **UNKNOWN = STOP** |
| --- | --- | --- |
| 只有 Root 能修改、集成、部署、接受风险与宣布完成。 | Side effect 前必须有新鲜检查、provenance 与明确 gate。 | Drift、过期证据或未知 provider 状态一律 fail closed。 |

| **13 个 TEMPLATES** | **WORKSPACE RECIPES** | **GRAPH VIEW** |
| --- | --- | --- |
| 按成果和风险选择路线，无需背诵 SOP。 | 重复执行可信 Node.js 机械步骤，节省 token。 | 检查 typed 结构，但永远不成为 authority source。 |

### Control-plane v2

新的非 direct template run 使用 typed evidence、append-only execution ledger
和声明的 review policy；completion 只接受已准入证据与 replay 状态，文字或
caller `acceptanceIds` 都不能直接完成 task。Legacy v1 run 仍由 v1 reader
读取，不会自动重新解释；Graph View 只呈现只读 task/dependency projection。

![Better Workflows 从 Prompt 到 Graph 的工程分层](assets/better-workflows-engineering-stack.svg)

| 项目 | **Prompt** | **Context** | **Harness** | **Loop** | **Graph** |
| --- | --- | --- | --- | --- | --- |
| 核心问题 | 要实现什么成果与限制？ | 当前有哪些可信事实？ | 谁能在哪里做什么？ | 应继续、重试还是停止？ | Records 与 gates 如何关联？ |
| Better Workflows | Goal + TaskContract | Profile + sentinel + evidence | Root + template + `sbw` + trusted recipe | Checkpoint + freshness + reconciliation | 衍生 typed Graph View |
| 可靠性 | 明确 acceptance 与 non-goals | 拒绝过期状态 | Root 掌握 mutation；side effect 需要 action token | 有界推进与明确停止条件 | 结构错误 fail closed |
| 刻意边界 | Prompt 不是 authority | 不暗中挖掘 raw history | 不生成无界动态 harness | 不允许没有 gate 的 loop-until-done | Graph 永远不是 policy input |

## 30 秒开始

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

打开新的 Codex task，从原生 picker 选择 Better Workflows：

```text
Codex CLI: @better
Codex App: /better
```

建议从这里开始：

```text
$better-workflows:auto <描述你需要的成果>
```

Automatic route 会选出一个具体 template 与最低验证 mode，但不能自行授权、安装工具或扩大 scope。

[安装、验证并运行第一个工作流 →](guide/getting-started.md)

## 按成果快速选择

| 你需要…… | 选择 |
| --- | --- |
| 让 Codex 选择安全且合适的路线 | `$better-workflows:auto` |
| Review repository 并创建去重 issues | `$better-workflows:review-issues` |
| 修复、创建 PR、merge 并清理 owned resources | `$better-workflows:fix-issues-pr` |
| Atomic commits 并交付 PR 到 `dev` | `$better-workflows:pr-to-dev` |
| 多模型比较架构并生成可执行方案 | `$better-workflows:research` |
| 管理 release 或不可逆操作 | `$better-workflows:critical` |
| 将重复 SOP 固化为可信 Node.js mechanics | `$better-workflows:workspace-recipe` |

[查看完整 entries、modes 与 templates →](details/zh-CN.md)

## Gemini 与 `agy`

Google 已将 consumer Gemini CLI 迁移到以 `agy` 执行的 Antigravity CLI。
Better Workflows 因此将 `agy` 记录为 **transport**；Gemini、Claude 与
GPT-OSS 才是它可以承载的 **model brands**。Agy 不再被重复计算为另一个模型品牌。

[查看架构、安全边界与完整规格 →](details/zh-CN.md)

## 开发与社区

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
```

[Contributing](../CONTRIBUTING.md) · [Code of conduct](../CODE_OF_CONDUCT.md) ·
[Security](../SECURITY.md) · [Support](../SUPPORT.md)

MIT。请参阅 [LICENSE](../LICENSE)。
