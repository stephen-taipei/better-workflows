<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Přispívání

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · **Čeština** · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Děkujeme\, že pomáháte zlepšovat Better Workflows\.

[README](../../../README.md) · **Jak přispět** · [Kodex chování](conduct.md) · [Bezpečnost](security.md) · [Správa projektu](governance.md) · [Podpora](support.md)

[Přehled ve 41 lokalizovaných verzích a oficiální webové vstupní body](../../../docs/LANGUAGES.md)\. Anglická verze těchto normativních zásad přispívání zůstává kanonickým zdrojem\.

## Než začnete

- Pro nový veřejný kontrakt\, změnu veřejného chování Auto\, bezpečnostní hranici nebo velkou změnu architektury použijte nejprve issue či diskuzi\.
- Udržujte jeden pull request zaměřený na jeden výsledek\.
- Nikdy necommitujte přihlašovací údaje\, soukromé prompty\, surovou historii konverzací\, podpisové klíče hostitele\, potvrzení od poskytovatelů ani podepsané atestace\.
- Zranitelnosti hlaste soukromě\, jak je popsáno v [SECURITY\.md](security.md)\.

## Nastavení vývojového prostředí

Požadavky\:

- Node\.js 24 nebo novější\;
- žádná závislost na třetích stranách za běhu\;
- čistá větev založená na aktuální cílové větvi\.

Spusťte úplnou místní sadu základních kontrol\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Pravidla změn

1. Zachovejte mutace vlastněné Root a fail\-closed hranice vedlejších účinků\.
2. Když se změní veřejné chování Auto\, aktualizujte společně jeho šablonu i skill\, katalog vstupních bodů\, CLI\, testy a veškerou dotčenou dokumentaci\.
3. Odmítejte neznámé volby CLI a neznámá pole schématu\.
4. Uchovávejte soukromý stav běhového prostředí mimo repozitář\.
5. Přidejte negativní testy pro každou novou bezpečnostní bránu\.
6. Neměňte existující neměnnou verzi plugin\-cache\. Změněný balíček vyžaduje novou verzi sestavení a přesné ověření kontrolního součtu zdroje\/cache\.

Při reorganizaci omezené na README zachovejte přehlednost kořenové stránky a podrobné kontrakty umístěte do odpovídajícího souboru v [`docs/guide/`](../../../docs/guide/)\.

## Kontrolní seznam požadavku na začlenění změn

- [ ] Rozsah a to\, co není cílem\, jsou výslovně uvedeny\.
- [ ] Chování a bezpečnostní hranice jsou zdokumentovány\.
- [ ] Cílené testy pokrývají úspěšné i neúspěšné cesty\.
- [ ] Úplná sada testů a `sbw eval` procházejí\.
- [ ] `git diff --check` prochází\.
- [ ] Změny verzí a mezipaměti dodržují pravidla neměnného publikování\, pokud se uplatňují\.
- [ ] Nejsou zahrnuty žádné tajné údaje\, soukromý stav ani externí potvrzení\.

Upřednostňují se malé\, snadno kontrolovatelné zápisy změn\. Nekombinujte nesouvisející úklid se změnou chování\.
