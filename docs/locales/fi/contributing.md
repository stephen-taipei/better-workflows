<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Osallistuminen

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · **Suomi** · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Kiitos\, että autat parantamaan Better Workflows \-projektia\.

[README](../../../README.md) · **Osallistuminen** · [Käytössäännöt](conduct.md) · [Tietoturva](security.md) · [Hallintomalli](governance.md) · [Tuki](support.md)

[Yleiskatsaus 41 lokalisoituna versiona ja viralliset verkkosivujen aloituskohdat](../../../docs/LANGUAGES.md)\. Tämän normatiivisen osallistumiskäytännön englanninkielinen versio säilyy määräävänä lähteenä\.

## Ennen aloittamista

- Avaa ensin issue tai aloita keskustelu\, jos kyseessä on uusi julkinen rajapintasopimus\, muutos Auton julkiseen toimintaan\, tietoturvaraja tai suuri arkkitehtuurimuutos\.
- Pidä yksi pull request kohdistettuna yhteen lopputulokseen\.
- Älä koskaan commitoi tunnistetietoja\, yksityisiä kehotteita\, raakaa keskusteluhistoriaa\, isännän allekirjoitusavaimia\, palveluntarjoajan kuitteja tai allekirjoitettuja todistuksia\.
- Ilmoita haavoittuvuuksista luottamuksellisesti ohjeen [SECURITY\.md](security.md) mukaisesti\.

## Kehitysympäristön määritys

Vaatimukset\:

- Node\.js 24 tai uudempi\;
- ei kolmannen osapuolen ajonaikaista riippuvuutta\;
- puhdas haara\, joka perustuu nykyiseen kohdehaaraan\.

Suorita koko paikallinen perustarkistuskokonaisuus\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Muutossäännöt

1. Säilytä Root\-omisteiset mutaatiot ja fail\-closed\-sivuvaikutusrajat\.
2. Kun Auton julkinen toiminta muuttuu\, päivitä sen mallipohja ja skill\, aloituspisteluettelo\, CLI\, testit ja kaikki asiaankuuluva dokumentaatio yhdessä\.
3. Hylkää tuntemattomat CLI\-valitsimet ja tuntemattomat skeemakentät\.
4. Pidä yksityinen ajonaikainen tila repositorion ulkopuolella\.
5. Lisää negatiiviset testit jokaiselle uudelle turvaportille\.
6. Älä muuta olemassa olevaa muuttumatonta plugin\-cache\-versiota\. Muuttunut paketti vaatii uuden koontiversion sekä tarkan lähde\-\/välimuistitiivisteen varmentamisen\.

Kun järjestellään vain README\-tiedostoa\, pidä juurisivu helposti silmäiltävänä ja sijoita yksityiskohtaiset sopimukset vastaavaan tiedostoon hakemistossa [`docs/guide/`](../../../docs/guide/)\.

## Yhdistämispyynnön tarkistuslista

- [ ] Soveltamisala ja tavoitteisiin kuulumattomat asiat on ilmaistu selvästi\.
- [ ] Toiminta ja turvallisuusrajat on dokumentoitu\.
- [ ] Kohdennetut testit kattavat onnistumis\- ja epäonnistumispolut\.
- [ ] Koko testikokonaisuus ja `sbw eval` menevät läpi\.
- [ ] `git diff --check` menee läpi\.
- [ ] Versio\- ja välimuistimuutokset noudattavat muuttumattoman julkaisemisen sääntöjä soveltuvin osin\.
- [ ] Mukana ei ole salaisuuksia\, yksityistä tilaa eikä ulkoisia kuitteja\.

Pieniä\, katselmoitavia muutoskirjauksia suositaan\. Älä yhdistä asiaan kuulumatonta siivousta toiminnan muutokseen\.
