<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Contribuire

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · **Italiano** · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Grazie per contribuire a migliorare Better Workflows\.

[README](../../../README.md) · **Contribuire** · [Codice di condotta](conduct.md) · [Sicurezza](security.md) · [Governo del progetto](governance.md) · [Assistenza](support.md)

[Panoramica in 41 versioni localizzate e punti di accesso web ufficiali](../../../docs/LANGUAGES.md)\. La versione inglese di questa politica normativa sui contributi resta il riferimento canonico\.

## Prima di iniziare

- Usa prima una issue o una discussion per un nuovo contratto pubblico\, una modifica al comportamento pubblico di Auto\, un confine di sicurezza o una grande modifica architetturale\.
- Mantieni ciascuna pull request focalizzata su un unico risultato\.
- Non eseguire mai il commit di credenziali\, prompt privati\, cronologia non elaborata delle conversazioni\, chiavi di firma dell\'host\, ricevute del provider o attestazioni firmate\.
- Segnala privatamente le vulnerabilità come descritto in [SECURITY\.md](security.md)\.

## Configurazione dell’ambiente di sviluppo

Requisiti\:

- Node\.js 24 o successivo\;
- nessuna dipendenza di terze parti in fase di esecuzione\;
- un ramo pulito basato sul ramo di destinazione corrente\.

Esegui l’intera serie di verifiche di base locali\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Regole per le modifiche

1. Preserva le mutazioni di proprietà di Root e i confini degli effetti collaterali fail\-closed\.
2. Quando il comportamento pubblico di Auto cambia\, aggiorna insieme template e skill\, catalogo degli entrypoint\, CLI\, test e tutta la documentazione interessata\.
3. Rifiuta le opzioni CLI sconosciute e i campi dello schema sconosciuti\.
4. Mantieni lo stato di runtime privato all\'esterno del repository\.
5. Aggiungi test negativi per ogni nuovo safety gate\.
6. Non modificare una versione immutabile esistente della cache dei plugin\. Un bundle modificato richiede una nuova versione di build e la verifica esatta del digest tra sorgente e cache\.

Per una riorganizzazione limitata al README\, mantieni la pagina radice facile da scorrere e colloca i contratti dettagliati nel file corrispondente sotto [`docs/guide/`](../../../docs/guide/)\.

## Lista di controllo della richiesta di integrazione

- [ ] L’ambito e gli obiettivi esclusi sono espliciti\.
- [ ] Il comportamento e i confini di sicurezza sono documentati\.
- [ ] Test mirati coprono i percorsi di successo e di errore\.
- [ ] L’intera suite di test e `sbw eval` vengono superati\.
- [ ] `git diff --check` viene superato\.
- [ ] Le modifiche a versione\/cache seguono le regole di pubblicazione immutabile\, ove applicabili\.
- [ ] Non sono inclusi segreti\, stato privato o ricevute esterne\.

Sono preferibili registrazioni delle modifiche piccole e facili da esaminare\. Non unire interventi di pulizia non pertinenti a una modifica del comportamento\.
