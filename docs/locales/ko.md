<div align="center">

# Better Workflows

Better Workflows V5.0 RC1이 공개되었습니다: 최신 증거, 검토 게이트, 프로바이더 조정을 갖춘 AI 엔지니어링 QA 및 전달을 위한 무료 오픈 소스 Auto 워크플로입니다.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · **한국어** · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[문서 살펴보기](https://betterworkflows.dev/ko/docs/) · [GitHub 열기](https://github.com/stephen-taipei/better-workflows) · [USDT (TRC20)로 후원](https://betterworkflows.dev/#sponsor)

</div>

V5.0 RC1은 macOS × Node 22/24 환경의 Codex, Gemini CLI, Qwen Code를 지원합니다. Claude Code, Linux, Windows 적격성 평가는 V5.1로 연기되었습니다. GA에는 최소 30일의 자연일 카나리 기간, 20회 연속 적격 시작, 3개의 서로 다른 저장소가 필요합니다.

## 에이전트의 작업을<br>완료를 입증할 수 있는 상태까지 이끕니다.

V5.0 RC1이 공개되었습니다. Auto는 목표, 범위, 리포지토리 및 위험을 확인한 다음 맞춤형 검사 또는 evidence 워크플로를 선택합니다. Git 변경은 작업 소유의 worktree를 사용하며, 전달에는 승인과 검증된 외부 결과가 필요합니다.

## 의도에서 완료까지 나누는 네 가지 명확한 경계.

contract를 정의하고 source와 evidence를 검증하며 외부 작업 결과를 대조한 뒤, terminal state가 확인된 경우에만 완료를 선언합니다.

- **01 · `TaskContract`** — V5.0 RC1이 공개되었습니다. Auto는 목표, 범위, 리포지토리 및 위험을 확인한 다음 맞춤형 검사 또는 evidence 워크플로를 선택합니다. Git 변경은 작업 소유의 worktree를 사용하며, 전달에는 승인과 검증된 외부 결과가 필요합니다.
- **02 · `evidence`** — Better Workflows V5.0 RC1이 공개되었습니다: 최신 증거, 검토 게이트, 프로바이더 조정을 갖춘 AI 엔지니어링 QA 및 전달을 위한 무료 오픈 소스 Auto 워크플로입니다.
- **03 · `reconciliation`** — contract를 정의하고 source와 evidence를 검증하며 외부 작업 결과를 대조한 뒤, terminal state가 확인된 경우에만 완료를 선언합니다.
- **04 · `terminal state`** — 명령이 실행됐다는 사실은 완료의 증거가 아닙니다. 재검증 가능한 결과가 증거입니다.

## 빠른 시작

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## 아키텍처 지도에서 실전 사용 사례로 이어집니다.

- [의도에서 완료까지 나누는 네 가지 명확한 경계.](https://betterworkflows.dev/ko/docs/)
- [빠른 시작](https://betterworkflows.dev/ko/docs/quick/)
- [아키텍처 지도에서 실전 사용 사례로 이어집니다.](https://betterworkflows.dev/ko/docs/use-cases/)
- [빠른 시작 — 아키텍처 지도에서 실전 사용 사례로 이어집니다.](https://betterworkflows.dev/ko/docs/use-cases/quick/)
- [증거 시네마](https://betterworkflows.dev/ko/docs/evidence-cinema/)

### 문서 살펴보기 · `ko`

이 참고 페이지의 개요는 현지화되어 있지만, 대화형 콘텐츠는 아직 모두 번역되지 않았습니다.

- **01 · 의도에서 완료까지 나누는 네 가지 명확한 경계.** — contract를 정의하고 source와 evidence를 검증하며 외부 작업 결과를 대조한 뒤, terminal state가 확인된 경우에만 완료를 선언합니다.
- **02 · 아키텍처 지도에서 실전 사용 사례로 이어집니다.** — V5.0 RC1이 공개되었습니다. Auto는 목표, 범위, 리포지토리 및 위험을 확인한 다음 맞춤형 검사 또는 evidence 워크플로를 선택합니다. Git 변경은 작업 소유의 worktree를 사용하며, 전달에는 승인과 검증된 외부 결과가 필요합니다.
- **03 · 빠른 시작** — Better Workflows V5.0 RC1이 공개되었습니다: 최신 증거, 검토 게이트, 프로바이더 조정을 갖춘 AI 엔지니어링 QA 및 전달을 위한 무료 오픈 소스 Auto 워크플로입니다.

- [`의도에서 완료까지 나누는 네 가지 명확한 경계.`](https://betterworkflows.dev/docs/reference/ko/index.html) · `ko`
- [`빠른 시작`](https://betterworkflows.dev/docs/reference/ko/preview.html) · `ko`
- [`아키텍처 지도에서 실전 사용 사례로 이어집니다.`](https://betterworkflows.dev/docs/reference/ko/use-cases/index.html) · `ko`
- [`빠른 시작 — 아키텍처 지도에서 실전 사용 사례로 이어집니다.`](https://betterworkflows.dev/docs/reference/ko/use-cases/preview.html) · `ko`
- [`증거 시네마`](https://betterworkflows.dev/docs/reference/ko/evidence-cinema/index.html) · `ko`

- [문서 살펴보기 · `ko`](../details/ko.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### 문서 살펴보기 · `en`



### 문서 살펴보기 · `ko`

- [보안 정책](ko/security.md) · `ko`
- [기여하기](ko/contributing.md) · `ko`
- [거버넌스](ko/governance.md) · `ko`
- [행동 강령](ko/conduct.md) · `ko`
- [제삼자 관련 고지](ko/notices.md) · `ko`
- [README 품질 설계 지침](ko/readme-quality.md) · `ko`
- [편집용 색상 시스템](ko/color-system.md) · `ko`
- [아키텍처](ko/architecture.md) · `ko`
- [보안](ko/security-guide.md) · `ko`
- [CLI 참조](ko/cli-reference.md) · `ko`
- [시작하기](ko/getting-started.md) · `ko`
- [워크플로](ko/workflows.md) · `ko`
- [지원](ko/support.md) · `ko`

## Better Workflows의 꾸준한 유지 관리를 도와주세요.

일회성 후원은 오픈 소스 유지 관리, 문서, 41개 로캘용 현지화 버전과 웹사이트 운영에 사용됩니다. 멤버십이나 roadmap 및 지원 우선권을 구매하는 것은 아닙니다.

[USDT (TRC20)로 후원](https://betterworkflows.dev/#sponsor)

---

명령이 실행됐다는 사실은 완료의 증거가 아닙니다. 재검증 가능한 결과가 증거입니다.
