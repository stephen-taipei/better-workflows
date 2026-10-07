<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Beiträge leisten

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · **Deutsch** · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Vielen Dank\, dass Sie helfen\, Better Workflows zu verbessern\.

[README](../../../README.md) · **Mitwirken** · [Verhaltenskodex](conduct.md) · [Sicherheit](security.md) · [Projektführung](governance.md) · [Hilfe](support.md)

[Überblick in 41 Sprach\- und Regionalversionen und offizielle Web\-Einstiegspunkte](../../../docs/LANGUAGES.md)\. Die englische Fassung dieser normativen Beitragsrichtlinie bleibt maßgeblich\.

## Bevor Sie beginnen

- Nutze zuerst ein Issue oder eine Diskussion für einen neuen öffentlichen Vertrag\, eine Änderung an Autos öffentlichem Verhalten\, eine Sicherheitsgrenze oder eine größere Architekturänderung\.
- Halte einen Pull Request auf ein einzelnes Ergebnis fokussiert\.
- Committe niemals Anmeldedaten\, private Prompts\, unveränderten Konversationsverlauf\, Host\- Signaturschlüssel\, Provider\-Belege oder signierte Bestätigungen\.
- Melde Sicherheitslücken vertraulich wie in [SECURITY\.md](security.md) beschrieben\.

## Entwicklungsumgebung einrichten

Voraussetzungen\:

- Node\.js 24 oder neuer\;
- keine Laufzeitabhängigkeit von Drittanbietern\;
- ein sauberer Zweig auf Basis des aktuellen Zielzweigs\.

Führen Sie sämtliche lokalen Basisprüfungen aus\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Änderungsregeln

1. Behalte Root\-eigene Mutationen und Fail\-Closed\-Grenzen für Seiteneffekte bei\.
2. Wenn sich das öffentliche Verhalten von Auto ändert\, aktualisiere Vorlage und Skill\, Einstiegspunkt\-Katalog\, CLI\, Tests und die gesamte betroffene Dokumentation gemeinsam\.
3. Weise unbekannte CLI\-Optionen und unbekannte Schema\-Felder zurück\.
4. Halte privaten Laufzeitstatus außerhalb des Repositorys\.
5. Ergänze negative Tests für jedes neue Safety Gate\.
6. Verändere keine bestehende\, unveränderliche Plugin\-Cache\-Version\. Ein geändertes Bundle erfordert eine neue Build\-Version und eine exakte Quell\-\/Cache\-Digest\-Verifizierung\.

Halten Sie bei einer ausschließlich auf die README beschränkten Neuordnung die Wurzelseite leicht überfliegbar und legen Sie ausführliche Verträge in der passenden Datei unter [`docs/guide/`](../../../docs/guide/) ab\.

## Checkliste für Zusammenführungsanträge

- [ ] Umfang und ausdrücklich ausgeschlossene Ziele sind klar benannt\.
- [ ] Verhalten und Sicherheitsgrenzen sind dokumentiert\.
- [ ] Gezielte Tests decken Erfolgs\- und Fehlerpfade ab\.
- [ ] Die vollständige Testsuite und `sbw eval` bestehen\.
- [ ] `git diff --check` besteht\.
- [ ] Versions\-\/Cache\-Änderungen folgen gegebenenfalls den Regeln für unveränderliche Veröffentlichungen\.
- [ ] Es sind keine Geheimnisse\, privaten Zustandsdaten oder externen Belege enthalten\.

Kleine\, gut überprüfbare Änderungseinträge werden bevorzugt\. Verbinden Sie keine sachfremden Aufräumarbeiten mit einer Verhaltensänderung\.
