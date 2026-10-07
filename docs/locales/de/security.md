<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Sicherheitsrichtlinie

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · **Deutsch** · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Mitwirken](contributing.md) · [Verhaltenskodex](conduct.md) · **Sicherheit** · [Projektführung](governance.md) · [Hilfe](support.md)

[Überblick in 41 Sprach\- und Regionalversionen und offizielle Web\-Einstiegspunkte](../../../docs/LANGUAGES.md)\. Die englische Fassung dieser normativen Sicherheitsrichtlinie bleibt maßgeblich\.

Wenn die einzige vorgeschlagene Nachweisquelle private Verlaufsdaten oder sensible betriebliche Informationen enthält\, aus denen sensible Angaben nicht entfernt werden können\, dürfen Sie diese weder sammeln noch übertragen\. Halten Sie lediglich eine um sensible Angaben bereinigte Begründung mit `REJECTED_WITH_EVIDENCE` fest\.

## Unterstützte Versionen

| Version | Unterstützung |
| --- | --- |
| Neueste veröffentlichte Version und unveränderlicher Codex\-Build | Unterstützt |
| Ältere unveränderliche Cache\-Versionen | Ziele für ein Zurücksetzen\; Fehlerkorrekturen werden nur bei ausdrücklicher Ankündigung auf ältere Versionen zurückportiert |
| Unveröffentlichte Abspaltungen oder veränderte Cache\-Inhalte | Nicht unterstützt |

## Eine Schwachstelle melden

Bitte verwenden Sie die [private Schwachstellenmeldung von GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. Eröffnen Sie für eine vermutete Schwachstelle kein öffentliches Ticket\.

Geben Sie Folgendes an\:

- betroffene Version und betroffener Plugin\-Build\;
- Umgebung und Node\.js\-Version\;
- minimale Schritte zur Reproduktion\;
- erwartete und beobachtete Sicherheitsgrenze\;
- Auswirkungen und bekannte Umgehungslösungen\;
- ob der Bericht vertrauliche Informationen enthält\.

Fügen Sie keine aktiven Zugangsdaten\, Signaturschlüssel\, Anbieter\-Token\, unbearbeiteten privaten Eingabeanweisungen oder personenbezogenen Daten Dritter bei\.

## Rückmeldung

Die für die Wartung verantwortliche Person bestätigt den Eingang eines verwertbaren Berichts\, prüft dessen Umfang und koordiniert Behebung und Offenlegung\. Es wird keine SLA mit fester Reaktionszeit zugesagt\. Unbekannte oder noch nicht abgeglichene Ergebnisse bleiben gesperrt\; ohne Verifizierung wird die Fortsetzung verweigert\.

## Sicherheitsgrenzen

Better Workflows setzt ein vertrauenswürdiges lokales Repository\, einen vertrauenswürdigen Host und eine vertrauenswürdige ausführbare Werkzeugkette voraus\. Das Berechtigungsmodell von Node dient der mehrschichtigen Verteidigung und ist keine Betriebssystem\-Sandbox für bösartigen Code\. Siehe den vollständigen [Sicherheitsleitfaden](security-guide.md)\.
