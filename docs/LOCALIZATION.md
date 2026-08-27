# Better Workflows localization policy

[All 41 locales](LANGUAGES.md) | [Canonical English README](../README.md) | [Official website](https://betterworkflows.dev/)

Better Workflows publishes its official website entry routes and repository
overview in the same 41-locale BCP 47 inventory used by the Connectors iOS app:

`en`, `zh-Hant`, `zh-Hant-TW`, `zh-Hant-HK`, `zh-Hans`, `vi`, `uk`, `tr`,
`th`, `sv`, `sk`, `ru`, `ro`, `pt`, `pt-BR`, `pl`, `nl`, `nb`, `my`, `ms`,
`lo`, `ko`, `km`, `ja`, `it`, `id`, `hu`, `hr`, `hi`, `he`, `fr`, `fil`,
`fi`, `es`, `es-MX`, `el`, `de`, `da`, `cs`, `ca`, and `ar`.

## Meaning before literal translation

The word `fresh` is an English shorthand in the implementation. In localized
prose it means evidence that is still valid for the current source, revision,
screen, provider state, or other declared binding. It does not mean food-like
freshness, and it does not necessarily mean real-time data.

| Concept | `zh-Hant` | `zh-Hant-TW` | `zh-Hant-HK` | `zh-Hans` | `ja` | `ko` |
| --- | --- | --- | --- | --- | --- | --- |
| evidence freshness | 證據時效性 | 證據時效性 | 證據時效性 | 证据时效性 | 証拠の時点整合性／有効性 | 증거의 시점 유효성 |
| fresh evidence | 與目前來源一致且仍有效的證據 | 與目前來源一致且仍有效的證據 | 與目前來源一致且仍然有效的證據 | 与当前来源一致且仍有效的证据 | 現在のソースに紐付き、なお有効な証拠 | 현재 소스에 바인딩되어 여전히 유효한 증거 |
| stale evidence | 已過期或不再符合目前來源的證據 | 已過期或不再符合目前來源的證據 | 已過期或不再符合目前來源的證據 | 已过期或不再匹配当前来源的证据 | 期限切れ、または現在のソースと一致しない証拠 | 만료됐거나 현재 소스와 일치하지 않는 증거 |
| source binding | 來源綁定 | 來源綁定 | 來源綁定 | 来源绑定 | ソースへの結び付け | 소스 바인딩 |
| provider reconciliation | provider 狀態核對 | provider 狀態核對 | provider 狀態核對 | provider 状态核对 | provider 状態の照合 | provider 상태 대조 |
| rollback | 回復／回滾 | 復原／回滾 | 回復／回滾 | 回滚／恢复 | ロールバック | 롤백 |
| blast radius | 影響範圍 | 影響範圍 | 影響範圍 | 影响范围 | 影響範囲 | 영향 범위 |

Regional Chinese editions use formal written language appropriate to their
locale. The neutral `zh-Hant` edition avoids Taiwan-only wording when a common
Traditional Chinese term is available; `zh-Hant-TW` uses Taiwan terminology;
`zh-Hant-HK` uses formal Hong Kong written Chinese rather than conversational
Cantonese.

## Exact identifiers remain unchanged

CLI commands, template IDs, evidence kinds, JSON keys, filenames, code symbols,
Git references, and normative security conditions remain exact English runtime
identifiers. Surrounding explanatory prose is localized. English is the
canonical source for implementation and security contracts; localized editions
must not silently weaken authority, fail-closed, reconciliation, or completion
semantics.

## Translation coverage

Every locale has a translated repository overview, homepage, and five official
documentation entry routes. Each documentation route identifies and embeds the
corresponding interactive `docs/html` source instead of presenting the localized
navigation shell as a translated normative article. The interactive sources
retain their declared source-language controls, and the implementation,
operational, legal, community, and security documents remain canonical in
English unless a file explicitly declares another source language.

This distinction is intentional: locale availability must never be represented
as full-content translation when only the navigation and overview are localized.

## Quality gates

The repository runs the Markdown generator in exact `--check` mode and checks
locale membership and order, key parity, canonical and `hreflang` coverage,
reference bindings, unresolved template tokens, and known food-freshness calques
in every non-English locale. Automated checks cannot establish native-speaker
quality on their own, so future native review corrections should update the
central locale catalog and regenerate all public surfaces rather than patching
generated pages directly.
