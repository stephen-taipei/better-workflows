<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# 기여하기

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · **한국어** · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Better Workflows 개선에 도움을 주셔서 감사합니다\.

[README](../../../README.md) · **기여 안내** · [행동 강령](conduct.md) · [보안](security.md) · [거버넌스](governance.md) · [지원](support.md)

[41개 로캘 버전의 현지화 개요와 공식 웹 진입점](../../../docs/LANGUAGES.md)\. 이 규범적 기여 정책은 영어판을 정본으로 합니다\.

## 시작하기 전에

- 새로운 공개 계약\, Auto의 공개 동작 변경\, 보안 경계 또는 대규모 아키텍처 변경은 먼저 이슈나 토론을 이용해 주세요\.
- 하나의 풀 리퀘스트는 한 가지 결과에만 집중하도록 유지하세요\.
- 자격 증명\, 비공개 프롬프트\, 원시 대화 기록\, 호스트 서명 키\, 공급자 영수증\, 서명된 증명은 절대 커밋하지 마세요\.
- 취약점은 [SECURITY\.md](security.md)에 설명된 대로 비공개로 보고해 주세요\.

## 개발 환경 설정

요구 사항\:

- Node\.js 24 이상\;
- 제삼자 런타임 의존성이 없을 것\;
- 현재 대상 브랜치를 기반으로 한 깨끗한 브랜치\.

전체 로컬 기준 검사를 실행하세요\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## 변경 규칙

1. Root 소유의 변경 및 fail\-closed 부작용 경계를 유지하세요\.
2. Auto의 공개 동작이 변경되면 템플릿과 스킬\, 엔트리포인트 카탈로그\, CLI\, 테스트 및 영향을 받는 모든 문서를 함께 업데이트하세요\.
3. 알 수 없는 CLI 옵션과 알 수 없는 스키마 필드는 거부하세요\.
4. 비공개 런타임 상태는 리포지토리 외부에 보관하세요\.
5. 모든 새로운 안전 게이트에 대해 네거티브 테스트를 추가하세요\.
6. 기존의 불변 플러그인 캐시 버전을 수정하지 마세요\. 번들이 변경되면 새로운 빌드 버전과 정확한 소스\/캐시 다이제스트 검증이 필요합니다\.

README 구성만 정리하는 경우 루트 페이지를 쉽게 훑어볼 수 있도록 유지하고\, 상세한 계약은 [`docs/guide/`](../../../docs/guide/) 아래의 해당 파일에 배치하세요\.

## 풀 리퀘스트 체크리스트

- [ ] 범위와 목표에 포함되지 않는 사항이 명확하다\.
- [ ] 동작과 안전성 경계를 문서화했다\.
- [ ] 목적에 맞춘 테스트가 성공 및 실패 경로를 다룬다\.
- [ ] 전체 테스트 모음과 `sbw eval`을 통과했다\.
- [ ] `git diff --check`를 통과했다\.
- [ ] 해당하는 경우 버전\/캐시 변경이 불변성을 유지하는 게시 규칙을 따른다\.
- [ ] 비밀 정보\, 비공개 상태 또는 외부 수신 확인서가 포함되지 않았다\.

작고 검토하기 쉬운 커밋을 권장합니다\. 관련 없는 정리 작업을 동작 변경과 함께 묶지 마세요\.
