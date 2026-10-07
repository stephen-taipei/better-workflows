<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Politica di sicurezza

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · **Italiano** · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Contribuire](contributing.md) · [Codice di condotta](conduct.md) · **Sicurezza** · [Governo del progetto](governance.md) · [Assistenza](support.md)

[Panoramica in 41 versioni localizzate e punti di accesso web ufficiali](../../../docs/LANGUAGES.md)\. La versione inglese di questa politica normativa di sicurezza resta il riferimento canonico\.

Se l’unica fonte di evidenze proposta contiene una cronologia privata o materiale operativo sensibile da cui non è possibile rimuovere le informazioni sensibili\, non raccoglierlo né trasmetterlo\. Registra soltanto una motivazione `REJECTED_WITH_EVIDENCE` con le informazioni sensibili oscurate\.

## Versioni supportate

| Versione | Supporto |
| --- | --- |
| Ultima versione pubblicata e compilazione immutabile di Codex | Supportate |
| Versioni precedenti della cache immutabile | Destinazioni per il ripristino di una versione precedente\; le correzioni non vengono riportate alle versioni precedenti\, salvo annuncio esplicito |
| Derivazioni non ancora rilasciate o contenuti della cache modificati | Non supportati |

## Segnalare una vulnerabilità

Utilizza la [segnalazione privata delle vulnerabilità di GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. Non aprire una segnalazione pubblica per una vulnerabilità sospetta\.

Includi\:

- la versione e la compilazione del componente aggiuntivo interessate\;
- l’ambiente e la versione di Node\.js\;
- i passaggi minimi per riprodurre il problema\;
- il confine di sicurezza previsto e quello osservato\;
- l’impatto e le eventuali soluzioni temporanee note\;
- l’indicazione della presenza o meno di materiale riservato nella segnalazione\.

Non includere credenziali attive\, chiavi di firma\, token dei fornitori\, istruzioni private non elaborate o dati personali di terzi\.

## Risposta

Il responsabile della manutenzione confermerà la ricezione di una segnalazione utilizzabile\, ne convaliderà l’ambito e coordinerà la correzione e la divulgazione\. Non viene promesso alcuno SLA con tempi di risposta fissi\. Gli esiti sconosciuti o non riconciliati restano bloccati\, rifiutando di proseguire finché non sono verificati\.

## Confini di sicurezza

Better Workflows presuppone un repository locale\, un host e una catena di strumenti eseguibili affidabili\. Il Modello di autorizzazioni di Node è una difesa in profondità e non un ambiente isolato a livello di sistema operativo per codice malevolo\. Consulta la [guida alla sicurezza](security-guide.md) completa\.
