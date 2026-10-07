<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Bidra

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · **Norsk bokmål** · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Takk for at du hjelper til med å forbedre Better Workflows\.

[README](../../../README.md) · **Bidra** · [Retningslinjer for oppførsel](conduct.md) · [Sikkerhet](security.md) · [Prosjektstyring](governance.md) · [Brukerstøtte](support.md)

[Oversikt i 41 lokaliserte utgaver og offisielle innganger på nettet](../../../docs/LANGUAGES.md)\. Den engelske versjonen av disse normative retningslinjene for bidrag forblir den autoritative kilden\.

## Før du begynner

- Bruk en issue eller diskusjon først ved en ny offentlig kontrakt\, en endring i Autos offentlige atferd\, en sikkerhetsgrense eller en større arkitektonisk endring\.
- Hold hver pull request fokusert på ett enkelt resultat\.
- Gjør aldri commit av legitimasjon\, private prompter\, rå samtalehistorikk\, vertens signeringsnøkler\, provider\-kvitteringer eller signerte attesteringer\.
- Rapporter sårbarheter privat som beskrevet i [SECURITY\.md](security.md)\.

## Oppsett av utviklingsmiljø

Krav\:

- Node\.js 24 eller nyere\;
- ingen tredjepartsavhengighet ved kjøring\;
- en ren gren basert på gjeldende målgren\.

Kjør hele det lokale grunnlaget av kontroller\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Regler for endringer

1. Bevar Root\-eid mutasjon og fail\-closed\-grenser for sideeffekter\.
2. Når Autos offentlige atferd endres\, oppdater malen og ferdigheten \(skill\)\, startpunktkatalogen\, CLI\, tester og all berørt dokumentasjon samtidig\.
3. Avvis ukjente CLI\-flagg og ukjente skjemafelt\.
4. Hold privat kjøretidstilstand utenfor repositoriet\.
5. Legg til negative tester for hver nye sikkerhetsport\.
6. Ikke muter en eksisterende uforanderlig versjon i programtillegg\-cachen\. En endret pakke krever en ny build\-versjon og nøyaktig digest\-verifisering av kilde\/cache\.

Ved organisering som bare gjelder README\, skal rotsiden være lett å skanne\, og detaljerte kontrakter plasseres i den tilsvarende filen under [`docs/guide/`](../../../docs/guide/)\.

## Sjekkliste for endringsforespørsler

- [ ] Omfang og det som ikke inngår i målene\, er uttrykkelig angitt\.
- [ ] Atferd og sikkerhetsgrenser er dokumentert\.
- [ ] Målrettede tester dekker både vellykkede og mislykkede forløp\.
- [ ] Hele testpakken og `sbw eval` består\.
- [ ] `git diff --check` består\.
- [ ] Versjons\- og hurtigbufferendringer følger reglene for uforanderlig publisering der de gjelder\.
- [ ] Ingen hemmeligheter\, privat tilstand eller eksterne kvitteringer er inkludert\.

Små innsjekkinger som er enkle å gjennomgå\, foretrekkes\. Ikke kombiner uvedkommende opprydding med en atferdsendring\.
