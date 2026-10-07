<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Piano di qualità per i README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · **Italiano** · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Panoramica in 41 versioni localizzate e punti di accesso web ufficiali](../../../docs/LANGUAGES.md)\. La versione inglese di questo piano editoriale rimane la fonte canonica\.

Un README di Better Workflows è una pagina di presentazione\, non un manuale di riferimento compresso\. Il suo compito è aiutare il lettore a rispondere\, nell\'ordine\, a cinque domande\:

1. Che cos\'è e fa per me\?
2. Quale problema risolve\?
3. Perché dovrei fidarmi delle sue affermazioni\?
4. Qual è il percorso più breve per ottenere un primo successo\?
5. Dove dovrei proseguire\?

Questo piano definisce il contratto narrativo\, visivo\, di localizzazione e di validazione per ogni README del repository\. La fonte leggibile automaticamente è [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Parti dalla decisione del lettore

GitHub mostra un README prima della maggior parte dei contenuti del repository\. La prima schermata deve quindi chiarire la promessa del prodotto\, il pubblico previsto e un\'azione successiva con limiti definiti\. Non deve iniziare con l\'architettura interna\, un riferimento completo dei comandi o dettagli sul ripristino dei rilasci\.

Scrivi per queste esigenze dei lettori\:

- **Nuovo visitatore\:** stabilisci rapidamente se Better Workflows risolve un problema rilevante\.
- **Nuovo utente\:** installa il plugin e completa un percorso automatico con successo\.
- **Valutatore\:** comprendi il confine di autorità e il comportamento fail\-closed\.
- **Operatore abituale\:** passa direttamente a una risposta su workflow\, sicurezza\, architettura o CLI\.
- **Collaboratore o traduttore\:** trova il contratto canonico\, i comandi di sviluppo\, il supporto e la governance\.

## Usa una narrazione basata su causa ed effetto

I cinque README di presentazione usano la stessa sequenza semantica in otto parti\. I titoli possono essere idiomatici in ogni lingua\, ma il percorso del lettore non cambia\.

| Sezione | Domanda del lettore e ruolo narrativo |
| --- | --- |
| Promessa e pubblico | Che cos\'è Better Workflows\, perché esiste e a chi si rivolge\? |
| Dal problema al risultato | Che cosa va storto quando si confondono intento\, autorità\, evidenze e risultato del fornitore\? |
| Prove e confini | Quali garanzie rendono credibile il risultato proposto\? |
| Primo successo | Qual è il percorso completo più breve dall\'installazione al risultato\? |
| Scegliere il percorso successivo | Quale flusso di lavoro o documento corrisponde all\'obiettivo del lettore\? |
| Ciclo di vita | Come si trasforma un obiettivo in un completamento con esiti riconciliati\, oppure come si arresta in sicurezza\? |
| Fiducia e limiti | Che cosa il sistema non può mai dedurre\, autorizzare o affermare\? |
| Imparare\, ricevere aiuto\, contribuire | Dove si trovano documentazione approfondita\, assistenza\, governance\, sviluppo e licenza\? |

Questo ordine offre un arco narrativo concreto\:

- **Contesto\:** il lavoro guidato da istruzioni per i modelli può esprimere un intento senza dimostrare autorità o stato\.
- **Tensione\:** gli effetti collaterali trasformano questa lacuna in un rischio per la consegna del risultato\.
- **Risoluzione\:** Better Workflows lega obiettivo\, ambito\, evidenze\, revisione\, azione e riconciliazione con il risultato del fornitore\.
- **Prova\:** garanzie e confini espliciti mostrano come funziona la risoluzione\.
- **Azione\:** il lettore raggiunge un primo successo prima di incontrare dettagli approfonditi dell\'implementazione\.
- **Proseguimento\:** percorsi basati su ruolo e risultato conducono il lettore al tutorial\, alla guida pratica\, alla spiegazione o al riferimento appropriato\.

## Separa i contenuti di presentazione dalla documentazione approfondita

Usa il README per le informazioni rilevanti ai fini della decisione\. Indirizza agli approfondimenti in base allo scopo\:

- [Primi passi](getting-started.md) è il tutorial per il primo utilizzo\.
- [Flussi di lavoro](workflows.md) è la guida pratica per scegliere il risultato\.
- [Architettura](architecture.md) spiega il piano di controllo e i compromessi\.
- [Sicurezza](security-guide.md) spiega autorità\, tutela della vita privata\, attestazioni e comportamento che blocca le azioni in assenza di verifica\.
- [Riferimento CLI](cli-reference.md) è il riferimento dei comandi\.
- Le pagine localizzate `docs/details/*.md` conservano integralmente i dettagli tradotti\.

Non duplicare nella pagina di presentazione il ripristino della cache\, la titolarità dei blocchi\, la semantica completa del trasporto verso i fornitori\, l\'elenco esaustivo dei comandi o la cronologia delle modifiche all\'implementazione\. Un\'affermazione concisa sulla sicurezza rimane nella pagina\; i suoi approfondimenti verificabili appartengono alla guida canonica\.

Questa separazione segue la distinzione di Diátaxis tra tutorial\, guide pratiche\, spiegazioni e riferimenti\. Una singola pagina non può essere ottimizzata per tutte e quattro le esigenze del lettore contemporaneamente\.

## Giustifica il posto di ogni elemento visivo

Usa un elemento visivo solo quando rende relazioni\, gerarchie o transizioni di stato sostanzialmente più facili da comprendere rispetto al testo\.

Le pagine di presentazione consentono due elementi visivi\:

1. **Architettura dei confini di autorità\:** chiarisce quali livelli definiscono intento\, fatti attuali\, autorità degli strumenti\, tentativi ripetuti limitati e stato di sola lettura\.
2. **Ciclo di vita dall\'obiettivo al completamento\:** chiarisce dove si controllano le evidenze\, dove si autorizzano gli effetti collaterali e dove uno stato sconosciuto arresta l\'avanzamento\.

Ogni elemento visivo deve includere\:

- un testo alternativo conciso e significativo\;
- un equivalente testuale adiacente che conservi la conclusione quando l\'elemento visivo è nascosto o Mermaid non viene visualizzato\;
- testo effettivo per le etichette essenziali\, ove possibile\;
- una domanda stabile del lettore che giustifichi il mantenimento dell\'elemento visivo aggiornato\.

Non aggiungere schermate decorative\, immagini cariche di testo o un diagramma che si limiti a duplicare un breve elenco\. Limita le tabelle di selezione a due colonne concise\, affinché rimangano utilizzabili su schermi stretti\.

## Preserva il significato tra le lingue

L\'inglese è il riferimento semantico\, non un obiettivo per il numero di righe\. Il cinese tradizionale\, il cinese semplificato\, il giapponese e il coreano devono risultare naturali a un lettore madrelingua\, preservando lo stesso contratto\.

I seguenti elementi devono rimanere equivalenti\:

- le otto sezioni semantiche e il loro ordine\;
- i comandi per il primo successo e gli identificatori dei prodotti\;
- le cinque affermazioni su autorità\, evidenze\, stato sconosciuto\, istruzioni per i modelli e tutela della vita privata\;
- le destinazioni per flussi di lavoro\, sicurezza\, architettura\, CLI\, assistenza\, governance\, sviluppo e licenza\;
- lo scopo degli elementi visivi\, le fasi del ciclo di vita e le alternative testuali\;
- la fonte della versione e la politica sui contrassegni\.

Titoli\, confini delle frasi\, punteggiatura\, esempi e inviti all\'azione possono essere idiomatici\. Non tradurre mai comandi\, selettori\, identificatori delle evidenze o semantica di sicurezza\.

## Scrivi per la lettura rapida e la traduzione

- Parti dal risultato del lettore e colloca i termini importanti all\'inizio di titoli e paragrafi\.
- Usa la forma attiva e indica il soggetto responsabile di un\'azione\.
- Rivolgiti direttamente al lettore nelle procedure\.
- Mantieni i paragrafi brevi e assegna a ciascuno un solo compito\.
- Usa elenchi numerati per le sequenze e punti elenco per le scelte senza ordine\.
- Usa link descrittivi anziché etichette generiche come “fai clic qui”\.
- Mantieni i titoli gerarchici\, specifici e paralleli nella formulazione allo stesso livello\.
- Preferisci un linguaggio letterale e privo di ambiguità che conservi il significato nella traduzione\.
- Metti le condizioni prima delle istruzioni e i risultati attesi dopo i comandi\.

## Valida la semantica\, non la decorazione

I test della documentazione devono rilevare più della corrispondenza dei titoli\. Verificano\:

- un H1 e una gerarchia logica delle intestazioni\;
- marcatori ordinati per sezioni semantiche e affermazioni critiche\;
- comandi esatti per il primo successo e identificatori stabili\;
- link relativi e destinazioni dei dettagli specifiche per le impostazioni locali\;
- parità del badge di versione con i metadati di runtime\;
- testo alternativo significativo per le immagini e fallback visivi adiacenti\;
- un unico ciclo di vita Mermaid con un equivalente testuale completo\;
- budget per tabelle a due colonne e lunghezza dei paragrafi\;
- assenza dalle landing page di dettagli implementativi approfonditi designati\;

## Basi della ricerca

- [GitHub\: Informazioni sul file README del repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) definisce lo scopo del README alla prima visita e raccomanda di spostare altrove la documentazione estesa\.
- [Diátaxis](https://diataxis.fr/start-here/) distingue le esigenze di tutorial\, guide pratiche\, spiegazioni e riferimenti\.
- [Microsoft\: Contenuti adatti alla lettura rapida](https://learn.microsoft.com/en-us/style-guide/scannable-content/) sottolinea una struttura con gli elementi importanti all\'inizio\, paragrafi brevi e punti di accesso visivi coerenti\.
- [Stile della documentazione Google per sviluppatori](https://developers.google.com/style/highlights) raccomanda forma attiva\, discorso diretto al lettore\, titoli descrittivi\, accessibilità e scrittura per un pubblico globale\.
- [GitHub\: Creazione di diagrammi](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) documenta il supporto di Mermaid in Markdown\.
- [W3C WAI\: Tutorial sulle immagini](https://www.w3.org/WAI/tutorials/images/) richiede alternative testuali ed equivalenti completi per elementi visivi informativi e complessi\.
