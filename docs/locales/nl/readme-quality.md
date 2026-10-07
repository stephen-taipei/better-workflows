<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Blauwdruk voor README\-kwaliteit

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · **Nederlands** · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Overzicht in 41 gelokaliseerde versies en officiële toegangspunten op het web](../../../docs/LANGUAGES.md)\. De Engelse versie van deze redactionele blauwdruk blijft de canonieke bron\.

Een README van Better Workflows is een landingspagina\, geen samengeperste referentiehandleiding\. De pagina moet een lezer helpen om vijf vragen in deze volgorde te beantwoorden\:

1. Wat is dit en is het iets voor mij\?
2. Welk probleem lost het op\?
3. Waarom zou ik de beweringen vertrouwen\?
4. Wat is de kortste weg naar een eerste succes\?
5. Waar moet ik vervolgens naartoe\?

Deze blauwdruk definieert het contract voor het verhaal\, de visuele elementen\, de lokalisatie en de validatie van elke README in de repository\. De machineleesbare bron is [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Begin bij de beslissing van de lezer

GitHub toont een README voordat de meeste andere repository\-inhoud in beeld komt\. Het eerste scherm moet daarom de productbelofte\, de doelgroep en een begrensde volgende actie duidelijk maken\. Het mag niet beginnen met de interne architectuur\, een volledige opdrachtenreferentie of details over het herstellen van releases\.

Schrijf voor deze taken van lezers\:

- **Nieuwe bezoeker\:** snel bepalen of Better Workflows een relevant probleem oplost\.
- **Nieuwe gebruiker\:** de plugin installeren en één succesvolle automatische route bereiken\.
- **Beoordelaar\:** de autoriteitsgrens en het fail\-closed\-gedrag begrijpen\.
- **Terugkerende beheerder\:** snel navigeren naar een antwoord over workflows\, beveiliging\, architectuur of de CLI\.
- **Bijdrager of vertaler\:** het canonieke contract\, ontwikkelingsopdrachten\, ondersteuning en governance vinden\.

## Gebruik een verhaal van oorzaak en gevolg

De vijf README\-landingspagina\'s gebruiken dezelfde semantische volgorde van acht onderdelen\. Koppen mogen in elke taal natuurlijk zijn geformuleerd\, maar het traject van de lezer verandert niet\.

| Onderdeel | Vraag van de lezer en rol in het verhaal |
| --- | --- |
| Belofte en doelgroep | Wat is Better Workflows\, waarom bestaat het en voor wie is het bedoeld\? |
| Van probleem naar resultaat | Wat gaat er mis wanneer intentie\, bevoegdheid\, bewijs en de uitkomst bij de aanbieder op één hoop worden gegooid\? |
| Bewijs en grenzen | Welke garanties maken de voorgestelde uitkomst geloofwaardig\? |
| Eerste succes | Wat is de kortste volledige route van installatie naar resultaat\? |
| Kies de volgende route | Welke workflow of welk document past bij het doel van de lezer\? |
| Levenscyclus | Hoe leidt een doel tot een voltooiing waarvan de toestand is afgestemd — of tot veilig stoppen\? |
| Vertrouwen en beperkingen | Wat kan het systeem nooit afleiden\, autoriseren of beweren\? |
| Leren\, hulp krijgen en bijdragen | Waar staan de diepgaande documentatie\, ondersteuning\, het projectbestuur\, de ontwikkelinformatie en de licentie\? |

Deze volgorde zorgt voor een praktische verhaallijn\:

- **Context\:** promptgestuurd werk kan intentie uitdrukken zonder bevoegdheid of toestand aan te tonen\.
- **Spanning\:** neveneffecten maken van die kloof een risico voor de oplevering\.
- **Oplossing\:** Better Workflows verbindt doel\, reikwijdte\, bewijs\, beoordeling\, actie en afstemming van de toestand met de aanbieder\.
- **Bewijs\:** expliciete garanties en grenzen laten zien hoe de oplossing werkt\.
- **Actie\:** de lezer bereikt een eerste succes voordat diepgaande implementatiedetails aan bod komen\.
- **Vervolg\:** routes op basis van rol en uitkomst leiden de lezer naar de juiste tutorial\, praktische handleiding\, uitleg of referentie\.

## Scheid landingsinhoud van diepgaande documentatie

Gebruik de README voor informatie die relevant is voor beslissingen\. Verwijs naar verdieping op basis van het doel\:

- [Aan de slag](getting-started.md) is de tutorial voor het eerste gebruik\.
- [Workflows](workflows.md) is de praktische handleiding voor het kiezen van een uitkomst\.
- [Architectuur](architecture.md) legt de besturingslaag en de afwegingen uit\.
- [Beveiliging](security-guide.md) legt bevoegdheid\, privacy\, attestaties en het gedrag dat uitvoering blokkeert zolang geldige verificatie ontbreekt uit\.
- [CLI\-referentie](cli-reference.md) is de opdrachtenreferentie\.
- Gelokaliseerde pagina\'s in `docs/details/*.md` behouden de volledige vertaalde details\.

Dupliceer op de landingspagina geen cacheherstel\, eigenaarschap van vergrendelingen\, volledige transportsemantiek voor aanbieders\, uitputtende opdrachtenlijsten of de wijzigingsgeschiedenis van de implementatie\. Een beknopte veiligheidsbewering blijft op de pagina zelf\; de controleerbare verdieping hoort in de canonieke gids\.

Deze scheiding volgt het onderscheid van Diátaxis tussen tutorials\, praktische handleidingen\, uitleg en referentie\. Eén pagina kan niet tegelijkertijd optimaal voorzien in alle vier deze behoeften van lezers\.

## Laat elk visueel element zijn plaats verdienen

Gebruik een visueel element alleen wanneer relaties\, hiërarchie of toestandsovergangen daardoor aanzienlijk eenvoudiger te begrijpen zijn dan met tekst\.

De landingspagina\'s staan twee visuele elementen toe\:

1. **Architectuur van bevoegdheidsgrenzen\:** beantwoordt welke lagen de intentie\, actuele feiten\, gereedschapsbevoegdheden\, begrensde herhaalpogingen en alleen\-lezen toestand vormgeven\.
2. **Levenscyclus van doel tot voltooiing\:** beantwoordt waar bewijs wordt gecontroleerd\, waar neveneffecten worden geautoriseerd en waar een onbekende toestand de voortgang stopt\.

Elk visueel element moet het volgende bevatten\:

- beknopte\, betekenisvolle alternatieve tekst\;
- een aangrenzend tekstueel equivalent dat de conclusie behoudt wanneer het visuele element verborgen is of Mermaid niet wordt weergegeven\;
- waar mogelijk echte tekst voor essentiële labels\;
- een blijvende lezersvraag die rechtvaardigt dat het visuele element actueel wordt gehouden\.

Voeg geen decoratieve schermafbeeldingen\, afbeeldingen met veel tekst of diagrammen toe die alleen een korte lijst dupliceren\. Beperk keuzetabellen tot twee beknopte kolommen\, zodat ze bruikbaar blijven op smalle schermen\.

## Behoud de betekenis tussen talen

Engels is de semantische referentie\, geen doel voor het aantal regels\. Traditioneel Chinees\, vereenvoudigd Chinees\, Japans en Koreaans moeten natuurlijk klinken voor een moedertaalspreker\, terwijl hetzelfde contract behouden blijft\.

De volgende onderdelen moeten gelijkwaardig blijven\:

- de acht semantische onderdelen en hun volgorde\;
- de opdrachten voor het eerste succes en de productidentificatoren\;
- de vijf beweringen over bevoegdheid\, bewijs\, onbekende toestand\, prompts en privacy\;
- de bestemmingen voor workflows\, beveiliging\, architectuur\, CLI\, ondersteuning\, projectbestuur\, ontwikkeling en licentie\;
- het doel van visuele elementen\, de levenscyclusfasen en de tekstuele alternatieven\;
- de versiebron en het badgebeleid\.

Koppen\, zinsgrenzen\, interpunctie\, voorbeelden en oproepen tot actie mogen idiomatisch zijn\. Vertaal nooit opdrachten\, selectors\, bewijsidentificatoren of beveiligingssemantiek\.

## Schrijf voor snel doorlezen en vertalen

- Begin met de uitkomst voor de lezer en zet belangrijke termen aan het begin van koppen en alinea\'s\.
- Gebruik de actieve vorm en benoem wie verantwoordelijk is voor een handeling\.
- Spreek de lezer rechtstreeks aan bij procedures\.
- Houd alinea\'s kort en geef elke alinea één taak\.
- Gebruik genummerde lijsten voor volgorde en opsommingstekens voor keuzes zonder vaste volgorde\.
- Gebruik beschrijvende links in plaats van algemene labels zoals “klik hier”\.
- Houd koppen hiërarchisch\, specifiek en parallel opgebouwd op hetzelfde niveau\.
- Geef de voorkeur aan letterlijke\, ondubbelzinnige taal die haar betekenis bij vertaling behoudt\.
- Zet voorwaarden vóór instructies en verwachte uitkomsten na opdrachten\.

## Valideer semantiek\, geen versiering

De documentatietests moeten meer detecteren dan overeenkomende koppen\. Ze controleren\:

- één H1 en een logische kophiërarchie\;
- geordende semantische sectie\- en kritieke\-claimmarkeringen\;
- exacte opdrachten voor direct succes en stabiele identifiers\;
- relatieve links en taalspecifieke detailbestemmingen\;
- gelijkheid van versiebadges met runtime\-metadata\;
- betekenisvolle alternatieve tekst voor afbeeldingen en aansluitende visuele fallbacks\;
- één enkele Mermaid\-levenscyclus met een volledig tekstueel equivalent\;
- budgetten voor tweekolomstabellen en alinealengtes\;
- afwezigheid van aangewezen diepgaande implementatiedetails op landingspagina\'s\;

## Onderzoeksbasis

- [GitHub\: Over het README\-bestand van de repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) definieert het doel van de README bij een eerste bezoek en raadt aan uitgebreide documentatie elders onder te brengen\.
- [Diátaxis](https://diataxis.fr/start-here/) onderscheidt behoeften aan tutorials\, praktische handleidingen\, uitleg en referentie\.
- [Microsoft\: Snel te doorlezen inhoud](https://learn.microsoft.com/en-us/style-guide/scannable-content/) benadrukt een opbouw met het belangrijkste eerst\, korte alinea\'s en consistente visuele instappunten\.
- [Documentatiestijl voor ontwikkelaars van Google](https://developers.google.com/style/highlights) raadt de actieve vorm\, rechtstreeks aanspreken\, beschrijvende koppen\, toegankelijkheid en schrijven voor een wereldwijd publiek aan\.
- [GitHub\: Diagrammen maken](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) documenteert ondersteuning voor Mermaid in Markdown\.
- [W3C WAI\: Tutorial over afbeeldingen](https://www.w3.org/WAI/tutorials/images/) vereist tekstuele alternatieven en volledige equivalenten voor informatieve en complexe visuele elementen\.
