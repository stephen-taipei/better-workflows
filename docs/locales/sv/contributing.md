<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Bidra

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · **Svenska** · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Tack för att du hjälper till att förbättra Better Workflows\.

[README](../../../README.md) · **Bidra** · [Uppförandekod](conduct.md) · [Säkerhet](security.md) · [Projektstyrning](governance.md) · [Hjälp](support.md)

[Översikt i 41 lokaliserade utgåvor och officiella ingångar på webben](../../../docs/LANGUAGES.md)\. Den engelska versionen av denna normativa bidragspolicy förblir den auktoritativa källan\.

## Innan du börjar

- Använd ett issue eller en diskussion först vid nya offentliga kontrakt\, ändringar i Autos offentliga beteende\, en säkerhetsgräns eller en stor arkitekturförändring\.
- Håll en pull request fokuserad på ett enda utfall\.
- Checka aldrig in inloggningsuppgifter\, privata prompter\, rå konversationshistorik\, värdsigneringsnycklar\, leverantörskvitton eller signerade intyg\.
- Rapportera sårbarheter privat enligt beskrivningen i [SECURITY\.md](security.md)\.

## Konfigurera utvecklingsmiljön

Krav\:

- Node\.js 24 eller senare\;
- inga runtime\-beroenden från tredje part\;
- en ren gren baserad på den aktuella målgrenen\.

Kör hela den lokala baslinjen\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Ändringsregler

1. Bevara Root\-ägd mutering och säkerhetsspärrar \(fail\-closed\) för sidoeffekter\.
2. När Autos offentliga beteende ändras ska dess mall och skill\, startpunktskatalog\, CLI\, tester och all berörd dokumentation uppdateras tillsammans\.
3. Avvisa okända CLI\-alternativ och okända schemafält\.
4. Håll privat körtidsstatus utanför arkivet\.
5. Lägg till negativa tester för varje ny säkerhetsgrind\.
6. Ändra inte en befintlig oföränderlig version i insticksmodulscachen\. Ett ändrat paket kräver en ny versionsbyggnation och exakt verifiering av kontrollsumma för källa\/cache\.

När endast README\-strukturen ändras ska rotsidan förbli lätt att överblicka och detaljerade kontrakt placeras i motsvarande fil under [`docs/guide/`](../../../docs/guide/)\.

## Checklista för ändringsförslag

- [ ] Omfattning och sådant som inte ingår i målen är tydligt angivna\.
- [ ] Beteende och säkerhetsgränser är dokumenterade\.
- [ ] Riktade tester täcker både lyckade och misslyckade förlopp\.
- [ ] Hela testsviten och `sbw eval` godkänns\.
- [ ] `git diff --check` godkänns\.
- [ ] Versions\- och cacheändringar följer reglerna för oföränderlig publicering när de är tillämpliga\.
- [ ] Inga hemligheter\, privata tillstånd eller externa kvitton ingår\.

Små incheckningar som är lätta att granska föredras\. Kombinera inte orelaterad städning med en beteendeändring\.
