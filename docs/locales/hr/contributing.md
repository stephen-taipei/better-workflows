<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Doprinošenje

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · **Hrvatski** · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Hvala što pomažete poboljšati Better Workflows\.

[README](../../../README.md) · **Doprinos projektu** · [Kodeks ponašanja](conduct.md) · [Sigurnost](security.md) · [Upravljanje projektom](governance.md) · [Podrška](support.md)

[Pregled u 41 lokaliziranoj verziji i službene pristupne točke na webu](../../../docs/LANGUAGES.md)\. Engleska verzija ove normativne politike doprinosa ostaje kanonski izvor\.

## Prije početka

- Prvo upotrijebite issue ili raspravu za novi javni ugovor\, promjenu javnog ponašanja alata Auto\, sigurnosnu granicu ili veliku arhitektonsku promjenu\.
- Neka jedan pull request bude usmjeren na jedan ishod\.
- Nikada nemojte commitati vjerodajnice\, privatne upite\, sirovu povijest razgovora\, ključeve potpisivanja domaćina\, račune pružatelja usluga ili potpisane atestacije\.
- Prijavite sigurnosne propuste privatno kako je opisano u [SECURITY\.md](security.md)\.

## Postavljanje razvojnog okruženja

Zahtjevi\:

- Node\.js 24 ili noviji\;
- bez ovisnosti trećih strana tijekom izvođenja\;
- čista grana temeljena na trenutačnoj ciljnoj grani\.

Pokrenite cijeli lokalni skup osnovnih provjera\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Pravila za promjene

1. Očuvajte mutacije čiji je vlasnik Root i fail\-closed granice nuspojava\.
2. Kada se promijeni javno ponašanje alata Auto\, zajedno ažurirajte njegov predložak i skill\, katalog ulaznih točaka\, CLI\, testove i svu obuhvaćenu dokumentaciju\.
3. Odbijte nepoznate CLI opcije i nepoznata polja sheme\.
4. Zadržite privatno runtime stanje izvan repozitorija\.
5. Dodajte negativne testove za svaki novi safety gate\.
6. Nemojte mijenjati postojeću nepromjenjivu verziju plugin\-cachea\. Izmijenjeni paket zahtijeva novu build verziju i provjeru točnog sažetka izvora\/predmemorije\.

Pri reorganizaciji koja obuhvaća samo README zadržite preglednost korijenske stranice i smjestite detaljne ugovore u odgovarajuću datoteku unutar [`docs/guide/`](../../../docs/guide/)\.

## Kontrolni popis za zahtjev za uključivanje promjena

- [ ] Opseg i ono što nije cilj izričito su navedeni\.
- [ ] Ponašanje i sigurnosne granice dokumentirani su\.
- [ ] Usmjereni testovi pokrivaju uspješne i neuspješne putanje\.
- [ ] Cijeli skup testova i `sbw eval` prolaze\.
- [ ] `git diff --check` prolazi\.
- [ ] Promjene verzije i predmemorije slijede pravila nepromjenjive objave kada su primjenjiva\.
- [ ] Nisu uključene tajne\, privatno stanje ni vanjske potvrde\.

Prednost imaju mali zapisi promjena koje je lako pregledati\. Nemojte spajati nepovezano čišćenje s promjenom ponašanja\.
