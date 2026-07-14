# Better Workflows

[English](../README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

Better Workflows는 Codex를 위한 native-first, evidence-driven workflow입니다. Root만 코드 수정, Git/GitHub 작업, deploy, 위험 수용, 완료 선언을 수행하며 subagents는 조사, Review, 테스트 증거와 반증을 담당합니다.

## 설치

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

설치 후 새 Codex task를 열어 Skill catalog를 다시 불러오세요.

## Codex에서 사용하기

`@`를 누르고 `better`를 검색하거나 `/skills` → `List skills`를 선택하면 Skill picker가 열립니다.

![Codex Skill picker의 Better Workflows](assets/better-workflows-skill-picker.png)

항목을 선택한 뒤 원하는 결과를 설명하면 됩니다. Picker가 `$better-workflows:<name>`을 삽입합니다. `/goal`, template, mode, model alias를 외울 필요가 없습니다. 권장 기본값:

```text
$better-workflows:auto <완료하려는 결과를 설명>
```

모든 항목은 본 작업 전에 persistent Goal을 생성하거나 이어갑니다. `direct`도 동일합니다. 관련 없는 미완료 Goal이 있으면 조용히 덮어쓰지 않고 `/goal edit` 또는 `/goal clear`를 안내합니다.

### 빠른 선택

- 무엇을 선택할지 모르겠다면 `auto`.
- 작업 유형을 알고 있다면 8개 task entry 중 선택.
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
