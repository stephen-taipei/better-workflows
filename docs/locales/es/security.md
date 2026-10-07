<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Política de seguridad

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · **Español** · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Cómo contribuir](contributing.md) · [Código de conducta](conduct.md) · **Seguridad** · [Gobernanza](governance.md) · [Soporte](support.md)

[Resumen en 41 versiones localizadas y puntos de acceso web oficiales](../../../docs/LANGUAGES.md)\. La versión en inglés de esta política normativa de seguridad sigue siendo la fuente canónica\.

Si la única fuente de evidencias propuesta contiene historial privado o material operativo sensible del que no se puede eliminar la información sensible\, no lo recopiles ni lo transmitas\. Registra únicamente una justificación `REJECTED_WITH_EVIDENCE` con la información sensible ocultada\.

## Versiones compatibles

| Versión | Soporte |
| --- | --- |
| Última versión publicada y compilación inmutable de Codex | Con soporte |
| Versiones anteriores de la caché inmutable | Destinos de reversión\; las correcciones no se trasladan a versiones anteriores salvo que se anuncie expresamente |
| Bifurcaciones no publicadas o contenido modificado de la caché | Sin soporte |

## Notificar una vulnerabilidad

Utiliza la [notificación privada de vulnerabilidades de GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. No abras una incidencia pública por una posible vulnerabilidad\.

Incluye\:

- versión afectada y compilación del complemento\;
- entorno y versión de Node\.js\;
- pasos mínimos para reproducir el problema\;
- límite de seguridad esperado y observado\;
- impacto y cualquier solución provisional conocida\;
- si el informe contiene material confidencial\.

No incluyas credenciales activas\, claves de firma\, tokens de proveedores\, instrucciones privadas para modelos sin depurar ni datos personales de terceros\.

## Respuesta

La persona responsable del mantenimiento acusará recibo de un informe utilizable\, validará su alcance y coordinará la corrección y la divulgación\. No se promete ningún SLA con un tiempo de respuesta fijo\. Los resultados desconocidos o sin conciliar permanecen bloqueados mientras falte la verificación\.

## Límites de seguridad

Better Workflows presupone un repositorio local\, un equipo anfitrión y una cadena de herramientas ejecutables de confianza\. El modelo de permisos de Node ofrece defensa en profundidad y no es un entorno aislado del sistema operativo para código malicioso\. Consulta la [guía de seguridad](security-guide.md) completa\.
