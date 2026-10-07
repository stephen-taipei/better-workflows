<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Nacrt za kvalitetu datoteka README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · **Hrvatski** · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Pregled u 41 lokaliziranoj verziji i službene pristupne točke na webu](../../../docs/LANGUAGES.md)\. Engleska verzija ovog uredničkog nacrta ostaje kanonski izvor\.

README projekta Better Workflows odredišna je stranica\, a ne sažeti referentni priručnik\. Njegova je zadaća pomoći čitatelju da redom odgovori na pet pitanja\:

1. Što je ovo i je li namijenjeno meni\?
2. Koji problem rješava\?
3. Zašto bih trebao vjerovati njegovim tvrdnjama\?
4. Koji je najkraći put do prvog uspjeha\?
5. Kamo trebam ići dalje\?

Ovaj nacrt definira ugovor o narativu\, vizualnim prikazima\, lokalizaciji i provjeri valjanosti za svaki README u repozitoriju\. Strojno čitljiv izvor je [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Počnite od čitateljeve odluke

GitHub prikazuje README prije većine sadržaja repozitorija\. Prvi zaslon stoga mora jasno predstaviti obećanje proizvoda\, ciljanu publiku i sljedeću radnju s određenim granicama\. Ne smije počinjati internom arhitekturom\, potpunim referentnim pregledom naredbi ili pojedinostima o oporavku izdanja\.

Pišite za sljedeće čitateljeve zadatke\:

- **Novi posjetitelj\:** brzo procijenite rješava li Better Workflows relevantan problem\.
- **Novi korisnik\:** instalirajte dodatak i ostvarite jedno uspješno automatsko usmjeravanje\.
- **Procjenitelj\:** shvatite granicu ovlasti i fail\-closed ponašanje\.
- **Povratni operater\:** prijeđite na rješenje za tijek rada\, sigurnost\, arhitekturu ili CLI odgovor\.
- **Suradnik ili prevoditelj\:** pronađite kanonski ugovor\, razvojne naredbe\, podršku i upravljanje\.

## Koristite uzročno\-posljedični narativ

Pet odredišnih datoteka README koristi isti semantički slijed od osam dijelova\. Naslovi mogu biti idiomatski na svakom jeziku\, ali čitateljev put ostaje isti\.

| Odjeljak | Čitateljevo pitanje i narativna uloga |
| --- | --- |
| Obećanje i publika | Što je Better Workflows\, zašto postoji i komu je namijenjen\? |
| Od problema do ishoda | Što pođe po zlu kada se namjera\, ovlasti\, dokazi i ishod pružatelja usluge poistovjete\? |
| Dokaz i granice | Koja jamstva čine predloženi ishod vjerodostojnim\? |
| Prvi uspjeh | Koji je najkraći potpuni put od instalacije do rezultata\? |
| Odabir sljedećeg puta | Koji tijek rada ili dokument odgovara čitateljevu cilju\? |
| Životni ciklus | Kako cilj dovodi do dovršetka s usklađenim stanjem — ili do sigurnog zaustavljanja\? |
| Povjerenje i ograničenja | Što sustav nikada ne može zaključiti\, odobriti ili tvrditi\? |
| Učenje\, pomoć i doprinos | Gdje su detaljna dokumentacija\, podrška\, upravljanje\, razvoj i licenca\? |

Ovaj redoslijed daje praktičan tijek priče\:

- **Kontekst\:** rad vođen upitima modelu može izraziti namjeru bez dokazivanja ovlasti ili stanja\.
- **Napetost\:** nuspojave pretvaraju taj jaz u rizik za isporuku\.
- **Rješenje\:** Better Workflows povezuje cilj\, opseg\, dokaze\, pregled\, radnju i usklađivanje stanja s pružateljem usluge\.
- **Dokaz\:** izričita jamstva i granice pokazuju kako rješenje funkcionira\.
- **Radnja\:** čitatelj postiže prvi uspjeh prije nego što naiđe na duboke pojedinosti implementacije\.
- **Nastavak\:** putanje temeljene na ulozi i ishodu vode čitatelja do odgovarajućeg vodiča za učenje\, praktičnih uputa\, objašnjenja ili referentnog materijala\.

## Odvojite odredišni sadržaj od detaljne dokumentacije

Koristite README za informacije važne za donošenje odluke\. Usmjeravajte prema detaljima prema njihovoj svrsi\:

- [Prvi koraci](getting-started.md) vodič je za prvo korištenje\.
- [Tijekovi rada](workflows.md) praktični su vodič za odabir ishoda\.
- [Arhitektura](architecture.md) objašnjava upravljačku ravninu te prednosti i nedostatke rješenja\.
- [Sigurnost](security-guide.md) objašnjava ovlasti\, privatnost\, potvrde i ponašanje koje blokira izvršavanje bez uspješne provjere\.
- [Referentni pregled CLI](cli-reference.md) referentni je pregled naredbi\.
- Lokalizirane stranice `docs/details/*.md` čuvaju sveobuhvatne prevedene pojedinosti\.

Nemojte na odredišnoj stranici ponavljati oporavak predmemorije\, vlasništvo nad zaključavanjima\, potpunu semantiku prijenosa u komunikaciji s pružateljem usluge\, iscrpan popis naredbi ni povijest izmjena implementacije\. Sažeta sigurnosna tvrdnja ostaje na samoj stranici\; njezine pojedinosti koje omogućuju reviziju pripadaju kanonskom vodiču\.

Ovo razdvajanje slijedi Diátaxis razlikovanje vodiča za učenje\, praktičnih uputa\, objašnjenja i referentnog materijala\. Jedna stranica ne može istodobno optimalno zadovoljiti sve četiri čitateljeve potrebe\.

## Svaki vizualni prikaz mora opravdati svoje mjesto

Koristite vizualni prikaz samo kada se odnosi\, hijerarhija ili prijelazi stanja tako znatno lakše razumiju nego iz teksta\.

Odredišne stranice dopuštaju dva vizualna prikaza\:

1. **Arhitektura granica ovlasti\:** odgovara na pitanje koji slojevi oblikuju namjeru\, aktualne činjenice\, ovlasti alata\, ograničene ponovne pokušaje i stanje samo za čitanje\.
2. **Životni ciklus od cilja do dovršetka\:** odgovara na pitanje gdje se provjeravaju dokazi\, gdje se odobravaju nuspojave i gdje nepoznato stanje zaustavlja napredak\.

Svaki vizualni prikaz mora uključivati\:

- sažet i smislen alternativni tekst\;
- susjedni tekstualni ekvivalent koji čuva zaključak kada je vizualni prikaz skriven ili se Mermaid ne iscrtava\;
- stvarni tekst za ključne oznake kad god je to moguće\;
- trajno relevantno čitateljevo pitanje koje opravdava održavanje prikaza ažurnim\.

Nemojte dodavati ukrasne snimke zaslona\, slike prepune teksta ni dijagram koji samo ponavlja kratak popis\. Ograničite tablice za odabir na dva sažeta stupca kako bi ostale upotrebljive na uskim zaslonima\.

## Sačuvajte značenje među jezicima

Engleski je semantička referenca\, a ne cilj za broj redaka\. Tradicionalni kineski\, pojednostavljeni kineski\, japanski i korejski trebaju zvučati prirodno izvornom govorniku\, uz očuvanje istog ugovora\.

Sljedeće stavke moraju ostati istovrijedne\:

- osam semantičkih odjeljaka i njihov redoslijed\;
- naredbe za prvi uspjeh i identifikatori proizvoda\;
- pet tvrdnji o ovlastima\, dokazima\, nepoznatom stanju\, upitima modelu i privatnosti\;
- odredišta za tijekove rada\, sigurnost\, arhitekturu\, CLI\, podršku\, upravljanje\, razvoj i licencu\;
- svrha vizualnih prikaza\, faze životnog ciklusa i tekstualne zamjene\;
- izvor verzije i pravila za značke\.

Naslovi\, granice rečenica\, interpunkcija\, primjeri i pozivi na radnju mogu biti idiomatski\. Nikada nemojte prevoditi naredbe\, selektore\, identifikatore dokaza ni sigurnosnu semantiku\.

## Pišite za brzo pregledavanje i prevođenje

- Počnite od čitateljeva ishoda i stavite važne pojmove na početak naslova i odlomaka\.
- Koristite aktivni oblik i navedite tko je odgovoran za radnju\.
- U postupcima se izravno obraćajte čitatelju\.
- Odlomci neka budu kratki i neka svaki ima samo jednu zadaću\.
- Koristite numerirane popise za slijed\, a grafičke oznake za izbore bez određenog redoslijeda\.
- Koristite opisne poveznice umjesto općih oznaka poput „kliknite ovdje”\.
- Naslovi neka budu hijerarhijski\, konkretni i paralelno oblikovani na istoj razini\.
- Dajte prednost doslovnom\, nedvosmislenom jeziku koji čuva značenje pri prevođenju\.
- Stavite uvjete prije uputa\, a očekivane ishode nakon naredbi\.

## Provjeravajte semantiku\, a ne ukrase

Testovi dokumentacije moraju otkriti više od podudaranja naslova\. Provjeravaju\:

- jedan H1 i logična hijerarhija naslova\;
- uređeni semantički odjeljci i oznake ključnih tvrdnji\;
- točne naredbe za prvi uspjeh i stabilni identifikatori\;
- relativne poveznice i odredišta pojedinosti specifična za lokalitet\;
- usklađenost oznaka verzije s metapodacima izvođenja\;
- smislen alternativni tekst slika i pripadajuće vizualne zamjene\;
- jedan Mermaid životni ciklus s potpunim tekstualnim ekvivalentom\;
- tablica s dva stupca i ograničenja duljine odlomaka\;
- odsutnost označenih dubokih pojedinosti implementacije s odredišnih stranica\;

## Istraživačka osnova

- [GitHub\: O datoteci README repozitorija](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) definira svrhu datoteke README pri prvom posjetu i preporučuje premještanje opsežne dokumentacije na drugo mjesto\.
- [Diátaxis](https://diataxis.fr/start-here/) razdvaja potrebe za vodičima za učenje\, praktičnim uputama\, objašnjenjima i referentnim materijalom\.
- [Microsoft\: Sadržaj za brzo pregledavanje](https://learn.microsoft.com/en-us/style-guide/scannable-content/) naglašava strukturu koja najvažnije stavlja na početak\, kratke odlomke i dosljedne vizualne ulazne točke\.
- [Stil Google dokumentacije za razvojne programere](https://developers.google.com/style/highlights) preporučuje aktivni oblik\, izravno obraćanje\, opisne naslove\, pristupačnost i pisanje za globalnu publiku\.
- [GitHub\: Izrada dijagrama](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) dokumentira podršku za Mermaid u Markdown\.
- [W3C WAI\: Vodič o slikama](https://www.w3.org/WAI/tutorials/images/) zahtijeva tekstualne alternative i potpune ekvivalente za informativne i složene vizualne prikaze\.
