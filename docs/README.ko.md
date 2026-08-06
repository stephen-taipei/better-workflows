<div align="center">

# Better Workflows

### Goal-first · 증거 기반 · Fail-closed

Codex를 위한 governed workflow orchestration입니다. 작은 변경은 빠르게, 중요한 side effect는 엄격하게 처리합니다.

| Primitive | 거버넌스 대상 | 증거 경계 |
| --- | --- | --- |
| **Prompt** | 결과 | 텍스트는 권한을 부여하지 않음 |
| **Context** | 입력 | fresh digests 필수 |
| **Harness** | 도구 | allowlist의 producer만 신뢰 |
| **Loop** | 시도 | retry는 bounded |
| **Graph** | 상태 | read-only이며 scheduler나 권한 소스가 아님 |

민감하거나 private history는 수집하지 않고 redacted `REJECTED_WITH_EVIDENCE` disposition으로 거부합니다.

**모델 브랜드 목록:** Codex · Claude · Gemini(Antigravity `agy` 경유) ·
GPT-OSS(`agy` 경유) · Grok · Cursor · Kimi · Qwen · Kiro. `agy`는
transport metadata이며 별도 모델 브랜드가 아닙니다. 사용 가능 여부는 최신 semantic roster probe로 확인해야 합니다.

[![Version](https://img.shields.io/badge/version-3.1.1-2563EB?style=flat-square)](../plugins/better-workflows/package.json)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A524-3C873A?style=flat-square)](../plugins/better-workflows/package.json)
[![Dependencies](https://img.shields.io/badge/runtime_dependencies-0-0F766E?style=flat-square)](../plugins/better-workflows/package.json)
[![License](https://img.shields.io/badge/license-MIT-64748B?style=flat-square)](../LICENSE)

[English](../README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어**

</div>

| **개요** | [상세 설명](details/ko.md) | [빠른 시작](guide/getting-started.md) | [Workflows](guide/workflows.md) | [Architecture](guide/architecture.md) | [Security](guide/security.md) | [CLI](guide/cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

## 중요한 부분부터 확인

| **ROOT가 변경 소유** | **ACTION 전에 증거** | **UNKNOWN = STOP** |
| --- | --- | --- |
| 편집, 통합, deploy, 위험 수용, 완료 선언은 Root만 수행합니다. | Side effect 전에 fresh check, provenance, 명시적 gate가 필요합니다. | Drift, stale evidence, 알 수 없는 provider state는 fail closed입니다. |

| **13 TEMPLATES** | **WORKSPACE RECIPES** | **GRAPH VIEW** |
| --- | --- | --- |
| SOP를 외우지 않고 결과와 위험으로 route를 선택합니다. | 신뢰된 Node.js 기계적 단계를 재실행해 token을 절약합니다. | Typed 구조를 검사하지만 authority source가 되지 않습니다. |

### Control-plane v2

새 비-direct template run은 typed evidence, append-only execution ledger와 선언된
review policy를 사용합니다. completion은 승인된 evidence와 replay 상태로만 계산되며
텍스트나 caller `acceptanceIds`로 완료할 수 없습니다. Legacy v1 run은 v1 reader로
읽고 Graph View는 read-only task/dependency projection만 제공합니다.

![Prompt에서 Graph까지의 Better Workflows engineering stack](assets/better-workflows-engineering-stack.svg)

| 항목 | **Prompt** | **Context** | **Harness** | **Loop** | **Graph** |
| --- | --- | --- | --- | --- | --- |
| 핵심 질문 | 결과와 제약은 무엇인가? | 지금 무엇이 사실인가? | 누가 어디에서 무엇을 할 수 있는가? | 계속, 재시도, 중단 중 무엇인가? | Records와 gates는 어떻게 연결되는가? |
| Better Workflows | Goal + TaskContract | Profile + sentinel + evidence | Root + template + `sbw` + trusted recipe | Checkpoint + freshness + reconciliation | Derived typed Graph View |
| 신뢰성 | Acceptance와 non-goals 명시 | Stale state 거부 | Root가 mutation을 소유하고 side effect에는 action token 필요 | 명확한 중단 조건을 가진 bounded progress | 구조 오류는 fail closed |
| 의도적 경계 | Prompt는 authority가 아님 | Raw history를 몰래 탐색하지 않음 | Unbounded dynamic harness를 생성하지 않음 | Gate 없는 loop-until-done을 허용하지 않음 | Graph는 policy input이 아님 |

## 30초 만에 시작

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

새 Codex task를 열고 native picker에서 Better Workflows를 선택합니다.

```text
Codex CLI: @better
Codex App: /better
```

권장 시작점:

```text
$better-workflows:auto <필요한 결과 설명>
```

Automatic route는 구체적인 template과 최소 verification mode를 선택하지만 authority 부여, tool 설치, scope 확대는 할 수 없습니다.

[설치, 검증, 첫 workflow 실행 →](guide/getting-started.md)

## 결과에 따라 선택

| 필요한 작업 | 선택 |
| --- | --- |
| Codex가 안전한 route를 선택 | `$better-workflows:auto` |
| Repository review와 중복 제거 issues | `$better-workflows:review-issues` |
| 수정, PR, merge, owned resource cleanup | `$better-workflows:fix-issues-pr` |
| Atomic commits와 `dev` 대상 PR | `$better-workflows:pr-to-dev` |
| 여러 모델의 architecture 비교 | `$better-workflows:research` |
| Release 또는 비가역 작업 통제 | `$better-workflows:critical` |
| 반복 SOP를 신뢰된 Node.js mechanics로 변환 | `$better-workflows:workspace-recipe` |

[전체 entries, modes, templates 보기 →](details/ko.md)

## Gemini와 `agy`

Google은 consumer Gemini CLI를 `agy`로 실행하는 Antigravity CLI로 전환했습니다.
Better Workflows는 `agy`를 **transport**로, Gemini·Claude·GPT-OSS를
**model brands**로 기록합니다. Agy를 별도 모델 브랜드로 중복 집계하지 않습니다.

[Architecture, 보안 경계, 전체 사양 →](details/ko.md)

## 개발과 커뮤니티

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
```

[Contributing](../CONTRIBUTING.md) · [Code of conduct](../CODE_OF_CONDUCT.md) ·
[Security](../SECURITY.md) · [Support](../SUPPORT.md)

MIT. [LICENSE](../LICENSE)를 참고하세요.
