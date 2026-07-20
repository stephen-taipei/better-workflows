# Better Workflows

[English](../README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

Better Workflows는 Codex를 위한 native-first, evidence-driven workflow입니다. Root만 코드 수정, Git/GitHub 작업, deploy, 위험 수용, 완료 선언을 수행하며 subagents는 조사, Review, 테스트 증거와 반증을 담당합니다.

## 설계 원칙

Better Workflows는 제한 없는 agent swarm이 아니라 거버넌스를 갖춘 orchestration layer입니다. 핵심 원칙은 다음과 같습니다.

- **Root-owned mutation:** Root만 수정, 통합, Git/GitHub mutation, deploy, 위험 수용과 완료 선언을 수행합니다.
- **Evidence before side effects:** side effect 전에 evidence, freshness, 권한, provider reconciliation을 요구하며 unknown outcome은 fail closed로 처리합니다.
- **Bounded delegation:** native subagents는 조사, Review, 테스트 증거와 반증으로 제한합니다. direct children은 최대 3개이고 재귀 delegation은 금지하며 독립 critics는 순차 실행합니다.
- **Persistent intent:** `/goal`은 turn을 넘어 사용자의 목표를 보존합니다. template과 mode는 검증 깊이만 정하고 목표를 조용히 바꾸지 않습니다.
- **Deterministic control plane:** `dw`는 contract, private state, sentinel, evidence, findings, lease, action token, reconciliation을 기록하지만 model이 생성한 command를 실행하지 않습니다.
- **Explicit completion:** 최신 acceptance evidence, 필요한 검사, 사용 가능한 rollback이 모두 있고 해결되지 않은 고위험 또는 unknown state가 없을 때만 완료합니다.
- **Fast path remains explicit:** 작고 되돌릴 수 있는 작업에는 `direct`를 사용해 전체 workflow journal 비용을 명시적으로 생략할 수 있습니다.

이 설계는 최대 병렬 처리량의 일부를 더 작고 검토 가능한 mutation surface와 예측 가능한 중지 조건으로 교환합니다. evidence나 사용자 권한을 기다리느라 멈추더라도 안전하지 않은 진행이 숨겨지지 않는 것을 우선합니다.

## Better Workflows와 Claude Dynamic Workflows 비교

여기서 “Claude Dynamic Workflows”는 Anthropic의 Claude Code 기능을 뜻하며 서드파티 패키지를 뜻하지 않습니다. 비교는 2026-07-20에 확인한 Anthropic 공개 자료인 [Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code), [A harness for every task](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code), [Claude Code 병렬 agent 문서](https://code.claude.com/docs/en/agents)를 기준으로 합니다.

| 관점 | Better Workflows | Claude Dynamic Workflows |
| --- | --- | --- |
| Orchestration | Selector, template, 명시적 mode와 deterministic local control plane. | Claude가 작업별 JavaScript harness를 동적으로 작성하고 run을 조정합니다. |
| 병렬 처리 | 작은 bounded native wave: direct children 최대 3개, critics는 순차 실행. | 대규모 fan-out과 장시간 작업을 목표로 하며, Anthropic은 수십~수백 개 subagents의 병렬 실행을 설명합니다. |
| State와 완료 조건 | Persistent `/goal`, private run state, sentinel, evidence, action token, reconciliation, fail-closed completion. | workflow progress를 저장해 중단 후 재개할 수 있으며 실제 run 형태는 동적으로 생성된 harness가 크게 결정합니다. |
| Mutation governance | Root-only mutation/integration. delegated agents는 contract상 read-only입니다. | subagents, worktree, model 선택, permission control을 지원하지만 workflow 자체는 작업별로 동적 생성됩니다. |
| 적응성 | Runtime freedom은 낮지만 side effect 전에 Review하기 쉽고 template에서 재현하기 쉽습니다. | Runtime adaptability가 높아 작업량을 알 수 없거나 고병렬, adversarial verification, 수일이 걸리는 작업에 적합합니다. |
| 처리량과 비용 | 의도적으로 보수적입니다. 병렬 worker가 적어 최고 처리량은 낮을 수 있지만 비용과 blast radius를 제한하기 쉽습니다. | 높은 처리량 잠재력이 있지만 공식적으로 일반 세션보다 훨씬 많은 token을 사용할 수 있다고 안내합니다. |
| 이식성 | Codex-native plugin과 Node.js helper이며 plugin을 실행할 수 있는 repository에 적용할 수 있습니다. | Claude Code CLI, Desktop, VS Code extension, API와 지원되는 cloud providers. |
| 적합한 작업 | Contract-sensitive refactor, Review, release, Git/GitHub 작업처럼 evidence와 rollback이 중요한 작업. | 대규모 migration, 전체 codebase 탐색, 대규모 verification, 동적 orchestration이 핵심 이점인 작업. |

### 실무상의 trade-off

주요 위험이 uncontrolled mutation, 불명확한 권한, 오래된 evidence, 되돌릴 수 없는 side effect라면 Better Workflows가 더 적합합니다. 명시적인 queue, checkpoint, fail-closed gates를 통해 왜 멈췄는지와 재개 전에 어떤 reconciliation이 필요한지를 설명하기 쉽습니다.

병목이 orchestration scale, 즉 많은 독립 subtask, 장시간 실행, 동적 loop, 대규모 migration이라면 Claude Dynamic Workflows가 유리합니다. 다만 Anthropic도 모든 작업에 workflow가 필요한 것은 아니며 token 사용량이 크게 증가할 수 있다고 안내합니다. 규모의 이점에는 cost/latency trade-off가 따릅니다.

두 시스템은 서로 다른 것을 최적화합니다. Better Workflows는 Codex 안에서 governed되고 Review 가능한 진행을, Claude Dynamic Workflows는 Claude Code 안에서 동적으로 생성되는 고병렬 harness를 우선합니다.

## 설치

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

설치 후 새 Codex task를 열어 Skill catalog를 다시 불러오세요.

## Codex에서 사용하기

### Codex CLI

Codex CLI에서는 `@`로 시작해 `better`를 검색한 뒤 CLI picker에서 Better Workflows skill 또는 항목을 선택합니다.

![Codex CLI Skill picker의 Better Workflows](assets/better-workflows-skill-picker-cli.png)

### Codex App

Codex App에서는 `/`로 시작해 `better`를 검색한 뒤 App picker에서 해당 command 또는 skill 항목을 선택합니다.

![Codex App command picker의 Better Workflows](assets/better-workflows-skill-picker-app.png)

어느 화면에서든 항목을 선택한 뒤 원하는 결과를 설명하면 됩니다. Picker가 `$better-workflows:<name>`을 삽입합니다. `/goal`, template, mode, model alias를 외울 필요가 없습니다. 권장 기본값:

```text
$better-workflows:auto <완료하려는 결과를 설명>
```

모든 항목은 본 작업 전에 persistent Goal을 생성하거나 이어갑니다. `direct`도 동일합니다. 관련 없는 미완료 Goal이 있으면 조용히 덮어쓰지 않고 `/goal edit` 또는 `/goal clear`를 안내합니다.

### 빠른 선택

- 무엇을 선택할지 모르겠다면 `auto`.
- 작업 유형을 알고 있다면 9개 task entry 중 선택.
- 검증 강도만 정하려면 `direct`, `verified`, `deep`, `critical`.
- 기존 명령 습관을 유지하려면 compatibility alias.

### 자동 및 작업 항목

| 항목 | 권장 상황 | 예시 |
| --- | --- | --- |
| `$better-workflows:auto` | 대부분의 작업에 권장. 위험과 증거에 따라 template, mode, critics를 자동 선택. | `$better-workflows:auto 현재 repo를 Review하고 검증된 문제를 수정한 뒤 PR 생성.` |
| `$better-workflows:review-issues` | 읽기 전용 audit, finding 중복 제거, 승인된 GitHub issue 생성. 코드는 수정하지 않음. | `$better-workflows:review-issues 최신 dev SHA를 Review하고 중복 없는 P0/P1/P2 issues 생성.` |
| `$better-workflows:fix-issues-pr` | Open issues를 다시 확인하고 Root가 수정 및 PR 생성. 승인된 경우에만 merge/cleanup. | `$better-workflows:fix-issues-pr dev open issues를 수정하고 fresh checks 후 merge 및 cleanup.` |
| `$better-workflows:cross-platform` | Backend, iOS, Android, Web의 schema, optional, enum, sync, version gate, headers. | `$better-workflows:cross-platform backend, iOS, Android contact sync contract를 확인하고 수정 후 PR 생성.` |
| `$better-workflows:ios-static` | 로컬 build를 피하는 Swift/iOS 정적 Review와 직렬 `project.pbxproj` 검증. | `$better-workflows:ios-static build 없이 iOS 변경을 Review하고 새 Swift 파일의 pbxproj 등록 확인.` |
| `$better-workflows:localization` | 다국어 변경, 특히 41 locales의 key 수, 순서, 정확한 scope, 지역 변형. | `$better-workflows:localization 41개 locales에 keys를 추가하고 동일한 순서인지 검증.` |
| `$better-workflows:ci-release` | CI failure, runner queue, 직렬 deploy, release, 원격 모니터링, receipt 검증. | `$better-workflows:ci-release 실패한 PR checks를 수정하고 직렬 dev deploy를 모니터링.` |
| `$better-workflows:browser-qa` | 최신 UI 증거, screenshots, 재현 가능한 action log가 필요한 Webwright／simulator QA. | `$better-workflows:browser-qa signup과 contact sync를 검증하고 screenshot evidence 첨부.` |
| `$better-workflows:research` | 증거 기반 조사, architecture 비교, 독립 관점, 반증. 다수결로 결정하지 않음. | `$better-workflows:research 세 가지 sync architecture를 비교·반증하고 권장안 제시.` |
| `$better-workflows:monorepo-refactor` | monorepo 전체를 조사한 뒤 적격한 bounded refactor 제안을 직접 구현하고 behavior invariants, validation, rollback evidence를 유지합니다. | `$better-workflows:monorepo-refactor monorepo를 조사하고 public contract를 바꾸지 않으면서 적격한 boundary cleanup을 구현.` |

### Review 강도 항목

| 항목 | 권장 상황 | 예시 |
| --- | --- | --- |
| `$better-workflows:direct` | 작고 되돌릴 수 있으며 명확한 작업. Goal은 사용하지만 workflow journal/critics는 사용하지 않음. | `$better-workflows:direct 한 줄 documentation typo를 수정하고 diff 확인.` |
| `$better-workflows:verified` | 일반 개발 작업에 1–3 read-only agents와 freshness evidence가 필요할 때. | `$better-workflows:verified pagination bug를 Review하고 수정한 뒤 PR 생성.` |
| `$better-workflows:deep` | Architecture, security, 광범위 refactor, 불확실한 변경. Verified wave와 독립 Codex critics 사용. | `$better-workflows:deep auth redesign을 Review하고 검증된 문제를 수정해 migration-safe PR 생성.` |
| `$better-workflows:critical` | Release, migration, production, 파괴적 cleanup, 비가역 side effects. 완전한 fail-closed gates 필요. | `$better-workflows:critical policy, remote SHA, reconciliation gates 통과 후에만 production release 실행.` |

### Compatibility aliases

| 항목 | 권장 상황 | 대응 경로 |
| --- | --- | --- |
| `$better-workflows:auto-improve` | 기존 `autoImprove`: Review, finding 검증, 수정, PR, 안전한 수렴. | Fix issues to PR, 기본 `deep` |
| `$better-workflows:auto-issues` | 기존 `autoIssues`: 읽기 전용 Review와 중복 없는 issue 생성. | Review to issues, 기본 `verified` |
| `$better-workflows:ai-meeting-tw` | 기존 AI meeting: Claude나 투표 없이 다중 관점 조사와 model critics. | Research deliberation, 기본 `deep` |
| `$better-workflows:git-check-issues` | 기존 issue repair: 상태 재조회, 수정, PR, 정확한 cleanup. | Fix issues to PR, 기본 `deep` |
| `$better-workflows` | 특정 항목을 선택하지 않은 자연어 router. | Template과 mode 자동 선택 |

## 모드

| Mode | 동작 |
| --- | --- |
| `direct` | Root가 직접 작업하며 durable workflow state를 만들지 않음. |
| `verified` | Root와 1–3 read-only research/review/refutation agents. |
| `deep` | `verified` 후 최대 2개의 Codex critics를 직렬 실행. |
| `critical` | 전체 evidence/side-effect gates와 policy 필수 외부 reviewer. |

## 개발 및 검증

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/dw.mjs eval
```

## License

MIT. [LICENSE](../LICENSE) 및 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)를 참고하세요.
