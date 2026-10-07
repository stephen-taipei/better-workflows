<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Contribuții

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · **Română** · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Vă mulțumim că ajutați la îmbunătățirea Better Workflows\.

[README](../../../README.md) · **Contribuții** · [Cod de conduită](conduct.md) · [Securitate](security.md) · [Administrarea proiectului](governance.md) · [Asistență](support.md)

[Prezentare generală în 41 de versiuni localizate și puncte oficiale de acces web](../../../docs/LANGUAGES.md)\. Versiunea în engleză a acestei politici normative privind contribuțiile rămâne sursa canonică\.

## Înainte de a începe

- Folosește mai întâi un issue sau o discuție pentru un nou contract public\, o schimbare în comportamentul public al Auto\, o frontieră de securitate sau o modificare arhitecturală majoră\.
- Păstrează fiecare pull request concentrat pe un singur rezultat\.
- Nu include niciodată în commituri date de autentificare\, prompturi private\, istoricul brut al conversațiilor\, chei de semnare ale gazdei\, chitanțe de la furnizori sau atestări semnate\.
- Raportează vulnerabilitățile în mod confidențial\, conform instrucțiunilor din [SECURITY\.md](security.md)\.

## Configurarea mediului de dezvoltare

Cerințe\:

- Node\.js 24 sau o versiune mai nouă\;
- nicio dependență de la terți la execuție\;
- o ramură curată\, bazată pe ramura țintă curentă\.

Rulați întregul set local de verificări de bază\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Reguli pentru modificări

1. Păstrează mutațiile deținute de Root și limitele efectelor secundare de tip fail\-closed\.
2. Când comportamentul public al Auto se schimbă\, actualizează împreună șablonul și skill\-ul\, catalogul punctelor de intrare\, CLI\-ul\, testele și toată documentația afectată\.
3. Respinge opțiunile CLI necunoscute și câmpurile de schemă necunoscute\.
4. Păstrează starea privată de runtime în afara depozitului\.
5. Adaugă teste negative pentru fiecare poartă nouă de siguranță\.
6. Nu modifica o versiune existentă și imuabilă din memoria cache a pluginurilor\. Un pachet modificat necesită o nouă versiune de build și verificarea exactă a rezumatului \(digest\) sursă\/cache\.

Pentru reorganizări limitate la README\, păstrați pagina rădăcină ușor de parcurs și plasați contractele detaliate în fișierul corespunzător din [`docs/guide/`](../../../docs/guide/)\.

## Lista de verificare a cererii de integrare

- [ ] Domeniul de aplicare și aspectele care nu sunt obiective sunt explicite\.
- [ ] Comportamentul și limitele de siguranță sunt documentate\.
- [ ] Testele focalizate acoperă căile de succes și de eșec\.
- [ ] Întreaga suită de teste și `sbw eval` trec cu succes\.
- [ ] `git diff --check` trece cu succes\.
- [ ] Modificările de versiune și de memorie cache respectă regulile de publicare imuabilă\, când acestea se aplică\.
- [ ] Nu sunt incluse secrete\, stare privată sau confirmări externe\.

Sunt preferate înregistrările de modificări mici și ușor de revizuit\. Nu combinați curățări fără legătură cu o modificare de comportament\.
