<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Política de seguretat

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · **Català** · [العربية](../ar/security.md)

[README](../../../README.md) · [Com contribuir](contributing.md) · [Codi de conducta](conduct.md) · **Seguretat** · [Governança](governance.md) · [Suport](support.md)

[Resum en 41 versions localitzades i punts d’accés web oficials](../../../docs/LANGUAGES.md)\. La versió anglesa d\'aquesta política normativa de seguretat continua sent la font canònica\.

Si l\'única font d\'evidències proposada conté historial privat o material operatiu sensible del qual no es pot eliminar la informació sensible\, no el recopilis ni el transmetis\. Registra només una justificació `REJECTED_WITH_EVIDENCE` amb la informació sensible ocultada\.

## Versions amb suport

| Versió | Suport |
| --- | --- |
| Darrera versió publicada i compilació immutable de Codex | Amb suport |
| Versions anteriors de la memòria cau immutable | Versions de destinació per a la reversió\; les correccions no es traslladen a versions anteriors tret que s\'anunciï explícitament |
| Bifurcacions no publicades o contingut modificat de la memòria cau | Sense suport |

## Notificar una vulnerabilitat

Utilitza la [notificació privada de vulnerabilitats de GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. No obris una incidència pública per una possible vulnerabilitat\.

Inclou\:

- la versió afectada i la compilació del connector\;
- l\'entorn i la versió de Node\.js\;
- els passos mínims per reproduir el problema\;
- el límit de seguretat esperat i l\'observat\;
- l\'impacte i qualsevol solució provisional coneguda\;
- si l\'informe conté material confidencial\.

No incloguis credencials actives\, claus de signatura\, testimonis de proveïdors\, instruccions privades per a models sense depurar ni dades personals de tercers\.

## Resposta

La persona responsable del manteniment confirmarà la recepció d\'un informe utilitzable\, en validarà l\'abast i coordinarà la correcció i la divulgació\. No es promet cap SLA amb un temps de resposta fix\. Els resultats desconeguts o no conciliats continuen bloquejats mentre manqui la verificació\.

## Límits de seguretat

Better Workflows pressuposa un repositori local\, un equip amfitrió i una cadena d\'eines executables de confiança\. El model de permisos de Node ofereix defensa en profunditat i no és un entorn aïllat del sistema operatiu per a codi maliciós\. Consulta la [guia de seguretat](security-guide.md) completa\.
