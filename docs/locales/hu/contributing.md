<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Közreműködés

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · **Magyar** · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Köszönjük\, hogy segítesz a Better Workflows fejlesztésében\.

[README](../../../README.md) · **Közreműködés** · [Magatartási kódex](conduct.md) · [Biztonság](security.md) · [Projektirányítás](governance.md) · [Segítség](support.md)

[Áttekintés 41 lokalizált változatban és hivatalos webes belépési pontok](../../../docs/LANGUAGES.md)\. E normatív közreműködési szabályzat angol nyelvű változata marad a kanonikus forrás\.

## Mielőtt elkezded

- Új nyilvános szerződés\, az Auto nyilvános viselkedésének megváltoztatása\, biztonsági határ vagy jelentős architekturális módosítás esetén először hozz létre egy issue\-t vagy discussiont\.
- Minden pull request csak egyetlen eredményre összpontosítson\.
- Soha ne commitolj hitelesítési adatokat\, privát promptokat\, nyers beszélgetési előzményeket\, gazda aláírókulcsokat\, szolgáltatói nyugtákat vagy aláírt igazolásokat\.
- A sebezhetőségeket privát módon jelentsd a [SECURITY\.md](security.md) fájlban leírtak szerint\.

## Fejlesztői környezet beállítása

Követelmények\:

- Node\.js 24 vagy újabb\;
- nincs harmadik féltől származó futásidejű függőség\;
- tiszta ág\, amely az aktuális célágon alapul\.

Futtasd a teljes helyi alapellenőrzési készletet\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Módosítási szabályok

1. Őrizd meg a Root\-tulajdonú mutációt és a fail\-closed mellékhatás\-határokat\.
2. Amikor az Auto nyilvános viselkedése megváltozik\, frissítsd a sablonját és skilljét\, a belépési pontok katalógusát\, a CLI\-t\, a teszteket és az összes érintett dokumentációt egyszerre\.
3. Utasítsd el az ismeretlen CLI\-opciókat és az ismeretlen sémamezőket\.
4. A privát futásidejű állapotot tartsd az adattáron kívül\.
5. Írj negatív teszteket minden új biztonsági kapuhoz\.
6. Ne módosíts meglévő\, nem módosítható beépülőmodul\-gyorsítótár verziót\. A módosított csomaghoz új buildverzió és pontos forrás\-\/gyorsítótár\-kivonat ellenőrzés szükséges\.

Kizárólag a README átrendezésekor tartsd könnyen áttekinthetően a gyökéroldalt\, és a részletes szerződéseket helyezd a [`docs/guide/`](../../../docs/guide/) alatti megfelelő fájlba\.

## Beolvasztási kérelem ellenőrzőlistája

- [ ] A hatókör és a célok közé nem tartozó elemek egyértelműek\.
- [ ] A viselkedés és a biztonsági határok dokumentáltak\.
- [ ] A célzott tesztek lefedik a sikeres és a sikertelen végrehajtási utakat\.
- [ ] A teljes tesztkészlet és a `sbw eval` sikeresen lefut\.
- [ ] A `git diff --check` sikeresen lefut\.
- [ ] A verzió\- és gyorsítótár\-módosítások követik a megváltoztathatatlan közzététel szabályait\, ahol azok alkalmazandók\.
- [ ] Nem szerepelnek benne titkok\, privát állapot vagy külső nyugták\.

A kis\, áttekinthető változásrögzítések előnyben részesítendők\. Ne kapcsolj össze oda nem tartozó takarítást viselkedésmódosítással\.
