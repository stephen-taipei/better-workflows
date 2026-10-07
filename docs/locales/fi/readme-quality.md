<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# README\-laatusuunnitelma

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · **Suomi** · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Yleiskatsaus 41 lokalisoituna versiona ja viralliset verkkosivujen aloituskohdat](../../../docs/LANGUAGES.md)\. Tämän toimituksellisen suunnitelman englanninkielinen versio säilyy kanonisena lähteenä\.

Better Workflows \-projektin README on aloitussivu\, ei tiivistetty viiteopas\. Sen tehtävänä on auttaa lukijaa vastaamaan viiteen kysymykseen tässä järjestyksessä\:

1. Mikä tämä on\, ja sopiiko se minulle\?
2. Minkä ongelman se ratkaisee\?
3. Miksi minun pitäisi luottaa sen väitteisiin\?
4. Mikä on lyhin tie ensimmäiseen onnistumiseen\?
5. Minne minun pitäisi mennä seuraavaksi\?

Tämä suunnitelma määrittelee jokaisen tietovaraston README\-tiedoston kerrontaa\, visuaalista esitystä\, lokalisointia ja validointia koskevan sopimuksen\. Koneellisesti luettava lähde on [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Lähde lukijan päätöksestä

GitHub näyttää README\-tiedoston ennen suurinta osaa tietovaraston sisällöstä\. Ensimmäisen näkymän on siksi selvennettävä tuotteen lupaus\, kohdeyleisö ja rajattu seuraava toimi\. Se ei saa alkaa sisäisestä arkkitehtuurista\, täydellisestä komentoviitteestä tai julkaisun palauttamisen yksityiskohdista\.

Kirjoita näitä lukijoiden tehtäviä varten\:

- **Uusi vierailija\:** päätä nopeasti\, ratkaiseeko Better Workflows olennaisen ongelman\.
- **Uusi käyttäjä\:** asenna liitännäinen ja saavuta yksi onnistunut automaattireitti\.
- **Arvioija\:** ymmärrä valtuutusrajat ja fail\-closed\-toimintatapa\.
- **Palaava operaattori\:** siirry suoraan työnkulkua\, tietoturvaa\, arkkitehtuuria tai CLI\:tä koskevaan vastaukseen\.
- **Avustaja tai kääntäjä\:** löydä kanoninen sopimus\, kehityskomennot\, tuki ja hallintamalli\.

## Käytä syyn ja seurauksen kerrontaa

Viisi aloitussivuna toimivaa README\-tiedostoa käyttävät samaa kahdeksanosaista semanttista järjestystä\. Otsikot voivat olla kullekin kielelle luontevia\, mutta lukijan polku ei muutu\.

| Osio | Lukijan kysymys ja tehtävä kerronnassa |
| --- | --- |
| Lupaus ja yleisö | Mikä Better Workflows on\, miksi se on olemassa ja kenelle se on tarkoitettu\? |
| Ongelmasta tulokseen | Mikä menee vikaan\, kun aikomus\, toimivalta\, todistusaineisto ja palveluntarjoajan tulos sekoitetaan toisiinsa\? |
| Näyttö ja rajat | Mitkä takuut tekevät ehdotetusta tuloksesta uskottavan\? |
| Ensimmäinen onnistuminen | Mikä on lyhin täydellinen polku asennuksesta tulokseen\? |
| Valitse seuraava polku | Mikä työnkulku tai asiakirja vastaa lukijan tavoitetta\? |
| Elinkaari | Miten tavoitteesta päästään valmistumiseen täsmäytetyin tuloksin — tai turvalliseen pysähtymiseen\? |
| Luottamus ja rajoitukset | Mitä järjestelmä ei saa koskaan päätellä\, valtuuttaa tai väittää\? |
| Opi\, hanki apua\, osallistu | Missä ovat syventävät ohjeet\, tuki\, hallintoperiaatteet\, kehitys ja lisenssi\? |

Tämä järjestys muodostaa käytännöllisen kerronnan kaaren\:

- **Tausta\:** kehotteiden ohjaama työ voi ilmaista aikomuksen todistamatta toimivaltaa tai tilaa\.
- **Jännite\:** sivuvaikutukset muuttavat tämän puutteen tuloksen toimittamiseen liittyväksi riskiksi\.
- **Ratkaisu\:** Better Workflows yhdistää tavoitteen\, soveltamisalan\, todistusaineiston\, katselmoinnin\, toiminnan ja täsmäytyksen palveluntarjoajan tulokseen\.
- **Näyttö\:** nimenomaiset takuut ja rajat osoittavat\, miten ratkaisu toimii\.
- **Toiminta\:** lukija saavuttaa ensimmäisen onnistumisen ennen syvällisiä toteutusyksityiskohtia\.
- **Jatko\:** rooliin ja tulokseen perustuvat reitit ohjaavat lukijan oikeaan opastusmateriaaliin\, toimintaohjeeseen\, selitykseen tai viiteoppaaseen\.

## Erota aloitussivun sisältö syventävästä dokumentaatiosta

Käytä README\-tiedostoa päätöksen kannalta olennaisiin tietoihin\. Ohjaa syventäviin tietoihin tarkoituksen mukaan\:

- [Alkuun pääseminen](getting-started.md) on ensimmäisen käyttökerran opastus\.
- [Työnkulut](workflows.md) on tuloksen valinnan toimintaohje\.
- [Arkkitehtuuri](architecture.md) selittää ohjaustason ja kompromissit\.
- [Tietoturva](security-guide.md) selittää toimivallan\, yksityisyyden\, varmennuslausunnot ja toimintatavan\, joka estää toimet varmennuksen puuttuessa\.
- [CLI\-viite](cli-reference.md) on komentoviite\.
- Lokalisoidut `docs/details/*.md`\-sivut säilyttävät kattavat käännetyt yksityiskohdat\.

Älä toista aloitussivulla välimuistin palauttamista\, lukkojen omistajuutta\, palveluntarjoajien tiedonsiirron koko semantiikkaa\, tyhjentävää komentoluetteloa tai toteutuksen muutoshistoriaa\. Tiivis turvallisuusväite jää sivulle\; sen auditoitavat yksityiskohdat kuuluvat kanoniseen oppaaseen\.

Tämä erottelu noudattaa Diátaxis\-mallin jakoa opastuksiin\, toimintaohjeisiin\, selityksiin ja viiteaineistoon\. Yhtä sivua ei voi optimoida kaikille neljälle lukijan tarpeelle samanaikaisesti\.

## Perustele jokaisen visualisoinnin paikka

Käytä visualisointia vain\, kun suhteet\, hierarkia tai tilasiirtymät ovat sen avulla olennaisesti helpompia ymmärtää kuin tekstistä\.

Aloitussivuilla sallitaan kaksi visualisointia\:

1. **Toimivaltarajojen arkkitehtuuri\:** vastaa siihen\, mitkä kerrokset muovaavat aikomusta\, nykyisiä tosiasioita\, työkalujen valtuuksia\, rajattuja uudelleenyrityksiä ja vain lukuun tarkoitettua tilaa\.
2. **Elinkaari tavoitteesta valmistumiseen\:** vastaa siihen\, missä todistusaineisto tarkistetaan\, missä sivuvaikutukset valtuutetaan ja missä tuntematon tila pysäyttää etenemisen\.

Jokaisessa visualisoinnissa on oltava\:

- tiivis\, merkityksellinen vaihtoehtoinen teksti\;
- vieressä oleva tekstivastine\, joka säilyttää johtopäätöksen\, kun visualisointi on piilotettu tai Mermaid ei piirry\;
- olennaiset nimikkeet oikeana tekstinä aina kun mahdollista\;
- pysyvästi olennainen lukijan kysymys\, joka perustelee visualisoinnin pitämisen ajan tasalla\.

Älä lisää koristeellisia kuvakaappauksia\, tekstiä täynnä olevia kuvia tai kaaviota\, joka vain toistaa lyhyen luettelon\. Rajaa valintataulukot kahteen tiiviiseen sarakkeeseen\, jotta ne pysyvät käyttökelpoisina kapeilla näytöillä\.

## Säilytä merkitys kielten välillä

Englanti on semanttinen viite\, ei rivimäärän tavoite\. Perinteisen kiinan\, yksinkertaistetun kiinan\, japanin ja korean on kuulostettava luontevilta äidinkieliselle lukijalle samalla kun ne säilyttävät saman sopimuksen\.

Seuraavien asioiden on pysyttävä vastaavina\:

- kahdeksan semanttista osiota ja niiden järjestys\;
- ensimmäisen onnistumisen komennot ja tuotetunnisteet\;
- viisi toimivaltaa\, todistusaineistoa\, tuntematonta tilaa\, kehotteita ja yksityisyyttä koskevaa väitettä\;
- työnkulkujen\, tietoturvan\, arkkitehtuurin\, CLI\:n\, tuen\, hallintoperiaatteiden\, kehityksen ja lisenssin linkkikohteet\;
- visualisointien tarkoitus\, elinkaaren vaiheet ja tekstivastineet\;
- version lähde ja merkkikäytäntö\.

Otsikot\, lauserajat\, välimerkit\, esimerkit ja toimintakehotukset voivat olla kielelle luontevia\. Säilytä komennot\, valitsimet ja todistusaineiston tunnisteet alkuperäisessä muodossaan\, äläkä muuta tietoturvasääntöjen merkitystä\.

## Kirjoita silmäilyä ja kääntämistä varten

- Aloita lukijan tuloksesta ja sijoita tärkeät käsitteet otsikoiden ja kappaleiden alkuun\.
- Käytä aktiivia ja nimeä toiminnasta vastuussa oleva toimija\.
- Puhuttele lukijaa suoraan toimintaohjeissa\.
- Pidä kappaleet lyhyinä ja anna kullekin yksi tehtävä\.
- Käytä numeroituja luetteloita järjestyksille ja luettelomerkkejä vaihtoehdoille\, joilla ei ole järjestystä\.
- Käytä kuvaavia linkkejä yleisten ilmausten\, kuten ”napsauta tästä”\, sijaan\.
- Pidä otsikot hierarkkisina\, täsmällisinä ja samalla tasolla rinnakkaisesti muotoiltuina\.
- Suosi kirjaimellista\, yksiselitteistä kieltä\, jonka merkitys säilyy käännöksessä\.
- Sijoita ehdot ennen ohjeita ja odotetut tulokset komentojen jälkeen\.

## Validoi semantiikka\, älä koristelua

Dokumentaatiotestien on havaittava muutakin kuin vastaavat otsikot\. Ne varmistavat\:

- yksi H1 ja looginen otsikkohierarkia\;
- järjestetyt semanttiset osio\- ja kriittisten väitteiden merkitsimet\;
- täsmälliset ensimmäisen onnistumisen komennot ja vakaat tunnisteet\;
- suhteelliset linkit ja kielialuekohtaiset yksityiskohtien kohteet\;
- versiobadgen vastaavuus ajonaikaisen metadatan kanssa\;
- merkityksellinen kuvan alt\-teksti ja viereiset visuaaliset varavaihtoehdot\;
- yksi Mermaid\-elinkaari ja sen täydellinen tekstivastine\;
- kaksisarakkeinen taulukko ja kappalepituusbudjetit\;
- määriteltyjen syvällisten toteutustietojen puuttuminen laskeutumissivuilta\;

## Tutkimusperusta

- [GitHub\: Tietovaraston README\-tiedostosta](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) määrittelee README\-tiedoston tarkoituksen ensimmäisellä käynnillä ja suosittelee pitkän dokumentaation siirtämistä muualle\.
- [Diátaxis](https://diataxis.fr/start-here/) erottaa opastusten\, toimintaohjeiden\, selitysten ja viiteaineiston tarpeet\.
- [Microsoft\: Silmäiltävä sisältö](https://learn.microsoft.com/en-us/style-guide/scannable-content/) painottaa tärkeimmät asiat ensin esittävää rakennetta\, lyhyitä kappaleita ja johdonmukaisia visuaalisia aloituskohtia\.
- [Googlen kehittäjädokumentaation tyyli](https://developers.google.com/style/highlights) suosittelee aktiivia\, suoraa puhuttelua\, kuvaavia otsikoita\, saavutettavuutta ja kirjoittamista maailmanlaajuiselle yleisölle\.
- [GitHub\: Kaavioiden luominen](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) dokumentoi Mermaid\-tuen Markdownissa\.
- [W3C WAI\: Kuvien opastus](https://www.w3.org/WAI/tutorials/images/) edellyttää tekstivaihtoehtoja ja täydellisiä vastineita informatiivisille ja monimutkaisille visualisoinneille\.
