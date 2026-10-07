<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Kvalitetsplan for README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · **Norsk bokmål** · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Oversikt i 41 lokaliserte utgaver og offisielle innganger på nettet](../../../docs/LANGUAGES.md)\. Den engelske versjonen er fortsatt den autoritative teksten for denne redaksjonelle planen\.

En README for Better Workflows er en landingsside\, ikke en komprimert referansehåndbok\. Oppgaven er å hjelpe leseren med å besvare fem spørsmål i rekkefølge\:

1. Hva er dette\, og er det for meg\?
2. Hvilket problem løser det\?
3. Hvorfor bør jeg stole på påstandene\?
4. Hva er den korteste veien til et første vellykket resultat\?
5. Hvor bør jeg gå videre\?

Denne planen definerer kontrakten for fortelling\, visuelle elementer\, lokalisering og validering i hver README i kodelageret\. Den maskinlesbare kilden er [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Ta utgangspunkt i leserens beslutning

GitHub viser en README før det meste av innholdet i kodelageret\. Det første skjermbildet må derfor tydeliggjøre produktløftet\, målgruppen og en avgrenset neste handling\. Det må ikke begynne med intern arkitektur\, en fullstendig kommandoreferanse eller detaljer om gjenoppretting av utgivelser\.

Skriv for disse leseroppgavene\:

- **Ny besøkende\:** avgjør raskt om Better Workflows løser et relevant problem\.
- **Ny bruker\:** installer programtillegget og oppnå én vellykket automatisk rute\.
- **Evaluator\:** forstå autoritetsgrensen og fail\-closed\-atferden\.
- **Tilbakevendende operatør\:** gå direkte til svar om arbeidsflyt\, sikkerhet\, arkitektur eller CLI\.
- **Bidragsyter eller oversetter\:** finn den kanoniske kontrakten\, utviklingskommandoer\, brukerstøtte og styringsmodell\.

## Bruk en fortelling om årsak og virkning

De fem README\-landingssidene bruker den samme semantiske rekkefølgen med åtte deler\. Overskriftene kan være idiomatiske på hvert språk\, men leserreisen endres ikke\.

| Del | Leserens spørsmål og delens rolle i fortellingen |
| --- | --- |
| Løfte og målgruppe | Hva er Better Workflows\, hvorfor finnes det\, og hvem er det for\? |
| Fra problem til resultat | Hva går galt når hensikt\, fullmakt\, belegg og leverandørens resultat blandes sammen\? |
| Bevis og grenser | Hvilke garantier gjør det foreslåtte resultatet troverdig\? |
| Første vellykkede resultat | Hva er den korteste komplette veien fra installasjon til resultat\? |
| Velg neste vei | Hvilken arbeidsflyt eller hvilket dokument samsvarer med leserens mål\? |
| Livssyklus | Hvordan blir et mål til en avstemt fullføring\, eller stopper trygt\? |
| Tillit og begrensninger | Hva kan systemet aldri utlede\, autorisere eller hevde\? |
| Lær\, få hjelp\, bidra | Hvor finnes dybdedokumentasjon\, støtte\, styring\, utvikling og lisens\? |

Denne rekkefølgen gir en praktisk fortellingskurve\:

- **Kontekst\:** instruksjonsdrevet arbeid kan uttrykke hensikt uten å bevise fullmakt eller tilstand\.
- **Spenning\:** sideeffekter gjør dette gapet til en leveranserisiko\.
- **Løsning\:** Better Workflows knytter sammen mål\, omfang\, belegg\, gjennomgang\, handling og avstemming mot leverandøren\.
- **Bevis\:** uttrykkelige garantier og grenser viser hvordan løsningen fungerer\.
- **Handling\:** leseren oppnår et første vellykket resultat før hen møter dype implementasjonsdetaljer\.
- **Fortsettelse\:** rolle\- og resultatbaserte veier leder leseren til riktig opplæring\, fremgangsmåte\, forklaring eller referanse\.

## Skill landingsinnhold fra dybdedokumentasjon

Bruk README til beslutningsrelevant informasjon\. Led til detaljer etter formål\:

- [Kom i gang](getting-started.md) er opplæringen for første gangs bruk\.
- [Arbeidsflyter](workflows.md) er fremgangsmåten for valg av resultat\.
- [Arkitektur](architecture.md) forklarer kontrollplanet og avveiningene\.
- [Sikkerhet](security-guide.md) forklarer fullmakt\, personvern\, attestasjoner og at utføring avvises når verifisering mangler\.
- [CLI\-referanse](cli-reference.md) er kommandoreferansen\.
- Lokaliserte `docs/details/*.md`\-sider bevarer fullstendige oversatte detaljer\.

Ikke gjenta hurtigbuffergjenoppretting\, låseeierskap\, full transportsemantikk for leverandører\, uttømmende kommandooversikter eller implementasjonens endringshistorikk på landingssiden\. En kort sikkerhetspåstand blir stående på siden\; den etterprøvbare utdypingen hører hjemme i den autoritative veiledningen\.

Dette skillet følger Diátaxis\-inndelingen i opplæring\, fremgangsmåter\, forklaring og referanse\. Én side kan ikke optimaliseres for alle fire leserbehov samtidig\.

## La hvert visuelt element rettferdiggjøre plassen sin

Bruk et visuelt element bare når det gjør relasjoner\, hierarki eller tilstandsoverganger vesentlig enklere å forstå enn løpende tekst\.

Landingssidene tillater to visuelle elementer\:

1. **Arkitektur for fullmaktsgrenser\:** viser hvilke lag som former hensikt\, gjeldende fakta\, verktøyenes fullmakt\, avgrensede nye forsøk og skrivebeskyttet tilstand\.
2. **Livssyklus fra mål til fullføring\:** viser hvor belegg kontrolleres\, hvor sideeffekter autoriseres\, og hvor ukjent tilstand stopper fremdriften\.

Hvert visuelt element må inneholde\:

- kort og meningsfull alternativ tekst\;
- en tilstøtende tekstlig ekvivalent som bevarer konklusjonen når elementet er skjult eller Mermaid ikke gjengis\;
- ekte tekst for viktige etiketter når det er mulig\;
- et stabilt leserspørsmål som begrunner at elementet holdes oppdatert\.

Ikke legg til dekorative skjermbilder\, teksttunge bilder eller et diagram som bare gjentar en kort liste\. Begrens valgtabeller til to kortfattede kolonner\, slik at de fortsatt fungerer på smale skjermer\.

## Bevar betydningen på tvers av språk

Engelsk er den semantiske referansen\, ikke et mål for linjeantall\. Tradisjonell kinesisk\, forenklet kinesisk\, japansk og koreansk bør høres naturlig ut for morsmålsbrukere og samtidig bevare den samme kontrakten\.

Følgende elementer må forbli likeverdige\:

- de åtte semantiske delene og rekkefølgen deres\;
- kommandoer for første vellykkede resultat og produktidentifikatorer\;
- de fem påstandene om fullmakt\, belegg\, ukjent tilstand\, modellinstruksjoner og personvern\;
- målsidene for arbeidsflyt\, sikkerhet\, arkitektur\, CLI\, støtte\, styring\, utvikling og lisens\;
- formålet med visuelle elementer\, livssyklusstadier og tekstlige reserveløsninger\;
- versjonskilden og retningslinjene for merker\.

Overskrifter\, setningsgrenser\, tegnsetting\, eksempler og handlingsoppfordringer kan være idiomatiske\. Oversett aldri kommandoer\, selektorer\, identifikatorer for belegg eller sikkerhetssemantikk\.

## Skriv for skumlesing og oversettelse

- Begynn med leserens resultat\, og plasser viktige begreper i starten av overskrifter og avsnitt\.
- Bruk aktiv form\, og navngi aktøren som er ansvarlig for handlingen\.
- Henvend deg direkte til leseren i prosedyrer\.
- Hold avsnittene korte\, og gi hvert avsnitt én oppgave\.
- Bruk nummererte lister for rekkefølge og punktlister for valg uten fast rekkefølge\.
- Bruk beskrivende lenker fremfor generelle etiketter som «klikk her»\.
- Hold overskriftene hierarkiske\, konkrete og parallelle på samme nivå\.
- Foretrekk bokstavelig\, entydig språk som bevarer betydningen ved oversettelse\.
- Plasser betingelser før instruksjoner og forventede resultater etter kommandoer\.

## Valider semantikk\, ikke dekorasjon

Dokumentasjonstestene må oppdage mer enn samsvarende overskrifter\. De kontrollerer\:

- én H1 og et logisk overskriftshierarki\;
- ordnede semantiske seksjons\- og kritiske påstandsmarkører\;
- nøyaktige første\-suksess\-kommandoer og stabile identifikatorer\;
- relative lenker og språkspesifikke detaljdestinasjoner\;
- versjonsmerke\-paritet med metadata fra kjøretid\;
- meningsfull alt\-tekst for bilder og tilhørende visuelle reservealternativer\;
- én enkelt Mermaid\-livssyklus med en fullstendig teksekvivalent\;
- budsjetter for to\-kolonners tabeller og avsnittslengder\;
- fravær av utpekte dype implementasjonsdetaljer på landingssider\;

## Forskningsgrunnlag

- [GitHub\: Om README\-filen i kodelageret](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) definerer formålet med README ved første besøk og anbefaler å flytte omfattende dokumentasjon til et annet sted\.
- [Diátaxis](https://diataxis.fr/start-here/) skiller mellom behov for opplæring\, fremgangsmåter\, forklaring og referanse\.
- [Microsoft\: Innhold som kan skumleses](https://learn.microsoft.com/en-us/style-guide/scannable-content/) fremhever struktur med det viktigste først\, korte avsnitt og konsekvente visuelle inngangspunkter\.
- [Googles stilveiledning for utviklerdokumentasjon](https://developers.google.com/style/highlights) anbefaler aktiv form\, direkte tiltale\, beskrivende overskrifter\, tilgjengelighet og skriving for et globalt publikum\.
- [GitHub\: Lage diagrammer](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) dokumenterer støtte for Mermaid i Markdown\.
- [W3C WAI\: Opplæring om bilder](https://www.w3.org/WAI/tutorials/images/) krever tekstalternativer og fullstendige ekvivalenter for informative og komplekse visuelle elementer\.
