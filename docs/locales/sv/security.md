<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Säkerhetspolicy

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · **Svenska** · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Bidra](contributing.md) · [Uppförandekod](conduct.md) · **Säkerhet** · [Projektstyrning](governance.md) · [Hjälp](support.md)

[Översikt i 41 lokaliserade utgåvor och officiella ingångar på webben](../../../docs/LANGUAGES.md)\. Den engelska versionen av denna normativa säkerhetspolicy förblir den auktoritativa källan\.

Om den enda föreslagna beviskällan innehåller privat historik eller känsligt operativt material som inte kan rensas från känslig information\, får det inte samlas in eller överföras\. Registrera endast en maskerad motivering med `REJECTED_WITH_EVIDENCE`\.

## Versioner som stöds

| Version | Stöd |
| --- | --- |
| Senaste publicerade utgåvan och oföränderligt Codex\-bygge | Stöds |
| Äldre oföränderliga cacheversioner | Återställningsmål\; korrigeringar bakåtporteras inte om det inte uttryckligen meddelas |
| Opublicerade förgreningar eller modifierat cacheinnehåll | Stöds inte |

## Rapportera en sårbarhet

Använd [privat sårbarhetsrapportering på GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. Skapa inte ett offentligt ärende för en misstänkt sårbarhet\.

Ta med\:

- berörd version och tilläggsbygge\;
- miljö och Node\.js\-version\;
- minimala steg för att återskapa problemet\;
- förväntad och observerad säkerhetsgräns\;
- påverkan och eventuell känd tillfällig lösning\;
- om rapporten innehåller konfidentiellt material\.

Ta inte med aktiva autentiseringsuppgifter\, signeringsnycklar\, leverantörstoken\, privata prompter i råformat eller tredje parts personuppgifter\.

## Återkoppling

Projektförvaltaren bekräftar mottagandet av en användbar rapport\, verifierar dess omfattning och samordnar åtgärder och offentliggörande\. Ingen SLA med fast svarstid utlovas\. Okända eller ej avstämda utfall förblir blockerade i avsaknad av verifiering\.

## Säkerhetsgränser

Better Workflows förutsätter ett betrott lokalt kodarkiv\, en betrodd värddator och en betrodd körbar verktygskedja\. Behörighetsmodellen i Node ger försvar på djupet och är inte en operativsystemsbaserad sandlåda för skadlig kod\. Se den fullständiga [säkerhetsguiden](security-guide.md)\.
