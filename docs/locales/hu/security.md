<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Biztonsági szabályzat

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · **Magyar** · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Közreműködés](contributing.md) · [Magatartási kódex](conduct.md) · **Biztonság** · [Projektirányítás](governance.md) · [Segítség](support.md)

[Áttekintés 41 lokalizált változatban és hivatalos webes belépési pontok](../../../docs/LANGUAGES.md)\. E normatív biztonsági szabályzat angol nyelvű változata marad a kanonikus forrás\.

Ha az egyetlen javasolt bizonyítékforrás magánjellegű előzményeket vagy olyan érzékeny üzemeltetési anyagot tartalmaz\, amelyből az érzékeny adatok nem távolíthatók el\, ne gyűjtsd be és ne továbbítsd\. Kizárólag egy kitakart érzékeny adatokat tartalmazó `REJECTED_WITH_EVIDENCE` indoklást rögzíts\.

## Támogatott verziók

| Verzió | Támogatás |
| --- | --- |
| A legutóbb közzétett kiadás és megváltoztathatatlan Codex\-build | Támogatott |
| Régebbi megváltoztathatatlan gyorsítótár\-verziók | Visszaállítási célverziók\; a javításokat nem vezetik vissza\, kivéve\, ha ezt kifejezetten bejelentik |
| Kiadatlan elágazások vagy módosított gyorsítótár\-tartalom | Nem támogatott |

## Sérülékenység bejelentése

Kérjük\, használd a [GitHub privát sérülékenység\-bejelentését](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. Feltételezett sérülékenységhez ne nyiss nyilvános hibajegyet\.

Add meg\:

- az érintett verziót és a bővítmény buildjét\;
- a környezetet és a Node\.js verzióját\;
- a reprodukáláshoz szükséges minimális lépéseket\;
- az elvárt és a megfigyelt biztonsági határt\;
- a hatást és az ismert kerülőmegoldásokat\;
- hogy a jelentés tartalmaz\-e bizalmas anyagot\.

Ne mellékelj érvényes hitelesítő adatokat\, aláírókulcsokat\, szolgáltatói tokeneket\, nyers privát modellutasításokat vagy harmadik felek személyes adatait\.

## Válaszadás

A karbantartó visszaigazolja a felhasználható jelentés beérkezését\, ellenőrzi annak hatókörét\, és összehangolja a javítást és a közzétételt\. Rögzített válaszidőt meghatározó SLA\-t nem ígérünk\. Az ismeretlen vagy nem egyeztetett kimenetelek ellenőrzés hiányában továbbra is blokkoltak maradnak\.

## Biztonsági határok

A Better Workflows megbízható helyi tárolót\, gazdagépet és végrehajtható eszközláncot feltételez\. A Node jogosultsági modellje többrétegű védelmet biztosít\, és nem operációs rendszer szintű elkülönített környezet rosszindulatú kód számára\. Lásd a teljes [biztonsági útmutatót](security-guide.md)\.
