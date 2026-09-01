<div align="center">

# Better Workflows

AI agent가 위험에 따라 검증 강도를 선택하고 격리된 환경에서 안전하게 작업을 완료합니다. 단순한 수정은 빠르게 끝내고, 중요한 작업은 evidence gate를 사용하며, Git 변경은 기본적으로 전용 worktree에서 수행합니다.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · **한국어** · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[문서 살펴보기](https://betterworkflows.dev/ko/docs/) · [GitHub 열기](https://github.com/stephen-taipei/better-workflows) · [Ko-fi에서 후원](https://ko-fi.com/betterworkflows)

</div>

## 에이전트의 작업을<br>완료를 입증할 수 있는 상태까지 이끕니다.

Better Workflows는 goal, scope, authority를 고정하고 모든 판단을 현재 소스에 바인딩되어 여전히 유효하고 재검증 가능한 증거 및 대조가 끝난 외부 결과에 연결합니다.

## 의도에서 완료까지 나누는 네 가지 명확한 경계.

contract를 정의하고 source와 evidence를 검증하며 외부 작업 결과를 대조한 뒤, terminal state가 확인된 경우에만 완료를 선언합니다.

- **01 · `TaskContract`** — Better Workflows는 goal, scope, authority를 고정하고 모든 판단을 현재 소스에 바인딩되어 여전히 유효하고 재검증 가능한 증거 및 대조가 끝난 외부 결과에 연결합니다.
- **02 · `evidence`** — AI agent가 위험에 따라 검증 강도를 선택하고 격리된 환경에서 안전하게 작업을 완료합니다. 단순한 수정은 빠르게 끝내고, 중요한 작업은 evidence gate를 사용하며, Git 변경은 기본적으로 전용 worktree에서 수행합니다.
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
- [Evidence Cinema](https://betterworkflows.dev/ko/docs/evidence-cinema/)

- [`DETAILS · ko`](../details/ko.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### `GUIDES · en`

- [`getting-started`](../guide/getting-started.md) · `en`
- [`workflows`](../guide/workflows.md) · `en`
- [`architecture`](../guide/architecture.md) · `en`
- [`security`](../guide/security.md) · `en`
- [`cli-reference`](../guide/cli-reference.md) · `en`
- [`readme-quality`](../guide/readme-quality.md) · `en`

### `POLICIES · en`

- [`CODE_OF_CONDUCT`](../../CODE_OF_CONDUCT.md) · `en`
- [`CONTRIBUTING`](../../CONTRIBUTING.md) · `en`
- [`GOVERNANCE`](../../GOVERNANCE.md) · `en`
- [`SECURITY`](../../SECURITY.md) · `en`
- [`SUPPORT`](../../SUPPORT.md) · `en`
- [`THIRD_PARTY_NOTICES`](../../THIRD_PARTY_NOTICES.md) · `en`
- [`ANSIBLE`](../../deploy/ansible/README.md) · `en`

### `RUNTIME SOURCE · en`

- [`plugins/better-workflows/skills/`](../../plugins/better-workflows/skills/)
- [`evidence-cinema/imagegen-manifest`](../html/evidence-cinema/assets/imagegen-manifest.md)
- [`use-cases/color-system`](../html/use-cases/assets/color-system.md)
- [`use-cases/imagegen-manifest`](../html/use-cases/assets/imagegen-manifest.md)
- [GitHub 열기](https://github.com/stephen-taipei/better-workflows)

## Better Workflows의 꾸준한 유지 관리를 도와주세요.

일회성 후원은 오픈 소스 유지 관리, 문서, 41개 로캘용 현지화 버전과 웹사이트 운영에 사용됩니다. 멤버십이나 로드맵·지원 우선권을 제공하지 않습니다.

[Ko-fi에서 후원](https://ko-fi.com/betterworkflows)

---

명령이 실행됐다는 사실은 완료의 증거가 아닙니다. 재검증 가능한 결과가 증거입니다.
