<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Bezpečnostná politika

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · **Slovenčina** · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Ako prispieť](contributing.md) · [Kódex správania](conduct.md) · **Bezpečnosť** · [Správa projektu](governance.md) · [Podpora](support.md)

[Prehľad v 41 lokalizovaných vydaniach a oficiálne webové vstupné body](../../../docs/LANGUAGES.md)\. Rozhodujúcim znením tejto normatívnej bezpečnostnej politiky zostáva anglická verzia\.

Ak jediný navrhovaný zdroj dôkazov obsahuje súkromnú históriu alebo citlivé prevádzkové materiály\, z ktorých nemožno odstrániť citlivé informácie\, nezbierajte ich ani neprenášajte\. Zaznamenajte iba odôvodnenie `REJECTED_WITH_EVIDENCE` so začiernenými citlivými údajmi\.

## Podporované verzie

| Verzia | Podpora |
| --- | --- |
| Najnovšie zverejnené vydanie a nemenné zostavenie Codex | Podporované |
| Staršie verzie nemennej vyrovnávacej pamäte | Cieľové verzie na návrat späť\; opravy sa neprenášajú do starších verzií\, pokiaľ to nie je výslovne oznámené |
| Nevydané odnože alebo upravený obsah vyrovnávacej pamäte | Nepodporované |

## Nahlásenie zraniteľnosti

Použite [súkromné nahlasovanie zraniteľností na GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. Pri podozrení na zraniteľnosť nevytvárajte verejné hlásenie problému\.

Uveďte\:

- dotknutú verziu a zostavenie doplnku\;
- prostredie a verziu Node\.js\;
- minimálne kroky na reprodukciu\;
- očakávanú a pozorovanú bezpečnostnú hranicu\;
- dosah a akékoľvek známe dočasné riešenie\;
- či hlásenie obsahuje dôverné materiály\.

Neuvádzajte platné prihlasovacie údaje\, podpisové kľúče\, tokeny poskytovateľov\, nespracované súkromné zadania pre modely ani osobné údaje tretích strán\.

## Reakcia

Správca potvrdí prijatie použiteľného hlásenia\, overí jeho rozsah a skoordinuje nápravu a zverejnenie informácií\. SLA s pevne stanoveným časom odozvy sa nesľubuje\. Pri neznámych alebo nezosúladených výsledkoch zostáva v platnosti odmietnutie vykonania bez overenia\.

## Bezpečnostné hranice

Better Workflows predpokladá dôveryhodný lokálny repozitár\, hostiteľský systém a spustiteľnú súpravu nástrojov\. Model oprávnení v Node je súčasťou viacvrstvovej obrany\, nie izolovaným prostredím operačného systému pre škodlivý kód\. Pozrite si úplnú [bezpečnostnú príručku](security-guide.md)\.
