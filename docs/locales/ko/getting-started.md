<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# 시작하기

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · **한국어** · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1은 macOS × Node 22\/24 환경의 Codex\, Gemini CLI\, Qwen Code를 지원합니다\. Claude Code\, Linux\, Windows 적격성 평가는 V5\.1로 연기되었습니다\. GA에는 최소 30일의 자연일 카나리 기간\, 20회 연속 적격 시작\, 3개의 서로 다른 저장소가 필요합니다\.

| [개요](../../../README.md) | [자세히](../../../docs/details/en.md) | **빠른 시작** | [워크플로](workflows.md) | [아키텍처](architecture.md) | [보안](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[41개 로캘 버전의 현지화 개요와 공식 웹 진입점](../../../docs/LANGUAGES.md)\. 명령과 식별자는 표준 영어 표기를 유지합니다\.

V5\.0 RC1\(`5.0.0-rc.1`\, tag `V5.0.rc1`\)이 공개되었습니다\. 출시 범위는 macOS Node 22\/24 환경의 Codex\, Gemini CLI\, Qwen Code를 사용하는 Auto에만 한정됩니다\. Linux 및 Windows 적격성 평가는 Claude Code 적격성 평가와 마찬가지로 V5\.1로 연기되었습니다\. GA `5.0.0`은 최소 30일간의 자연 카나리 기간\, 20회의 연속 유효 실행\, 세 개의 개별 리포지토리가 기록될 때까지 보류 상태로 유지됩니다\.

## 요구 사항

- 번들된 `sbw` 헬퍼를 위한 Node\.js 22\.14 이상 버전\.
- 신뢰할 수 있는 로컬 리포지토리\. Better Workflows는 악성 리포지토리 코드를 샌드박스 처리한다고 보장하지 않습니다\.

v4 상태 루트는 특정 AI 에이전트 플랫폼에 종속되지 않습니다\. `SBW_STATE_ROOT`가 설정되어 있으면 최우선으로 사용하고\, 다음으로 `XDG_STATE_HOME/better-workflows`를 사용하며\, 그렇지 않으면 `~/.better-workflows`를 사용합니다\. 기본 위치는 더 이상 `CODEX_HOME` 아래가 아닙니다\. 기존 v3 Codex 상태를 이동하지 않고 계속 사용하려면 `SBW_STATE_ROOT`를 해당 상태가 있는 정확한 `<CODEX_HOME>/sbw` 디렉터리로 명시적으로 설정한 뒤 `sbw`를 호출하세요\.

V5\.0 GA\(`5.0.0`\)는 아직 보류 상태입니다\. 아래 설치 명령어는 공개적으로 제공되는 V5\.0 RC1\(`5.0.0-rc.1`\, tag `V5.0.rc1`\)을 대상으로 합니다\.

## 설치

### Codex — 권장 기준 환경

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

설치 후 새 Codex 작업을 열어 스킬 카탈로그를 새로 고치세요\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI는 확장 프로그램을 복사합니다\. 설치 후 세션을 다시 시작하세요\. 이후 갱신할 때는 `gemini extensions update better-workflows`를 사용하세요\.

확장 프로그램 컨텍스트는 자체가 로드된 소스 경로를 기준으로 브리지를 찾으며\, 프로젝트 작업 디렉터리를 기준으로 삼지 않습니다\. 표준 사용자 범위 설치에서 이에 해당하는 수동 확인은 다음과 같습니다\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

링크된 확장 프로그램이나 작업 공간 범위의 확장 프로그램에서는 AI 에이전트 플랫폼이 표시하는 정확한 확장 프로그램 루트를 사용하세요\. 이름이 비슷한 체크아웃으로 대체하지 마세요\.

### Qwen Code

확장 프로그램의 로컬 사본을 설치하기 전에 릴리스를 고정하세요\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code도 확장 프로그램을 복사하므로 설치 후 세션을 다시 시작하고\, 이후 업데이트에는 `qwen extensions update better-workflows`를 사용하세요\.

표준 사용자 범위 설치에서 이에 해당하는 수동 브리지 확인은 다음과 같습니다\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

링크 방식이나 작업 공간 범위로 설치할 때도 정확한 루트를 사용해야 한다는 동일한 규칙이 적용됩니다\.

## Auto 사용

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

모든 진입점은 요청한 Goal을 유지합니다\. 관련 없는 활성 Goal은 명시적으로 수정하거나 지워야 하며\, 아무런 알림 없이 대체되는 일은 절대로 없습니다\.

## 경로 미리 보기

기능 스냅샷은 읽기 전용이며\, 제공업체 로그인이나 모델의 의미적 동작을 확인하는 프로브를 시작하지 않습니다\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

검토할 수 있는 인계를 위해 비공개이고 한 번만 사용할 수 있는 검증 가능한 기록 하나를 등록한 뒤 사용하세요\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

기록은 24시간 후 만료됩니다\. 재사용하거나 작업 공간\, 범위\, Profiles\, 카탈로그\, 기능 또는 플러그인 번들에 변동이 생기면 작업이 거부되며\, 불확실한 상태에서는 진행을 허용하지 않습니다\.

## 설치 확인

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## 저장소를 변경하기 전에

Auto는 읽기 전용 작업 공간 사전 점검으로 시작합니다\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Git을 사용하지 않는 작업과 읽기 전용 작업은 작업 트리를 만들지 않습니다\. 변경을 수행하는 Git 작업은 작업 소유의 `TaskWorkspaceLeaseV1`을 생성하거나 재사용해야 합니다\. 소스 작업 디렉터리에 커밋하지 않은 변경 사항이 있으면 stash\, 복사\, 커밋 또는 작업 트리 생성 중 어떤 작업도 수행하기 전에 중단됩니다\. HEAD가 분리되어 있거나 대상이 없으면 명시적인 통합 대상이 필요합니다\. 보호 대상 또는 원격 대상은 거버넌스 규칙을 따르는 PR 전달 절차로 전환됩니다\.

Codex 또는 다른 AI 에이전트 플랫폼이 현재 작업을 위한 깨끗한 작업 트리를 이미 만들었다면\, 중첩 작업 트리를 만들지 말고 편집 전에 기존 작업 트리를 등록하세요\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

등록하려면 변경되지 않은 기준점을 가리키는 별도의 `codex/*` 작업 브랜치\, 동일한 Git 공통 디렉터리\, 깨끗한 소스 체크아웃이 필요합니다\. Better Workflows는 해당 작업 트리를 사용하지만\, 정리할 때 플랫폼 소유의 브랜치와 경로를 보존합니다\. 보호 대상이라면 먼저 증거 워크플로를 실행한 다음\, `workspace reconcile --run-id <run-id>`로 해당 워크플로의 정확한 PR 병합 및 원격 동기화 검증 가능 기록을 바인딩하세요\.

다음\: [적합한 워크플로 선택하기](workflows.md) 또는 [CLI 레퍼런스 둘러보기](cli-reference.md)\.
