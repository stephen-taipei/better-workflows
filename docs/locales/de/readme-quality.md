<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Qualitätskonzept für README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · **Deutsch** · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Überblick in 41 Sprach\- und Regionalversionen und offizielle Web\-Einstiegspunkte](../../../docs/LANGUAGES.md)\. Die englische Fassung dieses redaktionellen Konzepts bleibt die kanonische Quelle\.

Eine README\-Datei von Better Workflows ist eine Einstiegsseite\, kein komprimiertes Nachschlagewerk\. Sie soll Lesenden helfen\, fünf Fragen der Reihe nach zu beantworten\:

1. Was ist das\, und ist es etwas für mich\?
2. Welches Problem löst es\?
3. Warum sollte ich seinen Aussagen vertrauen\?
4. Was ist der kürzeste Weg zu einem ersten Erfolg\?
5. Wohin sollte ich als Nächstes gehen\?

Dieses Konzept legt den Vertrag für Erzählstruktur\, visuelle Darstellung\, Lokalisierung und Validierung jeder README\-Datei des Repositorys fest\. Die maschinenlesbare Quelle ist [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Beginne bei der Entscheidung der Lesenden

GitHub zeigt eine README\-Datei vor den meisten anderen Inhalten des Repositorys\. Die erste Bildschirmansicht muss deshalb das Produktversprechen\, die Zielgruppe und eine klar begrenzte nächste Handlung vermitteln\. Sie darf nicht mit interner Architektur\, einer vollständigen Befehlsreferenz oder Details zur Wiederherstellung von Veröffentlichungen beginnen\.

Schreibe für diese Aufgaben der Lesenden\:

- **Neuer Besucher\:** schnell entscheiden\, ob Better Workflows ein relevantes Problem löst\.
- **Neuer Benutzer\:** das Plugin installieren und eine erfolgreiche automatische Route erreichen\.
- **Evaluierer\:** die Berechtigungsgrenze und das Fail\-Closed\-Verhalten verstehen\.
- **Wiederkehrender Operator\:** direkt zu einer Antwort für Workflows\, Sicherheit\, Architektur oder CLI springen\.
- **Mitwirkender oder Übersetzer\:** den verbindlichen Vertrag\, Entwicklungsbefehle\, Support und Governance finden\.

## Erzähle entlang von Ursache und Wirkung

Die fünf Einstiegs\-README\-Dateien verwenden dieselbe achtteilige semantische Abfolge\. Überschriften können in jeder Sprache idiomatisch sein\, doch der Weg der Lesenden bleibt gleich\.

| Abschnitt | Leserfrage und Rolle in der Erzählung |
| --- | --- |
| Versprechen und Zielgruppe | Was ist Better Workflows\, warum gibt es das\, und für wen ist es gedacht\? |
| Vom Problem zum Ergebnis | Was geht schief\, wenn Absicht\, Befugnisse\, Belege und Anbieterergebnis vermischt werden\? |
| Nachweise und Grenzen | Welche Garantien machen das vorgeschlagene Ergebnis glaubwürdig\? |
| Erster Erfolg | Was ist der kürzeste vollständige Weg von der Installation zum Ergebnis\? |
| Den nächsten Weg wählen | Welcher Arbeitsablauf oder welches Dokument passt zum Ziel der Lesenden\? |
| Lebenszyklus | Wie führt ein Ziel zu einem Abschluss mit abgeglichenen Ergebnissen – oder zu einem sicheren Stopp\? |
| Vertrauen und Grenzen | Was darf das System niemals ableiten\, autorisieren oder behaupten\? |
| Lernen\, Hilfe erhalten\, mitwirken | Wo sind die vertiefende Dokumentation\, Unterstützung\, Projektführung\, Entwicklung und Lizenz\? |

Diese Reihenfolge ergibt einen praktischen Erzählbogen\:

- **Kontext\:** durch Modellanweisungen gesteuerte Arbeit kann Absicht ausdrücken\, ohne Befugnisse oder Zustand nachzuweisen\.
- **Spannung\:** Seiteneffekte machen diese Lücke zu einem Risiko für die Ergebnislieferung\.
- **Auflösung\:** Better Workflows verknüpft Ziel\, Umfang\, Belege\, Prüfung\, Handlung und Abgleich mit dem Anbieterergebnis\.
- **Nachweis\:** ausdrückliche Garantien und Grenzen zeigen\, wie die Auflösung funktioniert\.
- **Handlung\:** Lesende erreichen einen ersten Erfolg\, bevor sie auf tiefgehende Implementierungsdetails treffen\.
- **Fortsetzung\:** rollen\- und ergebnisbezogene Wege führen Lesende zum passenden Tutorial\, zur praktischen Anleitung\, Erklärung oder Referenz\.

## Trenne Einstiegsinhalte von vertiefender Dokumentation

Verwende die README für entscheidungsrelevante Informationen\. Verweise je nach Zweck auf Vertiefungen\:

- [Erste Schritte](getting-started.md) ist das Tutorial für die erstmalige Nutzung\.
- [Arbeitsabläufe](workflows.md) ist die praktische Anleitung zur Ergebnisauswahl\.
- [Architektur](architecture.md) erklärt die Steuerungsebene und Abwägungen\.
- [Sicherheit](security-guide.md) erklärt Befugnisse\, Privatsphäre\, Bescheinigungen und das Verhalten\, das Aktionen bei fehlender Verifizierung blockiert\.
- [CLI\-Referenz](cli-reference.md) ist die Befehlsreferenz\.
- Lokalisierte `docs/details/*.md`\-Seiten bewahren die übersetzten Einzelheiten vollständig\.

Dupliziere auf der Einstiegsseite weder Cache\-Wiederherstellung noch Inhaberschaft von Sperren\, vollständige Semantik des Anbietertransports\, eine erschöpfende Befehlsübersicht oder die Änderungshistorie der Implementierung\. Eine knappe Sicherheitszusage bleibt auf der Seite\; ihre prüfbaren Einzelheiten gehören in den kanonischen Leitfaden\.

Diese Trennung folgt der Unterscheidung von Diátaxis zwischen Tutorials\, praktischen Anleitungen\, Erklärungen und Referenzen\. Eine einzelne Seite lässt sich nicht gleichzeitig für alle vier Bedürfnisse der Lesenden optimieren\.

## Begründe den Platz jeder Darstellung

Verwende eine Darstellung nur\, wenn sich Beziehungen\, Hierarchien oder Zustandsübergänge damit wesentlich leichter verstehen lassen als mit Fließtext\.

Die Einstiegsseiten erlauben zwei Darstellungen\:

1. **Architektur der Befugnisgrenzen\:** beantwortet\, welche Ebenen Absicht\, aktuelle Fakten\, Werkzeugbefugnisse\, begrenzte Wiederholungsversuche und ausschließlich lesbaren Zustand prägen\.
2. **Lebenszyklus vom Ziel bis zum Abschluss\:** beantwortet\, wo Belege geprüft\, wo Seiteneffekte autorisiert werden und wo unbekannter Zustand den Fortschritt stoppt\.

Jede Darstellung muss Folgendes enthalten\:

- einen knappen\, aussagekräftigen Alternativtext\;
- eine direkt danebenstehende gleichwertige Textfassung\, die die Schlussfolgerung erhält\, wenn die Darstellung ausgeblendet ist oder Mermaid nicht gerendert wird\;
- nach Möglichkeit echten Text für wesentliche Beschriftungen\;
- eine dauerhaft relevante Leserfrage\, die es rechtfertigt\, die Darstellung aktuell zu halten\.

Füge keine dekorativen Bildschirmaufnahmen\, textlastigen Bilder oder Diagramme hinzu\, die lediglich eine kurze Liste duplizieren\. Beschränke Auswahltabellen auf zwei knapp gehaltene Spalten\, damit sie auf schmalen Bildschirmen nutzbar bleiben\.

## Bewahre die Bedeutung über Sprachgrenzen hinweg

Englisch ist die semantische Referenz\, kein Zielwert für die Zeilenzahl\. Traditionelles Chinesisch\, vereinfachtes Chinesisch\, Japanisch und Koreanisch sollen für muttersprachliche Lesende natürlich klingen und zugleich denselben Vertrag bewahren\.

Die folgenden Punkte müssen gleichwertig bleiben\:

- die acht semantischen Abschnitte und ihre Reihenfolge\;
- Befehle für den ersten Erfolg und Produktkennungen\;
- die fünf Aussagen zu Befugnissen\, Belegen\, unbekanntem Zustand\, Modellanweisungen und Privatsphäre\;
- die Linkziele für Arbeitsabläufe\, Sicherheit\, Architektur\, CLI\, Unterstützung\, Projektführung\, Entwicklung und Lizenz\;
- der Zweck der Darstellungen\, die Lebenszyklusphasen und textlichen Ersatzfassungen\;
- die Quelle der Versionsangabe und die Richtlinie für Abzeichen\.

Überschriften\, Satzgrenzen\, Zeichensetzung\, Beispiele und Handlungsaufforderungen dürfen idiomatisch sein\. Übersetze niemals Befehle\, Selektoren\, Belegkennungen oder Sicherheitssemantik\.

## Schreibe für schnelles Erfassen und Übersetzung

- Beginne mit dem Ergebnis für die Lesenden und stelle wichtige Begriffe an den Anfang von Überschriften und Absätzen\.
- Verwende das Aktiv und benenne den für eine Handlung verantwortlichen Akteur\.
- Sprich die Lesenden bei Verfahrensanweisungen direkt an\.
- Halte Absätze kurz und gib jedem genau eine Aufgabe\.
- Verwende nummerierte Listen für Abfolgen und Aufzählungspunkte für Auswahlmöglichkeiten ohne Reihenfolge\.
- Verwende beschreibende Links statt allgemeiner Beschriftungen wie „hier klicken“\.
- Halte Überschriften hierarchisch\, konkret und auf derselben Ebene parallel formuliert\.
- Bevorzuge wörtlich gemeinte\, eindeutige Sprache\, deren Bedeutung bei der Übersetzung erhalten bleibt\.
- Stelle Bedingungen vor Anweisungen und erwartete Ergebnisse hinter Befehle\.

## Validiere Semantik\, nicht Dekoration

Die Dokumentationstests müssen mehr erkennen als übereinstimmende Überschriften\. Sie prüfen\:

- eine H1 und eine logische Überschriftenhierarchie\;
- geordnete semantische Abschnitts\- und Critical\-Claim\-Markierungen\;
- exakte Befehle für den ersten Erfolg und stabile Bezeichner\;
- relative Links und gebietsschemaspezifische Detailziele\;
- Versions\-Badge\-Übereinstimmung mit Laufzeitmetadaten\;
- aussagekräftiger Bild\-Alt\-Text und angrenzende visuelle Fallbacks\;
- ein einzelner Mermaid\-Lebenszyklus mit vollständigem Textäquivalent\;
- zweispaltiges Tabellen\- und Absatzlängen\-Budget\;
- Verzicht auf ausgewiesene tiefe Implementierungsdetails auf Landingpages\;

## Forschungsgrundlage

- [GitHub\: Über die README\-Datei des Repositorys](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) definiert den Zweck der README beim ersten Besuch und empfiehlt\, umfangreiche Dokumentation anderswo unterzubringen\.
- [Diátaxis](https://diataxis.fr/start-here/) trennt die Bedürfnisse nach Tutorials\, praktischen Anleitungen\, Erklärungen und Referenzen\.
- [Microsoft\: Schnell erfassbare Inhalte](https://learn.microsoft.com/en-us/style-guide/scannable-content/) betont eine Struktur mit dem Wichtigsten zuerst\, kurze Absätze und einheitliche visuelle Einstiegspunkte\.
- [Google\-Stilrichtlinien für Entwicklerdokumentation](https://developers.google.com/style/highlights) empfehlen Aktiv\, direkte Ansprache\, beschreibende Überschriften\, Barrierefreiheit und Schreiben für ein weltweites Publikum\.
- [GitHub\: Diagramme erstellen](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) dokumentiert die Unterstützung von Mermaid in Markdown\.
- [W3C WAI\: Tutorial zu Bildern](https://www.w3.org/WAI/tutorials/images/) verlangt Textalternativen und vollständige gleichwertige Fassungen für informative und komplexe Darstellungen\.
