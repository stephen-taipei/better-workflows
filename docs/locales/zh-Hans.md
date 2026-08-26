<div align="center">

# Better Workflows

开源、goal-first 的 agent 工作流控制面，以当前仍有效的证据、审查关卡、来源绑定与 provider 状态核对，确保结果可重新验证。

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · **简体中文** · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[查看官方文档](https://betterworkflows.dev/zh-Hans/docs/) · [打开 GitHub](https://github.com/stephen-taipei/better-workflows) · [通过 Ko-fi 单次赞助](https://ko-fi.com/betterworkflows)

</div>

## 让 agent 工作<br>完成，并留下可验证的结果。

Better Workflows 固定 goal、scope 与 authority，把每个判断绑定到当前仍有效且可重新验证的证据，以及已核对的外部结果。

## 从意图到完成，明确划分四道边界。

先定义 contract，再验证 source 与 evidence、核对外部操作结果；只有 terminal state 已知时，才宣布完成。

- **01 · `TaskContract`** — Better Workflows 固定 goal、scope 与 authority，把每个判断绑定到当前仍有效且可重新验证的证据，以及已核对的外部结果。
- **02 · `evidence`** — 开源、goal-first 的 agent 工作流控制面，以当前仍有效的证据、审查关卡、来源绑定与 provider 状态核对，确保结果可重新验证。
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
- [Evidence Cinema](https://betterworkflows.dev/zh-Hans/docs/evidence-cinema/)

- [`DETAILS · zh-Hans`](../details/zh-CN.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### `GUIDES · en`

- [`getting-started`](../guide/getting-started.md) · `en`
- [`workflows`](../guide/workflows.md) · `en`
- [`architecture`](../guide/architecture.md) · `en`
- [`security`](../guide/security.md) · `en`
- [`cli-reference`](../guide/cli-reference.md) · `en`
- [`readme-quality`](../guide/readme-quality.md) · `en`

### `POLICIES · en`

- [`CODE_OF_CONDUCT`](../../CODE_OF_CONDUCT.md) · `en`
- [`CONTRIBUTING`](../../CONTRIBUTING.md) · `en`
- [`GOVERNANCE`](../../GOVERNANCE.md) · `en`
- [`SECURITY`](../../SECURITY.md) · `en`
- [`SUPPORT`](../../SUPPORT.md) · `en`
- [`THIRD_PARTY_NOTICES`](../../THIRD_PARTY_NOTICES.md) · `en`
- [`ANSIBLE`](../../deploy/ansible/README.md) · `en`

### `RUNTIME SOURCE · en`

- [`plugins/better-workflows/skills/`](../../plugins/better-workflows/skills/)
- [`evidence-cinema/imagegen-manifest`](../html/evidence-cinema/assets/imagegen-manifest.md)
- [`use-cases/color-system`](../html/use-cases/assets/color-system.md)
- [`use-cases/imagegen-manifest`](../html/use-cases/assets/imagegen-manifest.md)
- [打开 GitHub](https://github.com/stephen-taipei/better-workflows)

## 帮助我们持续维护 Better Workflows。

单次赞助将用于开源维护、文档、41 个本地化版本与网站托管；不包含会员资格，也不提供开发规划或技术支持优先权。

[通过 Ko-fi 单次赞助](https://ko-fi.com/betterworkflows)

---

执行命令并不代表工作已经完成；可重新验证的结果才是证明。
