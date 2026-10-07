<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Contribuciones

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · **Español** · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Gracias por ayudar a mejorar Better Workflows\.

[README](../../../README.md) · **Cómo contribuir** · [Código de conducta](conduct.md) · [Seguridad](security.md) · [Gobernanza](governance.md) · [Soporte](support.md)

[Resumen en 41 versiones localizadas y puntos de acceso web oficiales](../../../docs/LANGUAGES.md)\. La versión en inglés de esta política normativa de contribuciones sigue siendo la fuente canónica\.

## Antes de empezar

- Utiliza primero un issue o debate para un contrato público nuevo\, un cambio en el comportamiento público de Auto\, un límite de seguridad o un gran cambio de arquitectura\.
- Mantén cada pull request enfocado en un solo resultado\.
- No hagas commit jamás de credenciales\, prompts privados\, historial de conversaciones en crudo\, claves de firma del anfitrión\, recibos de proveedores ni atestaciones firmadas\.
- Reporta las vulnerabilidades de forma privada como se describe en [SECURITY\.md](security.md)\.

## Configuración del entorno de desarrollo

Requisitos\:

- Node\.js 24 o posterior\;
- ninguna dependencia de terceros en tiempo de ejecución\;
- una rama limpia basada en la rama de destino actual\.

Ejecuta el conjunto local completo de comprobaciones de referencia\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Reglas para los cambios

1. Conserva la mutación perteneciente a Root y los límites de efectos secundarios fail\-closed\.
2. Cuando cambie el comportamiento público de Auto\, actualiza conjuntamente su plantilla y skill\, el catálogo de puntos de entrada\, la CLI\, las pruebas y toda la documentación afectada\.
3. Rechaza las opciones de CLI desconocidas y los campos de esquema desconocidos\.
4. Mantén el estado privado del runtime fuera del repositorio\.
5. Añade pruebas negativas para cada nuevo gate de seguridad\.
6. No mutes una versión inmutable existente de plugin\-cache\. Un bundle modificado requiere una nueva versión de compilación y la verificación exacta del digest de origen\/caché\.

Si la reorganización afecta únicamente al README\, mantén la página raíz fácil de consultar y coloca los contratos detallados en el archivo correspondiente de [`docs/guide/`](../../../docs/guide/)\.

## Lista de comprobación de la solicitud de incorporación de cambios

- [ ] El alcance y los aspectos que no son objetivos están explícitos\.
- [ ] El comportamiento y los límites de seguridad están documentados\.
- [ ] Las pruebas específicas cubren las rutas de éxito y de fallo\.
- [ ] La batería completa de pruebas y `sbw eval` se superan\.
- [ ] `git diff --check` se supera\.
- [ ] Los cambios de versión y de caché siguen las reglas de publicación inmutable cuando corresponde\.
- [ ] No se incluyen secretos\, estado privado ni comprobantes externos\.

Se prefieren commits pequeños y fáciles de revisar\. No combines tareas de limpieza ajenas con un cambio de comportamiento\.
