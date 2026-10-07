<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# README 编写质量指南

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · **简体中文** · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[41 个本地化版本的概览与官网入口](../../../docs/LANGUAGES.md)。本编写指南以英文版为准。

Better Workflows 的 README 是项目入口页，不是压缩版参考手册。它应帮助读者依次回答五个问题：

1. 这是什么？适合我吗？
2. 它能解决什么问题？
3. 我为什么能相信它的主张？
4. 最快完成第一次成功操作的路径是什么？
5. 接下来该看哪里？

本指南规定每份仓库 README 在叙事、视觉、本地化与验证方面必须满足的要求。机器可读的规范来源是 [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)。

## 从读者要做的决定出发

GitHub 通常会先展示 README，再展示仓库的其他内容。因此，首屏必须说明产品能带来什么、适合谁，以及范围明确的下一步。不要以内部架构、完整命令参考或版本恢复细节开场。

请围绕以下读者需求编写：

- **新访客：**快速判断 Better Workflows 是否能解决相关问题。
- **新用户：**安装插件并成功走通一条自动路由。
- **评估者：**理解权限边界与 fail\-closed 行为。
- **老操作员：**快速跳转到工作流、安全、架构或 CLI 相关解答。
- **贡献者或翻译者：**查找权威契约、开发命令、支持与治理规则。

## 用因果关系组织叙事

五份入口页 README 采用相同的八段语义顺序。各语言的标题可以符合当地表达习惯，但读者的阅读路径不变。

| 章节 | 读者问题与叙事作用 |
| --- | --- |
| 产品价值与适用对象 | Better Workflows 是什么、为何存在，又适合谁？ |
| 从问题到成果 | 把意图、授权、证据与服务提供方的实际结果混为一谈，会出什么问题？ |
| 佐证与边界 | 哪些保证让预期成果可信？ |
| 第一次成功操作 | 从安装到取得结果，最短的完整路径是什么？ |
| 选择下一步 | 哪个工作流或文档符合读者的目标？ |
| 生命周期 | 目标如何变成经核对的完成结果，或在必要时安全停止？ |
| 信任与限制 | 系统绝不能自行推断、授权或宣称什么？ |
| 学习、求助与贡献 | 深入文档、支持、治理、开发与许可证信息在哪里？ |

这个顺序形成实用的叙事脉络：

- **背景：**提示词驱动的工作可以表达意图，却不代表授权或状态已获证明。
- **问题：**会改变系统状态的操作，使这个缺口成为交付风险。
- **解法：**Better Workflows 将目标、范围、证据、评审、操作与服务提供方结果核对绑定。
- **佐证：**通过明确的保证与边界，说明解法如何运作。
- **行动：**先让读者完成第一次成功操作，再介绍深入的实现细节。
- **延伸：**根据角色与预期成果，引导读者前往合适的教程、操作指南、概念说明或参考资料。

## 区分入口页内容与深入文档

README 应提供有助于做决定的信息。按用途引导读者深入阅读：

- [入门指南](getting-started.md)是初次使用的教程。
- [工作流](workflows.md)是按预期成果选择操作方式的指南。
- [架构](architecture.md)说明控制平面与设计取舍。
- [安全](security-guide.md)说明授权、隐私、证明，以及条件不明或不符时停止执行的机制。
- [CLI 参考](cli-reference.md)是命令参考文档。
- 本地化的 `docs/details/*.md` 页面保留完整的翻译细节。

不要在入口页重复放入缓存恢复、锁所有权、服务提供方传输的完整语义、所有命令或实现变更历史。入口页只需保留简洁的安全主张；可供审计的深入说明应放在正式指南中。

这种区分遵循 Diátaxis 对教程、操作指南、概念说明与参考资料的分类。同一页面无法同时优化这四种阅读需求。

## 每张图都要有明确用途

只有在关系、层级或状态转换用图像呈现明显比文字更容易理解时，才使用图像。

入口页允许使用两种图：

1. **授权边界架构图：**说明哪些层级决定意图、当前事实、工具权限、次数受限的重试与只读状态。
2. **从目标到完成的生命周期图：**说明何时检查证据、何时授权会改变状态的操作，以及何时因状态不明而停止。

每张图都必须包含：

- 简洁且有意义的替代文本；
- 紧邻图像的等义文字，确保隐藏图像或 Mermaid 无法渲染时，仍能理解相同结论；
- 尽可能以真正的文本呈现重要标签；
- 一个明确且持续适用的读者问题，作为持续更新该图的理由。

不要添加装饰性截图、塞满文字的图片，或只是重复短列表的图表。选择表应保持两个简洁的列，让窄屏设备也能阅读。

## 各语言保持相同含义

英文是语义基准，不是行数目标。繁体中文、简体中文、日文与韩文应让母语读者读起来自然，同时保留相同的规范含义。

以下项目必须保持等义：

- 八个语义章节及其顺序；
- 第一次成功操作的命令与产品标识符；
- 授权、证据、未知状态、提示词与隐私等五项主张；
- 工作流、安全、架构、CLI、支持、治理、开发与许可证信息的链接目标；
- 图像用途、生命周期阶段与替代文字说明；
- 版本来源与徽章规范。

标题、分句、标点、示例与行动引导可以符合当地习惯。绝不可翻译命令、选择器或证据标识符，也不可改变安全规范的语义。

## 便于快速阅读与翻译

- 先说读者能得到什么结果，并把重要词语放在标题及段落开头。
- 使用主动语态，指明由谁负责操作。
- 编写操作流程时，直接对读者说明。
- 段落要短，每段只处理一件事。
- 有顺序的步骤使用编号列表，没有先后关系的选项使用项目列表。
- 使用具体的链接文字，不要只写“点击这里”。
- 标题层级要清晰、内容要具体，同一层级的表述应一致。
- 优先使用明确、没有歧义且容易保留原意的语句。
- 先写适用条件，再写操作指示；命令之后再写预期结果。

## 验证含义，不只检查外观

文档测试不能只比对标题，还必须检查：

- 单个 H1 以及层级合理的标题结构；
- 有序语义分块与关键主张标记；
- 精确的初次成功命令与稳定标识符；
- 相对链接与特定语言的目标详情页；
- 版本徽标与运行时元数据保持一致；
- 有意义的图片 alt 文本与相邻视觉回退文本；
- 单个包含完整等效文本的 Mermaid 生命周期图；
- 两列表格与段落长度控制预算；
- 着陆页不出现指定的底层实现细节；

## 研究依据

- [GitHub：仓库 README 文件说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)界定 README 在初次访问时的用途，并建议将长篇文档移至其他位置。
- [Diátaxis](https://diataxis.fr/start-here/)区分教程、操作指南、概念说明与参考资料的需求。
- [Microsoft：便于快速阅读的内容](https://learn.microsoft.com/en-us/style-guide/scannable-content/)强调重要信息优先、短段落与一致的视觉阅读起点。
- [Google 开发者文档风格指南](https://developers.google.com/style/highlights)建议使用主动语态、直接对读者说明、具体标题、无障碍设计及适合全球读者的写法。
- [GitHub：创建图表](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams)说明 Markdown 的 Mermaid 支持。
- [W3C WAI：图片教程](https://www.w3.org/WAI/tutorials/images/)要求信息性与复杂图像提供替代文本及完整的等义说明。
