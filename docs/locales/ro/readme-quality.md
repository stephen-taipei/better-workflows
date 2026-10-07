<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Plan de calitate pentru README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · **Română** · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Prezentare generală în 41 de versiuni localizate și puncte oficiale de acces web](../../../docs/LANGUAGES.md)\. Versiunea în engleză a acestui plan editorial rămâne sursa canonică\.

Un README Better Workflows este o pagină de intrare\, nu un manual de referință comprimat\. Rolul său este să ajute cititorul să răspundă\, în ordine\, la cinci întrebări\:

1. Ce este și mi se potrivește\?
2. Ce problemă rezolvă\?
3. De ce ar trebui să am încredere în afirmațiile sale\?
4. Care este cea mai scurtă cale către un prim succes\?
5. Unde ar trebui să continui\?

Acest plan definește contractul narativ\, vizual\, de localizare și de validare pentru fiecare README din depozit\. Sursa prelucrabilă automat este [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Porniți de la decizia cititorului

GitHub afișează un README înaintea majorității conținutului depozitului\. Prin urmare\, primul ecran trebuie să stabilească promisiunea produsului\, publicul vizat și o acțiune următoare cu limite clare\. Nu trebuie să înceapă cu arhitectura internă\, o referință completă a comenzilor sau detalii despre recuperarea lansărilor\.

Scrieți pentru următoarele sarcini ale cititorilor\:

- **Vizitator nou\:** decide rapid dacă Better Workflows rezolvă o problemă relevantă\.
- **Utilizator nou\:** instalează pluginul și parcurge o rută automată finalizată cu succes\.
- **Evaluator\:** înțelege limita de autoritate și comportamentul fail\-closed\.
- **Operator existent\:** accesează direct un răspuns despre fluxul de lucru\, securitate\, arhitectură sau CLI\.
- **Contribuitor sau traducător\:** găsește contractul canonic\, comenzile de dezvoltare\, suportul și guvernanța\.

## Folosiți o narațiune de tip cauză–efect

Cele cinci fișiere README de intrare folosesc aceeași succesiune semantică în opt părți\. Titlurile pot fi firești în fiecare limbă\, dar parcursul cititorului nu se schimbă\.

| Secțiune | Întrebarea cititorului și rolul narativ |
| --- | --- |
| Promisiune și public | Ce este Better Workflows\, de ce există și cui i se adresează\? |
| De la problemă la rezultat | Ce merge prost când intenția\, autoritatea\, dovezile și rezultatul furnizorului sunt confundate\? |
| Susținere și limite | Ce garanții fac credibil rezultatul propus\? |
| Primul succes | Care este cea mai scurtă cale completă de la instalare la rezultat\? |
| Alegerea căii următoare | Ce flux de lucru sau document corespunde obiectivului cititorului\? |
| Ciclu de viață | Cum devine un obiectiv o finalizare cu rezultate reconciliate — sau cum se oprește în siguranță\? |
| Încredere și limitări | Ce nu poate sistemul niciodată să deducă\, să autorizeze sau să afirme\? |
| Învățare\, ajutor\, contribuții | Unde se găsesc documentația aprofundată\, asistența\, guvernanța\, dezvoltarea și licența\? |

Această ordine oferă un arc narativ practic\:

- **Context\:** munca ghidată de instrucțiuni pentru modele poate exprima intenția fără a dovedi autoritatea sau starea\.
- **Tensiune\:** efectele secundare transformă această lacună într\-un risc de livrare\.
- **Rezolvare\:** Better Workflows leagă obiectivul\, domeniul de aplicare\, dovezile\, revizuirea\, acțiunea și reconcilierea cu rezultatul furnizorului\.
- **Susținere\:** garanțiile și limitele explicite arată cum funcționează rezolvarea\.
- **Acțiune\:** cititorul ajunge la un prim succes înainte de a întâlni detalii aprofundate de implementare\.
- **Continuare\:** rutele bazate pe rol și rezultat duc cititorul la tutorialul\, ghidul practic\, explicația sau referința potrivită\.

## Separați conținutul de intrare de documentația aprofundată

Folosiți README pentru informațiile relevante deciziei\. Direcționați către detalii în funcție de scop\:

- [Primii pași](getting-started.md) este tutorialul pentru prima utilizare\.
- [Fluxuri de lucru](workflows.md) este ghidul practic pentru alegerea rezultatului\.
- [Arhitectură](architecture.md) explică planul de control și compromisurile\.
- [Securitate](security-guide.md) explică autoritatea\, viața privată\, atestările și comportamentul care blochează acțiunile în lipsa verificării\.
- [Referință CLI](cli-reference.md) este referința comenzilor\.
- Paginile localizate `docs/details/*.md` păstrează integral detaliile traduse\.

Nu duplicați pe pagina de intrare recuperarea memoriei cache\, proprietatea asupra blocărilor\, semantica integrală a transportului către furnizori\, lista exhaustivă a comenzilor sau istoricul modificărilor implementării\. O afirmație concisă privind siguranța rămâne pe pagină\; detaliile sale auditabile aparțin ghidului canonic\.

Această separare urmează distincția Diátaxis dintre tutoriale\, ghiduri practice\, explicații și referințe\. O singură pagină nu poate fi optimizată pentru toate cele patru nevoi ale cititorului în același timp\.

## Justificați locul fiecărui element vizual

Folosiți un element vizual numai când acesta face relațiile\, ierarhia sau tranzițiile de stare substanțial mai ușor de înțeles decât textul\.

Paginile de intrare permit două elemente vizuale\:

1. **Arhitectura limitelor de autoritate\:** arată ce straturi modelează intenția\, faptele curente\, autoritatea instrumentelor\, reîncercările limitate și starea disponibilă doar pentru citire\.
2. **Ciclul de viață de la obiectiv la finalizare\:** arată unde sunt verificate dovezile\, unde sunt autorizate efectele secundare și unde starea necunoscută oprește progresul\.

Fiecare element vizual trebuie să includă\:

- text alternativ concis și semnificativ\;
- un echivalent textual alăturat care păstrează concluzia când elementul vizual este ascuns sau Mermaid nu se afișează\;
- text propriu\-zis pentru etichetele esențiale\, ori de câte ori este posibil\;
- o întrebare stabilă a cititorului care justifică menținerea elementului vizual la zi\.

Nu adăugați capturi de ecran decorative\, imagini încărcate de text sau o diagramă care doar dublează o listă scurtă\. Limitați tabelele de selecție la două coloane concise\, pentru ca acestea să rămână utilizabile pe ecrane înguste\.

## Păstrați sensul între limbi

Engleza este referința semantică\, nu o țintă pentru numărul de rânduri\. Chineza tradițională\, chineza simplificată\, japoneza și coreeana trebuie să sune natural pentru un cititor nativ\, păstrând același contract\.

Următoarele elemente trebuie să rămână echivalente\:

- cele opt secțiuni semantice și ordinea lor\;
- comenzile pentru primul succes și identificatorii produselor\;
- cele cinci afirmații despre autoritate\, dovezi\, stare necunoscută\, instrucțiuni pentru modele și viață privată\;
- destinațiile pentru fluxuri de lucru\, securitate\, arhitectură\, CLI\, asistență\, guvernanță\, dezvoltare și licență\;
- scopul elementelor vizuale\, etapele ciclului de viață și alternativele textuale\;
- sursa versiunii și politica privind insignele\.

Titlurile\, delimitarea propozițiilor\, punctuația\, exemplele și îndemnurile la acțiune pot fi adaptate firesc limbii\. Nu traduceți niciodată comenzile\, selectoarele\, identificatorii dovezilor sau semantica de securitate\.

## Scrieți pentru parcurgere rapidă și traducere

- Începeți cu rezultatul cititorului și puneți termenii importanți la începutul titlurilor și al paragrafelor\.
- Folosiți diateza activă și numiți actorul responsabil pentru o acțiune\.
- Adresați\-vă direct cititorului în proceduri\.
- Păstrați paragrafele scurte și atribuiți fiecăruia un singur rol\.
- Folosiți liste numerotate pentru succesiuni și liste cu marcatori pentru opțiuni fără ordine secvențială\.
- Folosiți linkuri descriptive în locul etichetelor generice precum „faceți clic aici”\.
- Păstrați titlurile ierarhice\, concrete și paralele ca formulare la același nivel\.
- Preferați un limbaj literal\, fără ambiguități\, care își păstrează sensul la traducere\.
- Puneți condițiile înaintea instrucțiunilor și rezultatele așteptate după comenzi\.

## Validați semantica\, nu decorul

Testele documentației trebuie să detecteze mai mult decât potrivirea titlurilor\. Ele verifică\:

- un singur H1 și o ierarhie logică a titlurilor\;
- secțiuni semantice ordonate și marcaje pentru afirmații critice\;
- comenzi exacte pentru primul succes și identificatori stabili\;
- linkuri relative și destinații detaliate specifice fiecărei limbi\;
- paritate între etichetele de versiune și metadatele de runtime\;
- text alternativ semnificativ pentru imagini și soluții vizuale de rezervă adiacente\;
- un singur ciclu de viață Mermaid cu un echivalent textual complet\;
- bugete de lungime pentru tabele cu două coloane și paragrafe\;
- absența detaliilor avansate de implementare pe paginile de destinație\;

## Baza de cercetare

- [GitHub\: Despre fișierul README al depozitului](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) definește scopul README la prima vizită și recomandă mutarea documentației ample în altă parte\.
- [Diátaxis](https://diataxis.fr/start-here/) separă nevoile de tutoriale\, ghiduri practice\, explicații și referințe\.
- [Microsoft\: Conținut ușor de parcurs rapid](https://learn.microsoft.com/en-us/style-guide/scannable-content/) subliniază structura cu lucrurile importante la început\, paragrafele scurte și punctele de intrare vizuale consecvente\.
- [Stilul documentației Google pentru dezvoltatori](https://developers.google.com/style/highlights) recomandă diateza activă\, adresarea directă\, titlurile descriptive\, accesibilitatea și redactarea pentru un public global\.
- [GitHub\: Crearea diagramelor](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) documentează suportul pentru Mermaid în Markdown\.
- [W3C WAI\: Tutorial despre imagini](https://www.w3.org/WAI/tutorials/images/) impune alternative textuale și echivalente complete pentru elementele vizuale informative și complexe\.
