<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Prispievanie

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · **Slovenčina** · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Ďakujeme\, že pomáhate zlepšovať Better Workflows\.

[README](../../../README.md) · **Ako prispieť** · [Kódex správania](conduct.md) · [Bezpečnosť](security.md) · [Správa projektu](governance.md) · [Podpora](support.md)

[Prehľad v 41 lokalizovaných vydaniach a oficiálne webové vstupné body](../../../docs/LANGUAGES.md)\. Rozhodujúcim znením tejto normatívnej politiky prispievania zostáva anglická verzia\.

## Skôr než začnete

- Na nový verejný kontrakt\, zmenu verejného správania Auto\, bezpečnostnú hranicu alebo veľkú architektonickú zmenu použite najprv issue alebo diskusiu\.
- Jeden pull request zamerajte na jeden výsledok\.
- Nikdy necommitujte prístupové údaje\, súkromné prompty\, nespracovanú históriu konverzácie\, podpisové kľúče hostiteľa\, potvrdenky poskytovateľa ani podpísané atestácie\.
- Zraniteľnosti nahlasujte súkromne podľa popisu v [SECURITY\.md](security.md)\.

## Nastavenie vývojového prostredia

Požiadavky\:

- Node\.js 24 alebo novší\;
- žiadne závislosti od tretích strán počas behu\;
- čistá vetva založená na aktuálnej cieľovej vetve\.

Spustite úplnú sadu lokálnych základných kontrol\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Pravidlá zmien

1. Zachovajte mutácie vo vlastníctve Root a hranice vedľajších účinkov fail\-closed\.
2. Keď sa zmení verejné správanie automatického režimu\, aktualizujte spoločne jeho šablónu a skill\, katalóg vstupných bodov\, CLI\, testy a všetku dotknutú dokumentáciu\.
3. Odmietajte neznáme voľby CLI a neznáme polia schémy\.
4. Uchovávajte súkromný stav runtime mimo repozitára\.
5. Pre každú novú bezpečnostnú bránu pridajte negatívne testy\.
6. Nemeňte existujúcu nemennú verziu plugin\-cache\. Zmenený balík vyžaduje novú verziu zostavenia a presné overenie kontrolného súčtu zdroja a cache\.

Pri úprave organizácie iba v README zachovajte prehľadnosť koreňovej stránky a podrobné kontrakty umiestnite do zodpovedajúceho súboru v [`docs/guide/`](../../../docs/guide/)\.

## Kontrolný zoznam žiadosti o začlenenie zmien

- [ ] Rozsah a to\, čo nie je cieľom\, sú výslovne uvedené\.
- [ ] Správanie a bezpečnostné hranice sú zdokumentované\.
- [ ] Cielené testy pokrývajú úspešné aj neúspešné cesty\.
- [ ] Úplná testovacia sada aj `sbw eval` prechádzajú úspešne\.
- [ ] `git diff --check` prechádza úspešne\.
- [ ] Zmeny verzií\/vyrovnávacej pamäte dodržiavajú pravidlá nemenného publikovania\, ak sa na ne vzťahujú\.
- [ ] Nie sú zahrnuté žiadne tajné údaje\, súkromný stav ani externé potvrdenia\.

Uprednostňujú sa malé commity\, ktoré sa dajú ľahko skontrolovať\. Nespájajte nesúvisiace upratovanie so zmenou správania\.
