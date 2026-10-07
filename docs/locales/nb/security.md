<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Sikkerhetsretningslinjer

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · **Norsk bokmål** · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Bidra](contributing.md) · [Retningslinjer for oppførsel](conduct.md) · **Sikkerhet** · [Prosjektstyring](governance.md) · [Brukerstøtte](support.md)

[Oversikt i 41 lokaliserte utgaver og offisielle innganger på nettet](../../../docs/LANGUAGES.md)\. Den engelske versjonen av disse normative sikkerhetsretningslinjene forblir den autoritative kilden\.

Hvis den eneste foreslåtte beviskilden inneholder privat historikk eller sensitivt operativt materiale som ikke kan renses for sensitive opplysninger\, skal det ikke samles inn eller overføres\. Registrer bare en sladdet begrunnelse med `REJECTED_WITH_EVIDENCE`\.

## Støttede versjoner

| Versjon | Støtte |
| --- | --- |
| Siste publiserte utgivelse og uforanderlig Codex\-bygg | Støttet |
| Eldre uforanderlige hurtigbufferversjoner | Mål for tilbakerulling\; rettelser tilbakeføres ikke til eldre versjoner med mindre dette kunngjøres uttrykkelig |
| Ikke\-utgitte forgreninger eller endret hurtigbufferinnhold | Ikke støttet |

## Rapporter en sårbarhet

Bruk [privat rapportering av sårbarheter på GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. Ikke opprett en offentlig sak for en mistenkt sårbarhet\.

Ta med\:

- berørt versjon og programtilleggsbygg\;
- miljø og Node\.js\-versjon\;
- minimale trinn for å gjenskape problemet\;
- forventet og observert sikkerhetsgrense\;
- konsekvens og eventuell kjent midlertidig løsning\;
- om rapporten inneholder konfidensielt materiale\.

Ikke ta med aktive autentiseringsopplysninger\, signeringsnøkler\, leverandørtokener\, private ledetekster i råformat eller tredjeparters personopplysninger\.

## Respons

Den vedlikeholdsansvarlige bekrefter mottak av en brukbar rapport\, validerer omfanget og samordner utbedring og offentliggjøring\. Ingen SLA med fast responstid loves\. Ukjente eller ikke\-avstemte utfall forblir blokkert når verifisering mangler\.

## Sikkerhetsgrenser

Better Workflows forutsetter et betrodd lokalt kodelager\, en betrodd vertsmaskin og en betrodd kjørbar verktøykjede\. Tillatelsesmodellen i Node gir forsvar i dybden og er ikke en operativsystemsandkasse for ondsinnet kode\. Se den fullstendige [sikkerhetsveiledningen](security-guide.md)\.
