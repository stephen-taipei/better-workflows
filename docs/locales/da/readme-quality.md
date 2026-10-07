<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Kvalitetsplan for README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · **Dansk** · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Oversigt i 41 lokaliserede udgaver og officielle indgange på nettet](../../../docs/LANGUAGES.md)\. Den engelske udgave af denne redaktionelle plan er fortsat den kanoniske kilde\.

En README for Better Workflows er en indgangsside\, ikke en komprimeret referencehåndbog\. Den skal hjælpe læseren med at besvare fem spørgsmål i rækkefølge\:

1. Hvad er dette\, og er det noget for mig\?
2. Hvilket problem løser det\?
3. Hvorfor skal jeg stole på dets påstande\?
4. Hvad er den korteste vej til en første succes\?
5. Hvor skal jeg gå hen bagefter\?

Denne plan fastlægger kontrakten for fortælling\, visuelle elementer\, lokalisering og validering for hver README i kodelageret\. Den maskinlæsbare kilde er [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Tag udgangspunkt i læserens beslutning

GitHub viser en README før det meste af kodelagerets indhold\. Det første skærmbillede skal derfor tydeliggøre produktets løfte\, målgruppen og en afgrænset næste handling\. Det må ikke begynde med intern arkitektur\, en komplet kommandoreference eller detaljer om gendannelse af udgivelser\.

Skriv til disse læseropgaver\:

- **Ny besøgende\:** vurder hurtigt\, om Better Workflows løser et relevant problem\.
- **Ny bruger\:** installer pluginet og nå én vellykket automatisk rute\.
- **Evaluator\:** forstå myndighedsgrænsen og fail\-closed\-adfærden\.
- **Tilbagevendende operatør\:** spring direkte til svar om et workflow\, sikkerhed\, arkitektur eller CLI\.
- **Bidragsyder eller oversætter\:** find den kanoniske kontrakt\, udviklings\- kommandoer\, support og styring\.

## Brug en fortælling med årsag og virkning

De fem README\-indgangssider bruger den samme semantiske rækkefølge med otte dele\. Overskrifterne kan være idiomatiske på hvert sprog\, men læserens forløb ændrer sig ikke\.

| Afsnit | Læserens spørgsmål og rolle i fortællingen |
| --- | --- |
| Løfte og målgruppe | Hvad er Better Workflows\, hvorfor findes det\, og hvem er det til\? |
| Fra problem til resultat | Hvad går galt\, når hensigt\, beføjelser\, evidens og udbyderens resultat blandes sammen\? |
| Bevis og grænser | Hvilke garantier gør det foreslåede resultat troværdigt\? |
| Første succes | Hvad er den korteste komplette vej fra installation til resultat\? |
| Vælg næste vej | Hvilken arbejdsgang eller hvilket dokument passer til læserens mål\? |
| Livscyklus | Hvordan fører et mål til en afslutning med afstemt tilstand — eller til et sikkert stop\? |
| Tillid og begrænsninger | Hvad kan systemet aldrig udlede\, autorisere eller hævde\? |
| Lær\, få hjælp\, bidrag | Hvor findes den dybdegående dokumentation\, hjælp\, styring\, udvikling og licens\? |

Denne rækkefølge giver et praktisk fortælleforløb\:

- **Kontekst\:** promptstyret arbejde kan udtrykke hensigt uden at bevise beføjelser eller tilstand\.
- **Spænding\:** sideeffekter gør dette hul til en leverancerisiko\.
- **Løsning\:** Better Workflows forbinder mål\, omfang\, evidens\, gennemgang\, handling og afstemning med udbyderen\.
- **Bevis\:** udtrykkelige garantier og grænser viser\, hvordan løsningen fungerer\.
- **Handling\:** læseren når en første succes\, før vedkommende møder dybdegående implementeringsdetaljer\.
- **Fortsættelse\:** ruter baseret på rolle og resultat fører læseren til det rette læringsforløb\, den rette praktiske vejledning\, forklaring eller reference\.

## Adskil indgangsindhold fra dybdegående dokumentation

Brug README til information\, der er relevant for beslutningen\. Henvis til uddybning efter formål\:

- [Kom i gang](getting-started.md) er læringsforløbet til første brug\.
- [Arbejdsgange](workflows.md) er den praktiske vejledning til valg af resultat\.
- [Arkitektur](architecture.md) forklarer kontrolplanet og afvejningerne\.
- [Sikkerhed](security-guide.md) forklarer beføjelser\, privatliv\, attestationer og adfærd\, der blokerer udførelse uden gyldig verifikation\.
- [CLI\-reference](cli-reference.md) er kommandoreferencen\.
- Lokaliserede `docs/details/*.md`\-sider bevarer de fuldstændige oversatte detaljer\.

Gentag ikke cachegendannelse\, ejerskab af låse\, den fulde transportsemantik for udbydere\, udtømmende kommandolister eller historikken over implementeringsændringer på indgangssiden\. En kort sikkerhedspåstand bliver på selve siden\; dens efterprøvelige uddybning hører hjemme i den kanoniske vejledning\.

Denne opdeling følger Diátaxis\' skelnen mellem læringsforløb\, praktiske vejledninger\, forklaring og reference\. En enkelt side kan ikke optimere til alle fire læserbehov på én gang\.

## Lad hvert visuelt element gøre sig fortjent til sin plads

Brug kun et visuelt element\, når relationer\, hierarki eller tilstandsovergange bliver væsentligt lettere at forstå end gennem prosa\.

Indgangssiderne tillader to visuelle elementer\:

1. **Arkitektur for beføjelsesgrænser\:** besvarer\, hvilke lag der former hensigt\, aktuelle fakta\, værktøjernes beføjelser\, afgrænsede genforsøg og skrivebeskyttet tilstand\.
2. **Livscyklus fra mål til afslutning\:** besvarer\, hvor evidens kontrolleres\, hvor sideeffekter autoriseres\, og hvor ukendt tilstand stopper fremdriften\.

Hvert visuelt element skal omfatte\:

- kort\, meningsfuld alternativ tekst\;
- en tilsvarende tekst ved siden af\, som bevarer konklusionen\, når det visuelle element er skjult\, eller Mermaid ikke gengives\;
- rigtig tekst til væsentlige etiketter\, når det er muligt\;
- et vedvarende relevant læserspørgsmål\, som begrunder\, at det visuelle element holdes ajour\.

Tilføj ikke dekorative skærmbilleder\, teksttunge billeder eller et diagram\, der blot gentager en kort liste\. Begræns valgtabeller til to korte kolonner\, så de forbliver anvendelige på smalle skærme\.

## Bevar betydningen på tværs af sprog

Engelsk er den semantiske reference\, ikke et mål for antallet af linjer\. Traditionelt kinesisk\, forenklet kinesisk\, japansk og koreansk skal lyde naturligt for en modersmålslæsende person og samtidig bevare den samme kontrakt\.

Følgende elementer skal forblive ækvivalente\:

- de otte semantiske afsnit og deres rækkefølge\;
- kommandoerne til den første succes og produktidentifikatorerne\;
- de fem påstande om beføjelser\, evidens\, ukendt tilstand\, prompter og privatliv\;
- destinationerne for arbejdsgange\, sikkerhed\, arkitektur\, CLI\, hjælp\, styring\, udvikling og licens\;
- de visuelle elementers formål\, livscyklussens trin og tekstalternativerne\;
- versionskilden og politikken for mærker\.

Overskrifter\, sætningsgrænser\, tegnsætning\, eksempler og opfordringer til handling kan være idiomatiske\. Oversæt aldrig kommandoer\, selektorer\, evidensidentifikatorer eller sikkerhedssemantik\.

## Skriv til skimming og oversættelse

- Begynd med læserens resultat\, og placer vigtige begreber i starten af overskrifter og afsnit\.
- Brug aktiv form\, og navngiv den aktør\, der er ansvarlig for en handling\.
- Henvend dig direkte til læseren i procedurer\.
- Hold afsnit korte\, og giv hvert afsnit én opgave\.
- Brug nummererede lister til rækkefølge og punktopstillinger til valg uden bestemt rækkefølge\.
- Brug beskrivende links frem for generiske etiketter som “klik her”\.
- Hold overskrifter hierarkiske\, specifikke og parallelt opbygget på samme niveau\.
- Foretræk bogstaveligt\, entydigt sprog\, der bevarer betydningen ved oversættelse\.
- Placer betingelser før instruktioner og forventede resultater efter kommandoer\.

## Valider semantik\, ikke pynt

Dokumentationstestene skal registrere mere end matchende overskrifter\. De verificerer\:

- én H1 og et logisk overskriftshierarki\;
- ordnede markører for semantiske afsnit og kritiske påstande\;
- præcise first\-success\-kommandoer og stabile identifikatorer\;
- relative links og sprogspecifikke detaljedestinationer\;
- versionsbadge\-paritet med metadata fra kørselstidspunktet\;
- meningsfuld alternativ tekst til billeder og tilstødende visuelle alternativer\;
- én enkelt Mermaid\-livscyklus med en komplet tekstækvivalent\;
- budgetter for to\-kolonne\-tabeller og afsnitslængde\;
- fravær af udpegede dybe implementeringsdetaljer på landingssider\;

## Forskningsgrundlag

- [GitHub\: Om kodelagerets README\-fil](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) definerer README\-filens formål ved første besøg og anbefaler at flytte længere dokumentation andre steder hen\.
- [Diátaxis](https://diataxis.fr/start-here/) adskiller behovene for læringsforløb\, praktiske vejledninger\, forklaring og reference\.
- [Microsoft\: Indhold\, der er let at skimme](https://learn.microsoft.com/en-us/style-guide/scannable-content/) fremhæver en struktur med det vigtigste først\, korte afsnit og konsekvente visuelle indgangspunkter\.
- [Googles stil for udviklerdokumentation](https://developers.google.com/style/highlights) anbefaler aktiv form\, direkte tiltale\, beskrivende overskrifter\, tilgængelighed og skrivning til et globalt publikum\.
- [GitHub\: Oprettelse af diagrammer](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) dokumenterer understøttelse af Mermaid i Markdown\.
- [W3C WAI\: Læringsforløb om billeder](https://www.w3.org/WAI/tutorials/images/) kræver tekstalternativer og fuldstændige ækvivalenter til informative og komplekse visuelle elementer\.
