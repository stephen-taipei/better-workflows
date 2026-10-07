<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Contribucions

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · **Català** · [العربية](../ar/contributing.md)

Gràcies per ajudar a millorar Better Workflows\.

[README](../../../README.md) · **Com contribuir** · [Codi de conducta](conduct.md) · [Seguretat](security.md) · [Governança](governance.md) · [Suport](support.md)

[Resum en 41 versions localitzades i punts d’accés web oficials](../../../docs/LANGUAGES.md)\. La versió anglesa d\'aquesta política normativa de contribucions continua sent la font canònica\.

## Abans de començar

- Fes servir primer una issue o discussió per a un nou contracte públic\, un canvi en el comportament públic d’Auto\, un límit de seguretat o un gran canvi arquitectònic\.
- Mantén cada pull request centrat en un únic resultat\.
- No facis mai commit de credencials\, prompts privats\, historial de converses en brut\, claus de signatura d’amfitrió\, rebuts de proveïdor o atestacions signades\.
- Informa de les vulnerabilitats de manera privada tal com es descriu a [SECURITY\.md](security.md)\.

## Configuració de l\'entorn de desenvolupament

Requisits\:

- Node\.js 24 o posterior\;
- cap dependència de tercers en temps d\'execució\;
- una branca neta basada en la branca de destinació actual\.

Executa el conjunt local complet de comprovacions de referència\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Regles per als canvis

1. Preserva les mutacions propietat de Root i els límits d’efectes secundaris fail\-closed\.
2. Quan canviï el comportament públic d’Auto\, actualitza la seva plantilla i skill\, el catàleg d’entrypoints\, la CLI\, els tests i tota la documentació afectada alhora\.
3. Rebutja les opcions de la CLI desconegudes i els camps d’esquema desconeguts\.
4. Mantingues l’estat d’execució privat fora del repositori\.
5. Afegeix tests negatius per a cada nou gate de seguretat\.
6. No modifiquis una versió immutable existent de plugin\-cache\. Un paquet canviat requereix una nova versió de compilació i la verificació exacta del digest de font\/memòria cau\.

Si la reorganització afecta només el README\, mantén la pàgina arrel fàcil de consultar i col·loca els contractes detallats al fitxer corresponent de [`docs/guide/`](../../../docs/guide/)\.

## Llista de comprovació de la sol·licitud d\'integració

- [ ] L\'abast i els aspectes que no són objectius són explícits\.
- [ ] El comportament i els límits de seguretat estan documentats\.
- [ ] Les proves específiques cobreixen els camins d\'èxit i de fallada\.
- [ ] El conjunt complet de proves i `sbw eval` se superen\.
- [ ] `git diff --check` se supera\.
- [ ] Els canvis de versió i de memòria cau segueixen les regles de publicació immutable quan escau\.
- [ ] No s\'hi inclouen secrets\, estat privat ni comprovants externs\.

Es prefereixen registres de canvis petits i fàcils de revisar\. No combinis tasques de neteja no relacionades amb un canvi de comportament\.
