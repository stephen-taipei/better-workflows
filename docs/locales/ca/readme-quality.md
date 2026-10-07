<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Pla de qualitat del README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · **Català** · [العربية](../ar/readme-quality.md)

[Resum en 41 versions localitzades i punts d’accés web oficials](../../../docs/LANGUAGES.md)\. La versió anglesa d\'aquest pla editorial continua sent la font canònica\.

Un README de Better Workflows és una pàgina d\'entrada\, no un manual de referència comprimit\. La seva funció és ajudar el lector a respondre cinc preguntes en aquest ordre\:

1. Què és això i és per a mi\?
2. Quin problema resol\?
3. Per què hauria de confiar en les seves afirmacions\?
4. Quin és el camí més curt cap a un primer èxit\?
5. On hauria d\'anar després\?

Aquest pla defineix el contracte narratiu\, visual\, de localització i de validació per a cada README del repositori\. La font llegible per màquina és [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Partiu de la decisió del lector

GitHub mostra un README abans de la major part del contingut del repositori\. Per tant\, la primera pantalla ha d\'establir la promesa del producte\, el públic destinatari i una acció següent amb límits definits\. No ha de començar amb l\'arquitectura interna\, una referència completa d\'ordres ni detalls de recuperació de versions publicades\.

Escriviu per a aquestes tasques dels lectors\:

- **Nou visitant\:** decideix ràpidament si Better Workflows resol un problema rellevant\.
- **Nou usuari\:** instal·la el connector i aconsegueix una ruta automàtica correcta\.
- **Avaluador\:** entén el límit d’autoritat i el comportament fail\-closed\.
- **Operador habitual\:** ves directament a una resposta sobre el flux de treball\, la seguretat\, l’arquitectura o la CLI\.
- **Col·laborador o traductor\:** troba el contracte canònic\, les ordres de desenvolupament\, el suport i la governança\.

## Feu servir una narrativa de causa i efecte

Els cinc README d\'entrada fan servir la mateixa seqüència semàntica de vuit parts\. Els títols poden ser idiomàtics en cada llengua\, però el recorregut del lector no canvia\.

| Secció | Pregunta del lector i funció narrativa |
| --- | --- |
| Promesa i públic | Què és Better Workflows\, per què existeix i a qui s\'adreça\? |
| Del problema al resultat | Què falla quan es confonen la intenció\, l\'autoritat\, les evidències i el resultat del proveïdor\? |
| Prova i límits | Quines garanties fan creïble el resultat proposat\? |
| Primer èxit | Quin és el camí complet més curt des de la instal·lació fins al resultat\? |
| Triar el camí següent | Quin flux de treball o document encaixa amb l\'objectiu del lector\? |
| Cicle de vida | Com arriba un objectiu a una finalització amb l\'estat conciliat\, o s\'atura de manera segura\? |
| Confiança i limitacions | Què no pot inferir\, autoritzar o afirmar mai el sistema\? |
| Aprendre\, obtenir ajuda i contribuir | On són la documentació aprofundida\, l\'assistència\, la governança\, el desenvolupament i la llicència\? |

Aquest ordre ofereix un recorregut pràctic\:

- **Context\:** el treball guiat per missatges d\'entrada al model pot expressar intenció sense demostrar autoritat ni estat\.
- **Tensió\:** els efectes laterals converteixen aquesta mancança en un risc per al lliurament\.
- **Resolució\:** Better Workflows vincula objectiu\, abast\, evidències\, revisió\, acció i conciliació amb el proveïdor\.
- **Prova\:** les garanties i els límits explícits mostren com funciona la resolució\.
- **Acció\:** el lector arriba a un primer èxit abans de trobar detalls profunds de la implementació\.
- **Continuació\:** les rutes basades en el rol i el resultat porten el lector al tutorial\, la guia pràctica\, l\'explicació o la referència adequats\.

## Separeu el contingut d\'entrada de la documentació aprofundida

Feu servir el README per a informació rellevant per a la decisió\. Orienteu l\'aprofundiment segons la finalitat\:

- [Primers passos](getting-started.md) és el tutorial del primer ús\.
- [Fluxos de treball](workflows.md) és la guia pràctica per triar el resultat\.
- [Arquitectura](architecture.md) explica el pla de control i els avantatges i inconvenients de les alternatives\.
- [Seguretat](security-guide.md) explica l\'autoritat\, la privadesa\, les atestacions i el comportament que bloqueja l\'execució si no hi ha una verificació vàlida\.
- [Referència de la CLI](cli-reference.md) és la referència d\'ordres\.
- Les pàgines localitzades `docs/details/*.md` conserven tots els detalls traduïts\.

No dupliqueu a la pàgina d\'entrada la recuperació de la memòria cau\, la titularitat dels bloquejos\, la semàntica completa del transport de comunicacions amb els proveïdors\, les llistes completes d\'ordres ni l\'historial de canvis de la implementació\. Una afirmació concisa de seguretat es manté a la mateixa pàgina\; el seu aprofundiment auditable pertany a la guia canònica\.

Aquesta separació segueix la distinció de Diátaxis entre tutorials\, guies pràctiques\, explicació i referència\. Una sola pàgina no pot optimitzar alhora les quatre necessitats del lector\.

## Feu que cada element visual es guanyi el seu lloc

Feu servir un element visual només quan les relacions\, la jerarquia o les transicions d\'estat siguin substancialment més fàcils d\'entendre que amb prosa\.

Les pàgines d\'entrada permeten dos elements visuals\:

1. **Arquitectura dels límits d\'autoritat\:** respon quines capes modelen la intenció\, els fets actuals\, l\'autoritat de les eines\, els reintents limitats i l\'estat de només lectura\.
2. **Cicle de vida de l\'objectiu a la finalització\:** respon on es comproven les evidències\, on s\'autoritzen els efectes laterals i on un estat desconegut atura el progrés\.

Cada element visual ha d\'incloure\:

- text alternatiu concís i significatiu\;
- un equivalent textual adjacent que conservi la conclusió quan l\'element visual estigui ocult o Mermaid no es renderitzi\;
- text real per a les etiquetes essencials sempre que sigui possible\;
- una pregunta estable del lector que justifiqui mantenir l\'element visual al dia\.

No afegiu captures de pantalla decoratives\, imatges carregades de text ni un diagrama que només dupliqui una llista curta\. Limiteu les taules de selecció a dues columnes concises perquè continuïn sent útils en pantalles estretes\.

## Preserveu el significat entre llengües

L\'anglès és la referència semàntica\, no un objectiu de nombre de línies\. El xinès tradicional\, el xinès simplificat\, el japonès i el coreà han de sonar naturals a un lector nadiu tot preservant el mateix contracte\.

Els elements següents han de continuar sent equivalents\:

- les vuit seccions semàntiques i el seu ordre\;
- les ordres del primer èxit i els identificadors del producte\;
- les cinc afirmacions sobre autoritat\, evidències\, estat desconegut\, missatges d\'entrada al model i privadesa\;
- les destinacions de fluxos de treball\, seguretat\, arquitectura\, CLI\, assistència\, governança\, desenvolupament i llicència\;
- la finalitat dels elements visuals\, les etapes del cicle de vida i les alternatives textuals\;
- la font de la versió i la política de distintius\.

Els títols\, els límits de les frases\, la puntuació\, els exemples i les crides a l\'acció poden ser idiomàtics\. Manteniu les ordres\, els selectors i els identificadors d\'evidències en la forma original\, i preserveu sempre el significat de les regles de seguretat\.

## Escriviu per facilitar la lectura ràpida i la traducció

- Comenceu pel resultat del lector i poseu els termes importants al principi dels títols i dels paràgrafs\.
- Feu servir la veu activa i identifiqueu l\'actor responsable d\'una acció\.
- Adreceu\-vos directament al lector en els procediments\.
- Manteniu els paràgrafs curts i doneu a cadascun una única funció\.
- Feu servir llistes numerades per a seqüències i vinyetes per a opcions sense ordre seqüencial\.
- Feu servir enllaços descriptius en lloc d\'etiquetes genèriques com «feu clic aquí»\.
- Manteniu els títols jeràrquics\, específics i paral·lels al mateix nivell\.
- Preferiu un llenguatge literal i inequívoc que conservi el significat en traduir\-lo\.
- Poseu les condicions abans de les instruccions i els resultats esperats després de les ordres\.

## Valideu la semàntica\, no la decoració

Les proves de documentació han de detectar més que títols coincidents\. Verifiquen\:

- un H1 i una jerarquia lògica d’encapçalaments\;
- marcadors de seccions semàntiques ordenades i d’afirmacions crítiques\;
- ordres exactes per a un primer èxit i identificadors estables\;
- enllaços relatius i destinacions de detalls específiques per a la configuració regional\;
- paritat de la insígnia de versió amb les metadades de temps d’execució\;
- text alternatiu d’imatge descriptiu i alternatives visuals adjacents\;
- un únic cicle de vida Mermaid amb un text equivalent complet\;
- taules de dues columnes i límits per a la llargada dels paràgrafs\;
- absència de detalls d’implementació profunds designats a les pàgines de destinació\;

## Base de recerca

- [GitHub\: Sobre el fitxer README del repositori](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) defineix la finalitat del README en una primera visita i recomana traslladar la documentació extensa a un altre lloc\.
- [Diátaxis](https://diataxis.fr/start-here/) separa les necessitats de tutorial\, guia pràctica\, explicació i referència\.
- [Microsoft\: Contingut de lectura ràpida](https://learn.microsoft.com/en-us/style-guide/scannable-content/) destaca una estructura que presenta primer allò més important\, paràgrafs curts i punts d\'entrada visuals coherents\.
- [Estil de documentació per a desenvolupadors de Google](https://developers.google.com/style/highlights) recomana veu activa\, tractament directe del lector\, títols descriptius\, accessibilitat i escriptura per a un públic global\.
- [GitHub\: Creació de diagrames](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) documenta la compatibilitat amb Mermaid en Markdown\.
- [W3C WAI\: Tutorial d\'imatges](https://www.w3.org/WAI/tutorials/images/) exigeix alternatives textuals i equivalents complets per a elements visuals informatius i complexos\.
