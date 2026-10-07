<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Beveiligingsbeleid

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · **Nederlands** · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Bijdragen](contributing.md) · [Gedragscode](conduct.md) · **Beveiliging** · [Projectbestuur](governance.md) · [Ondersteuning](support.md)

[Overzicht in 41 gelokaliseerde versies en officiële toegangspunten op het web](../../../docs/LANGUAGES.md)\. De Engelse versie blijft de gezaghebbende tekst van dit normatieve beveiligingsbeleid\.

Als de enige voorgestelde bewijsbron privégeschiedenis of gevoelig operationeel materiaal bevat waaruit gevoelige informatie niet kan worden verwijderd\, verzamel of verstuur dit dan niet\. Leg alleen een onderbouwing voor `REJECTED_WITH_EVIDENCE` vast waarin gevoelige informatie is weggelakt\.

## Ondersteunde versies

| Versie | Ondersteuning |
| --- | --- |
| Laatst gepubliceerde uitgave en onveranderlijke Codex\-build | Ondersteund |
| Oudere versies van de onveranderlijke cache | Versies om naar terug te keren\; oplossingen worden niet naar oudere versies overgezet\, tenzij dit expliciet wordt aangekondigd |
| Niet\-uitgebrachte afsplitsingen of gewijzigde cache\-inhoud | Niet ondersteund |

## Een kwetsbaarheid melden

Gebruik [privémeldingen van kwetsbaarheden op GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. Open geen openbare probleemmelding voor een vermoedelijke kwetsbaarheid\.

Vermeld\:

- de getroffen versie en de build van de plug\-in\;
- de omgeving en de Node\.js\-versie\;
- de minimale stappen om het probleem te reproduceren\;
- de verwachte en waargenomen beveiligingsgrens\;
- de impact en eventuele bekende tijdelijke oplossingen\;
- of de melding vertrouwelijk materiaal bevat\.

Voeg geen actieve toegangsgegevens\, ondertekeningssleutels\, providertokens\, onbewerkte privé\- prompts of persoonsgegevens van derden toe\.

## Reactie

De beheerder bevestigt de ontvangst van een bruikbare melding\, controleert de reikwijdte en coördineert het herstel en de openbaarmaking\. Er wordt geen SLA met een vaste reactietijd toegezegd\. Bij onbekende of nog niet afgestemde uitkomsten blijft uitvoering zonder verificatie geblokkeerd\.

## Beveiligingsgrenzen

Better Workflows gaat uit van een vertrouwde lokale repository\, host en uitvoerbare verzameling ontwikkelhulpmiddelen\. Het machtigingsmodel van Node biedt gelaagde verdediging en is geen sandbox van het besturingssysteem voor kwaadaardige code\. Zie de volledige [beveiligingshandleiding](security-guide.md)\.
