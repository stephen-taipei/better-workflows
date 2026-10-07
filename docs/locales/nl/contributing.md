<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Bijdragen

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · **Nederlands** · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Bedankt voor je hulp bij het verbeteren van Better Workflows\.

[README](../../../README.md) · **Bijdragen** · [Gedragscode](conduct.md) · [Beveiliging](security.md) · [Projectbestuur](governance.md) · [Ondersteuning](support.md)

[Overzicht in 41 gelokaliseerde versies en officiële toegangspunten op het web](../../../docs/LANGUAGES.md)\. De Engelse versie blijft de gezaghebbende tekst van dit normatieve bijdragebeleid\.

## Voordat je begint

- Gebruik eerst een issue of discussie voor een nieuw openbaar contract\, een wijziging in het openbare gedrag van Auto\, een beveiligingsgrens of een grote architectuurwijziging\.
- Houd één pull request gericht op één resultaat\.
- Commit nooit inloggegevens\, privé\-prompts\, onbewerkte gespreksgeschiedenis\, host\-ondertekeningssleutels\, provider\-ontvangstbewijzen of ondertekende verklaringen\.
- Meld kwetsbaarheden privé zoals beschreven in [SECURITY\.md](security.md)\.

## Ontwikkelomgeving instellen

Vereisten\:

- Node\.js 24 of nieuwer\;
- geen afhankelijkheden van derden tijdens uitvoering\;
- een schone branch op basis van de huidige doelbranch\.

Voer de volledige lokale basiscontroles uit\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Regels voor wijzigingen

1. Behoud door Root beheerde mutaties en fail\-closed grenzen voor neveneffecten\.
2. Werk bij wijzigingen in het openbare gedrag van Auto de bijbehorende template en skill\, entrypoint\-catalogus\, CLI\, tests en alle getroffen documentatie gelijktijdig bij\.
3. Wijs onbekende CLI\-opties en onbekende schemavelden af\.
4. Bewaar private runtime\-status buiten de repository\.
5. Voeg negatieve tests toe voor elke nieuwe safety gate\.
6. Wijzig een bestaande onveranderlijke plugincache\-versie niet\. Een gewijzigde bundel vereist een nieuwe build\-versie en exacte verificatie van de bron\-\/cachedigest\.

Als je alleen de indeling van README aanpast\, houd de hoofdpagina dan overzichtelijk en plaats gedetailleerde contracten in het bijbehorende bestand onder [`docs/guide/`](../../../docs/guide/)\.

## Controlelijst voor samenvoegverzoeken

- [ ] De reikwijdte en wat niet tot de doelen behoort\, zijn expliciet vermeld\.
- [ ] Het gedrag en de veiligheidsgrenzen zijn gedocumenteerd\.
- [ ] Gerichte tests dekken zowel succesvolle als falende paden\.
- [ ] De volledige testsuite en `sbw eval` slagen\.
- [ ] `git diff --check` slaagt\.
- [ ] Versie\-\/cachewijzigingen volgen waar van toepassing de regels voor onveranderlijke publicatie\.
- [ ] Er zijn geen geheimen\, privétoestand of externe ontvangstbewijzen opgenomen\.

Kleine commits die goed te beoordelen zijn\, hebben de voorkeur\. Combineer niet\-gerelateerd opruimwerk niet met een gedragswijziging\.
