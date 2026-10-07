<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# 参与贡献

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · **简体中文** · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

感谢您帮助改进 Better Workflows。

[README](../../../README.md) · **参与贡献** · [行为准则](conduct.md) · [安全](security.md) · [项目治理](governance.md) · [使用支持](support.md)

[41 个本地化版本的概览与官网入口](../../../docs/LANGUAGES.md)。本贡献规范以英文原文为准。

## 开始之前

- 若涉及新的公共契约、Auto 公共行为变更、安全边界或大型架构调整，请先发起 issue 或 discussion。
- 每个 pull request 应专注于单一目标结果。
- 切勿提交凭据、私有 prompt、原始对话历史、主机签名私钥、提供商收据或已签名证明。
- 如发现安全漏洞，请按 [SECURITY\.md](security.md) 所述私下报告。

## 开发环境设置

要求：

- Node\.js 24 或更新版本；
- 不含第三方运行时依赖；
- 基于当前目标分支的干净分支。

运行完整的本地基线检查：

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## 变更规则

1. 保持 Root 拥有的变更权限以及 fail\-closed 副作用边界。
2. 当 Auto 的公共行为发生变更时，需同步更新其模板与 skill、入口目录、CLI、测试以及所有受影响的文档。
3. 拒绝未知的 CLI 选项与未知的 schema 字段。
4. 将私有运行时状态保存在代码仓之外。
5. 为每个新增安全 gate 添加反向测试。
6. 切勿变更既有的不可变 plugin\-cache 版本。修改后的 bundle 需要新的构建版本以及精确的源码\/缓存摘要验证。

如果仅调整 README 的组织方式，请保持根目录页面便于浏览，并将详细契约放入 [`docs/guide/`](../../../docs/guide/) 下的对应文件。

## 拉取请求检查清单

- [ ] 已明确说明范围与非目标。
- [ ] 已记录行为与安全边界。
- [ ] 针对性测试覆盖成功与失败路径。
- [ ] 完整测试套件与 `sbw eval` 均通过。
- [ ] `git diff --check` 通过。
- [ ] 适用时，版本／缓存变更遵循不可变发布规则。
- [ ] 未包含秘密信息、私密状态或外部回执。

建议采用小规模且便于审查的提交。请勿将无关的清理工作与行为变更合并。
