<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# 安全政策

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · **简体中文** · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [参与贡献](contributing.md) · [行为准则](conduct.md) · **安全** · [项目治理](governance.md) · [使用支持](support.md)

[41 个本地化版本的概览与官网入口](../../../docs/LANGUAGES.md)。本安全政策以英文原文为准。

如果唯一提议使用的证据来源包含无法去除敏感信息的非公开历史记录或敏感运营资料，请勿采集或传输该来源。仅记录经过敏感信息遮蔽处理的 `REJECTED_WITH_EVIDENCE` 理由。

## 支持的版本

| 版本 | 支持状态 |
| --- | --- |
| 最新发布版本与不可变的 Codex 构建版本 | 支持 |
| 较旧的不可变缓存版本 | 回滚目标版本；除非明确公告，否则不会向旧版本移植修复 |
| 未发布的派生项目或经过修改的缓存内容 | 不支持 |

## 报告漏洞

请使用[GitHub 私密漏洞报告](https://github.com/stephen-taipei/better-workflows/security/advisories/new)。请勿针对疑似漏洞创建公开议题。

请包含：

- 受影响的版本与插件构建版本；
- 环境与 Node\.js 版本；
- 最小复现步骤；
- 预期与实际观察到的安全边界；
- 影响与任何已知的临时解决方法；
- 报告是否包含机密资料。

请勿包含仍然有效的凭据、签名密钥、服务提供商令牌、未经处理的非公开提示词或第三方个人数据。

## 响应

维护者会确认收到可供处理的报告、验证其范围，并协调修复与披露事宜。不承诺固定响应时间的 SLA。结果未知或尚未完成核对时，继续采取未经验证即拒绝放行的原则。

## 安全边界

Better Workflows 假设本地仓库、主机与可执行工具链均可信任。Node 的权限模型属于纵深防御措施，并不是用于隔离恶意代码的操作系统沙箱。请参阅完整的[安全指南](security-guide.md)。
