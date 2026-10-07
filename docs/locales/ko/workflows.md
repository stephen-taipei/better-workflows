<!-- Generated from docs/guide/workflows.md; source-sha256: 2acaf671415fc972265bcc5c4f20484c1a6cbea2dd1e6aa3fb22f54943786bb0; edit docs/rc1-catalogs/workflows/*.json. -->
# 워크플로

[English](../en/workflows.md) · [繁體中文](../zh-Hant/workflows.md) · [繁體中文（台灣）](../zh-Hant-TW/workflows.md) · [繁體中文（香港）](../zh-Hant-HK/workflows.md) · [简体中文](../zh-Hans/workflows.md) · [Tiếng Việt](../vi/workflows.md) · [Українська](../uk/workflows.md) · [Türkçe](../tr/workflows.md) · [ไทย](../th/workflows.md) · [Svenska](../sv/workflows.md) · [Slovenčina](../sk/workflows.md) · [Русский](../ru/workflows.md) · [Română](../ro/workflows.md) · [Português](../pt/workflows.md) · [Português \(Brasil\)](../pt-BR/workflows.md) · [Polski](../pl/workflows.md) · [Nederlands](../nl/workflows.md) · [Norsk bokmål](../nb/workflows.md) · [မြန်မာ](../my/workflows.md) · [Bahasa Melayu](../ms/workflows.md) · [ລາວ](../lo/workflows.md) · **한국어** · [ខ្មែរ](../km/workflows.md) · [日本語](../ja/workflows.md) · [Italiano](../it/workflows.md) · [Bahasa Indonesia](../id/workflows.md) · [Magyar](../hu/workflows.md) · [Hrvatski](../hr/workflows.md) · [हिन्दी](../hi/workflows.md) · [עברית](../he/workflows.md) · [Français](../fr/workflows.md) · [Filipino](../fil/workflows.md) · [Suomi](../fi/workflows.md) · [Español](../es/workflows.md) · [Español \(México\)](../es-MX/workflows.md) · [Ελληνικά](../el/workflows.md) · [Deutsch](../de/workflows.md) · [Dansk](../da/workflows.md) · [Čeština](../cs/workflows.md) · [Català](../ca/workflows.md) · [العربية](../ar/workflows.md)

| [개요](../../../README.md) | [세부 정보](../../../docs/details/en.md) | [빠른 시작](getting-started.md) | **워크플로** | [아키텍처](architecture.md) | [보안](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

## Auto 사용

```text
$better-workflows:auto <describe the outcome you need>
```

## 일반적인 경로

```mermaid
flowchart TD
  A{"결과물은 무엇인가요?"}
  A -->|"검토만 진행"| B["auto"]
  A -->|"수정 및 전달"| C["auto"]
  A -->|"옵션 비교"| D["auto"]
  A -->|"배포 또는 비가역적 작업"| E["HOLD"]
  A -->|"안정된 메커니즘 반복"| F["auto"]
  A -->|"확실하지 않음"| G["HOLD"]
```
