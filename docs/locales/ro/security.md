<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Politica de securitate

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · **Română** · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Contribuții](contributing.md) · [Cod de conduită](conduct.md) · **Securitate** · [Administrarea proiectului](governance.md) · [Asistență](support.md)

[Prezentare generală în 41 de versiuni localizate și puncte oficiale de acces web](../../../docs/LANGUAGES.md)\. Versiunea în engleză a acestei politici normative de securitate rămâne sursa canonică\.

Dacă singura sursă de dovezi propusă conține istoric privat sau materiale operaționale sensibile din care nu pot fi eliminate informațiile sensibile\, nu le colectați și nu le transmiteți\. Înregistrați doar o justificare `REJECTED_WITH_EVIDENCE` cu informațiile sensibile mascate\.

## Versiuni acceptate

| Versiune | Asistență |
| --- | --- |
| Cea mai recentă versiune publicată și compilarea imuabilă Codex | Asistență oferită |
| Versiuni mai vechi ale memoriei cache imuabile | Ținte pentru revenire\; corecțiile nu sunt portate în versiunile anterioare decât dacă se anunță explicit |
| Ramificații nepublicate sau conținut modificat al memoriei cache | Fără asistență |

## Raportarea unei vulnerabilități

Vă rugăm să utilizați [raportarea privată a vulnerabilităților pe GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. Nu deschideți o sesizare publică pentru o vulnerabilitate suspectată\.

Includeți\:

- versiunea afectată și compilarea modulului de extensie\;
- mediul și versiunea Node\.js\;
- pașii minimi pentru reproducere\;
- limita de securitate așteptată și cea observată\;
- impactul și orice soluție provizorie cunoscută\;
- dacă raportul conține materiale confidențiale\.

Nu includeți credențiale active\, chei de semnare\, tokenuri ale furnizorilor\, instrucțiuni private în formă brută sau date cu caracter personal ale terților\.

## Răspuns

Responsabilul de mentenanță va confirma primirea unui raport utilizabil\, îi va valida domeniul și va coordona remedierea și divulgarea\. Nu se promite un SLA cu timp de răspuns fix\. Rezultatele necunoscute sau nereconciliate rămân blocate în lipsa verificării\.

## Limite de securitate

Better Workflows presupune că depozitul local\, sistemul gazdă și lanțul de instrumente executabile sunt de încredere\. Modelul de permisiuni al Node asigură apărare în profunzime și nu constituie un mediu izolat la nivelul sistemului de operare pentru cod rău intenționat\. Consultați [ghidul de securitate](security-guide.md) complet\.
