<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# 보안 정책

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · **한국어** · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [기여 안내](contributing.md) · [행동 강령](conduct.md) · **보안** · [거버넌스](governance.md) · [지원](support.md)

[41개 로캘 버전의 현지화 개요와 공식 웹 진입점](../../../docs/LANGUAGES.md)\. 이 규범적 보안 정책은 영어판을 정본으로 합니다\.

제안된 유일한 증거 출처에 민감한 정보를 제거할 수 없는 비공개 이력이나 민감한 운영 자료가 포함되어 있다면 이를 수집하거나 전송하지 마세요\. 민감한 내용을 가린 `REJECTED_WITH_EVIDENCE` 사유만 기록하세요\.

## 지원 버전

| 버전 | 지원 상태 |
| --- | --- |
| 최신 공개 릴리스 및 변경 불가능한 Codex 빌드 | 지원됨 |
| 이전 버전의 변경 불가능한 캐시 | 롤백 대상이며\, 명시적으로 공지하지 않는 한 수정 사항을 이전 버전에 이식하지 않음 |
| 출시되지 않은 포크 또는 수정된 캐시 내용 | 지원되지 않음 |

## 취약점 신고

[GitHub 비공개 취약점 신고](https://github.com/stephen-taipei/better-workflows/security/advisories/new)를 이용해 주세요\. 취약점이 의심되는 경우 공개 이슈를 만들지 마세요\.

다음 내용을 포함하세요\:

- 영향을 받는 버전 및 플러그인 빌드\;
- 환경 및 Node\.js 버전\;
- 최소 재현 단계\;
- 예상한 보안 경계와 실제로 관찰한 보안 경계\;
- 영향 및 알려진 우회 해결책\;
- 신고에 기밀 자료가 포함되어 있는지 여부\.

현재 유효한 인증 정보\, 서명 키\, 제공업체 토큰\, 가공되지 않은 비공개 프롬프트 또는 제삼자의 개인 정보를 포함하지 마세요\.

## 대응

유지관리자는 처리 가능한 신고의 접수를 알리고\, 범위를 검증하며\, 문제 해결과 공개를 조율합니다\. 고정된 응답 시간을 보장하는 SLA는 약속하지 않습니다\. 결과를 알 수 없거나 대조 확인이 끝나지 않았다면 검증되지 않은 실행을 거부하는 상태를 유지합니다\.

## 보안 경계

Better Workflows는 로컬 저장소\, 호스트 및 실행 가능한 도구 모음을 신뢰할 수 있다고 가정합니다\. Node의 권한 모델은 심층 방어 수단이며\, 악성 코드를 격리하기 위한 운영체제 샌드박스가 아닙니다\. 전체 [보안 가이드](security-guide.md)를 참고하세요\.
