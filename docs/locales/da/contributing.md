<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Bidrag

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · **Dansk** · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Tak\, fordi du hjælper med at forbedre Better Workflows\.

[README](../../../README.md) · **Bidrag** · [Adfærdskodeks](conduct.md) · [Sikkerhed](security.md) · [Projektstyring](governance.md) · [Hjælp](support.md)

[Oversigt i 41 lokaliserede udgaver og officielle indgange på nettet](../../../docs/LANGUAGES.md)\. Den engelske version af denne normative bidragspolitik forbliver den autoritative kilde\.

## Før du begynder

- Brug først et issue eller en diskussion ved en ny offentlig kontrakt\, en ændring af Autos offentlige adfærd\, en sikkerhedsgrænse eller en større arkitekturændring\.
- Hold hver pull request fokuseret på ét resultat\.
- Commit aldrig adgangsoplysninger\, private prompts\, rå samtalehistorik\, værts\- signeringsnøgler\, udbyderkvitteringer eller signerede attesteringer\.
- Rapportér sårbarheder privat som beskrevet i [SECURITY\.md](security.md)\.

## Opsætning af udviklingsmiljø

Krav\:

- Node\.js 24 eller nyere\;
- ingen runtime\-afhængighed fra tredjepart\;
- en ren gren baseret på den aktuelle målgren\.

Kør hele den lokale basisvalidering\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Regler for ændringer

1. Bevar Root\-ejet ændringsadgang og fail\-closed\-grænser for sideeffekter\.
2. Når Autos offentlige adfærd ændres\, skal dens skabelon og skill\, startpunktskatalog\, CLI\, tests og al berørt dokumentation opdateres samtidigt\.
3. Afvis ukendte CLI\-indstillinger og ukendte schemafelter\.
4. Hold privat kørselstilstand uden for lageret\.
5. Tilføj negative tests for hver ny sikkerhedsgate\.
6. Foretag ikke ændringer i en eksisterende uforanderlig version af plugin\-cachen\. Et ændret bundt kræver en ny build\-version og nøjagtig kilde\-\/cache\-kontrolsumverifikation\.

Ved omorganisering\, der kun omfatter README\, skal rodsiden være let at overskue\, og detaljerede kontrakter placeres i den tilsvarende fil under [`docs/guide/`](../../../docs/guide/)\.

## Tjekliste for ændringsanmodninger

- [ ] Omfang og det\, der ikke er et mål\, er udtrykkeligt angivet\.
- [ ] Adfærd og sikkerhedsgrænser er dokumenteret\.
- [ ] Målrettede test dækker både succes\- og fejlforløb\.
- [ ] Hele testsuiten og `sbw eval` består\.
- [ ] `git diff --check` består\.
- [ ] Versions\- og cacheændringer følger reglerne for uforanderlig offentliggørelse\, hvor det er relevant\.
- [ ] Ingen hemmeligheder\, privat tilstand eller eksterne kvitteringer er medtaget\.

Små indsendelser\, som er nemme at gennemgå\, foretrækkes\. Kombiner ikke uvedkommende oprydning med en adfærdsændring\.
