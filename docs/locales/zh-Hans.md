<div align="center">

# Better Workflows

Better Workflows V5.0 RC1 现已公开发布：免费、开源的 Auto 工作流，专为 AI 工程 QA 与交付打造，具备即时证据、审查 gate 以及提供商对账能力。

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · **简体中文** · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[查看官方文档](https://betterworkflows.dev/zh-Hans/docs/) · [打开 GitHub](https://github.com/stephen-taipei/better-workflows) · [通过 USDT（TRC20）单次赞助](https://betterworkflows.dev/#sponsor)

</div>

V5.0 RC1 覆盖 macOS × Node 22/24 上的 Codex、Gemini CLI 与 Qwen Code。Claude Code、Linux 与 Windows 资格认证推迟至 V5.1。GA 要求至少 30 个自然日金丝雀观察期、连续 20 次合格启动以及三个不同仓库。

## 让 agent 工作<br>完成，并留下可验证的结果。

V5.0 RC1 现已公开发布。Auto 会检查目标、范围、代码仓及风险，随后选择针对性检查或证据工作流。Git 修改使用任务专属 worktree；交付则需要授权以及经过验证的外部结果。

## 从意图到完成，明确划分四道边界。

先定义 contract，再验证 source 与 evidence、核对外部操作结果；只有 terminal state 已知时，才宣布完成。

- **01 · `TaskContract`** — V5.0 RC1 现已公开发布。Auto 会检查目标、范围、代码仓及风险，随后选择针对性检查或证据工作流。Git 修改使用任务专属 worktree；交付则需要授权以及经过验证的外部结果。
- **02 · `evidence`** — Better Workflows V5.0 RC1 现已公开发布：免费、开源的 Auto 工作流，专为 AI 工程 QA 与交付打造，具备即时证据、审查 gate 以及提供商对账能力。
- **03 · `reconciliation`** — 先定义 contract，再验证 source 与 evidence、核对外部操作结果；只有 terminal state 已知时，才宣布完成。
- **04 · `terminal state`** — 执行命令并不代表工作已经完成；可重新验证的结果才是证明。

## 快速开始

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## 从架构地图继续深入实际使用场景。

- [从意图到完成，明确划分四道边界。](https://betterworkflows.dev/zh-Hans/docs/)
- [快速开始](https://betterworkflows.dev/zh-Hans/docs/quick/)
- [从架构地图继续深入实际使用场景。](https://betterworkflows.dev/zh-Hans/docs/use-cases/)
- [快速开始 — 从架构地图继续深入实际使用场景。](https://betterworkflows.dev/zh-Hans/docs/use-cases/quick/)
- [证据剧场](https://betterworkflows.dev/zh-Hans/docs/evidence-cinema/)

### 查看官方文档 · `zh-Hans`

此参考页已提供本地化摘要；交互内容尚未完整翻译。

- **01 · 从意图到完成，明确划分四道边界。** — 先定义 contract，再验证 source 与 evidence、核对外部操作结果；只有 terminal state 已知时，才宣布完成。
- **02 · 从架构地图继续深入实际使用场景。** — V5.0 RC1 现已公开发布。Auto 会检查目标、范围、代码仓及风险，随后选择针对性检查或证据工作流。Git 修改使用任务专属 worktree；交付则需要授权以及经过验证的外部结果。
- **03 · 快速开始** — Better Workflows V5.0 RC1 现已公开发布：免费、开源的 Auto 工作流，专为 AI 工程 QA 与交付打造，具备即时证据、审查 gate 以及提供商对账能力。

- [`从意图到完成，明确划分四道边界。`](https://betterworkflows.dev/docs/reference/zh-Hans/index.html) · `zh-Hans`
- [`快速开始`](https://betterworkflows.dev/docs/reference/zh-Hans/preview.html) · `zh-Hans`
- [`从架构地图继续深入实际使用场景。`](https://betterworkflows.dev/docs/reference/zh-Hans/use-cases/index.html) · `zh-Hans`
- [`快速开始 — 从架构地图继续深入实际使用场景。`](https://betterworkflows.dev/docs/reference/zh-Hans/use-cases/preview.html) · `zh-Hans`
- [`证据剧场`](https://betterworkflows.dev/docs/reference/zh-Hans/evidence-cinema/index.html) · `zh-Hans`

- [查看官方文档 · `zh-Hans`](../details/zh-Hans.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### 查看官方文档 · `en`



### 查看官方文档 · `zh-Hans`

- [安全政策](zh-Hans/security.md) · `zh-Hans`
- [参与贡献](zh-Hans/contributing.md) · `zh-Hans`
- [治理](zh-Hans/governance.md) · `zh-Hans`
- [社区行为准则](zh-Hans/conduct.md) · `zh-Hans`
- [第三方声明](zh-Hans/notices.md) · `zh-Hans`
- [README 编写质量指南](zh-Hans/readme-quality.md) · `zh-Hans`
- [编辑用色系统](zh-Hans/color-system.md) · `zh-Hans`
- [架构](zh-Hans/architecture.md) · `zh-Hans`
- [安全](zh-Hans/security-guide.md) · `zh-Hans`
- [CLI 参考](zh-Hans/cli-reference.md) · `zh-Hans`
- [入门指南](zh-Hans/getting-started.md) · `zh-Hans`
- [工作流](zh-Hans/workflows.md) · `zh-Hans`
- [使用支持](zh-Hans/support.md) · `zh-Hans`

## 帮助 Better Workflows 持续维护。

单次赞助将用于开源维护、文档、41 个本地化版本与网站托管；不包含会员资格，也不提供产品路线图或技术支持优先权。

[通过 USDT（TRC20）单次赞助](https://betterworkflows.dev/#sponsor)

---

执行命令并不代表工作已经完成；可重新验证的结果才是证明。
