<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Plan de calidad para README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · **Español \(México\)** · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Resumen en 41 versiones localizadas y puntos de acceso web oficiales](../../../docs/LANGUAGES.md)\. La versión en inglés de este plan editorial sigue siendo la fuente canónica\.

Un README de Better Workflows es una página de presentación\, no un manual de referencia comprimido\. Su función es ayudar al lector a responder\, en orden\, cinco preguntas\:

1. ¿Qué es esto y es para mí\?
2. ¿Qué problema resuelve\?
3. ¿Por qué debería confiar en sus afirmaciones\?
4. ¿Cuál es la ruta más corta hacia un primer éxito\?
5. ¿Adónde debería ir después\?

Este plan define el contrato narrativo\, visual\, de localización y de validación para cada README del repositorio\. La fuente legible por máquina es [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Comienza por la decisión del lector

GitHub muestra un README antes que la mayoría del contenido del repositorio\. Por eso\, la primera pantalla debe establecer la promesa del producto\, el público previsto y una siguiente acción con límites definidos\. No debe comenzar con la arquitectura interna\, una referencia completa de comandos ni detalles sobre la recuperación de versiones publicadas\.

Escribe para estas tareas de los lectores\:

- **Nuevo visitante\:** decide rápidamente si Better Workflows resuelve un problema relevante\.
- **Nuevo usuario\:** instala el plugin y logra una ruta automática exitosa\.
- **Evaluador\:** comprende el límite de autoridad y el comportamiento fail\-closed\.
- **Operador recurrente\:** salta a una respuesta de flujo de trabajo\, seguridad\, arquitectura o CLI\.
- **Colaborador o traductor\:** encuentra el contrato canónico\, los comandos de desarrollo\, el soporte y la gobernanza\.

## Usa una narrativa de causa y efecto

Los cinco README de presentación utilizan la misma secuencia semántica de ocho partes\. Los títulos pueden ser naturales en cada idioma\, pero el recorrido del lector no cambia\.

| Sección | Pregunta del lector y función narrativa |
| --- | --- |
| Promesa y público | ¿Qué es Better Workflows\, por qué existe y a quién se dirige\? |
| Del problema al resultado | ¿Qué falla cuando se confunden la intención\, la autoridad\, la evidencia y el resultado del proveedor\? |
| Demostración y límites | ¿Qué garantías hacen creíble el resultado propuesto\? |
| Primer éxito | ¿Cuál es la ruta completa más corta desde la instalación hasta el resultado\? |
| Elegir la siguiente ruta | ¿Qué flujo de trabajo o documento coincide con el objetivo del lector\? |
| Ciclo de vida | ¿Cómo se convierte un objetivo en una finalización con resultados conciliados\, o cómo se detiene de forma segura\? |
| Confianza y limitaciones | ¿Qué no puede deducir\, autorizar ni afirmar nunca el sistema\? |
| Aprender\, obtener ayuda\, contribuir | ¿Dónde están la documentación detallada\, el soporte\, la gobernanza\, el desarrollo y la licencia\? |

Este orden proporciona un arco narrativo práctico\:

- **Contexto\:** el trabajo guiado por instrucciones para modelos puede expresar una intención sin demostrar la autoridad ni el estado\.
- **Tensión\:** los efectos secundarios convierten esa carencia en un riesgo para la entrega del resultado\.
- **Resolución\:** Better Workflows vincula el objetivo\, el alcance\, la evidencia\, la revisión\, la acción y la conciliación con el resultado del proveedor\.
- **Demostración\:** las garantías y los límites explícitos muestran cómo funciona la resolución\.
- **Acción\:** el lector alcanza un primer éxito antes de encontrarse con detalles profundos de implementación\.
- **Continuación\:** las rutas basadas en el rol y el resultado llevan al lector al tutorial\, la guía práctica\, la explicación o la referencia adecuados\.

## Separa el contenido de presentación de la documentación detallada

Usa el README para la información relevante para la decisión\. Dirige a los detalles según el propósito\:

- [Primeros pasos](getting-started.md) es el tutorial para el primer uso\.
- [Flujos de trabajo](workflows.md) es la guía práctica para seleccionar resultados\.
- [Arquitectura](architecture.md) explica el plano de control y las ventajas y desventajas de cada opción\.
- [Seguridad](security-guide.md) explica la autoridad\, la privacidad\, las atestaciones y el comportamiento que bloquea las acciones cuando falta la verificación\.
- [Referencia de CLI](cli-reference.md) es la referencia de comandos\.
- Las páginas localizadas `docs/details/*.md` conservan por completo los detalles traducidos\.

No dupliques en la página de presentación la recuperación de la caché\, la titularidad de los bloqueos\, la semántica completa del transporte con los proveedores\, el repertorio exhaustivo de comandos ni el historial de cambios de implementación\. Una afirmación concisa de seguridad permanece en esa página\; los detalles que permiten auditarla corresponden a la guía canónica\.

Esta separación sigue la distinción de Diátaxis entre tutoriales\, guías prácticas\, explicaciones y referencias\. Una sola página no puede optimizarse para las cuatro necesidades del lector al mismo tiempo\.

## Justifica la presencia de cada elemento visual

Usa un elemento visual solo cuando facilite de forma sustancial la comprensión de relaciones\, jerarquías o transiciones de estado respecto al texto\.

Las páginas de presentación permiten dos elementos visuales\:

1. **Arquitectura de límites de autoridad\:** responde qué capas dan forma a la intención\, los hechos actuales\, la autoridad de las herramientas\, los reintentos limitados y el estado de solo lectura\.
2. **Ciclo de vida del objetivo a la finalización\:** responde dónde se verifica la evidencia\, dónde se autorizan los efectos secundarios y dónde un estado desconocido detiene el avance\.

Cada elemento visual debe incluir\:

- un texto alternativo conciso y significativo\;
- un equivalente textual adyacente que conserve la conclusión cuando el elemento visual esté oculto o Mermaid no se renderice\;
- texto real para las etiquetas esenciales siempre que sea posible\;
- una pregunta estable del lector que justifique mantener actualizado el elemento visual\.

No agregues capturas decorativas\, imágenes cargadas de texto ni un diagrama que se limite a duplicar una lista breve\. Limita las tablas de selección a dos columnas concisas para que sigan siendo utilizables en pantallas estrechas\.

## Conserva el significado entre idiomas

El inglés es la referencia semántica\, no un objetivo de número de líneas\. El chino tradicional\, el chino simplificado\, el japonés y el coreano deben sonar naturales para un lector nativo y conservar el mismo contrato\.

Los siguientes elementos deben seguir siendo equivalentes\:

- las ocho secciones semánticas y su orden\;
- los comandos para el primer éxito y los identificadores de producto\;
- las cinco afirmaciones sobre autoridad\, evidencia\, estado desconocido\, instrucciones para modelos y privacidad\;
- los destinos de flujos de trabajo\, seguridad\, arquitectura\, CLI\, soporte\, gobernanza\, desarrollo y licencia\;
- la finalidad de los elementos visuales\, las etapas del ciclo de vida y las alternativas textuales\;
- la fuente de la versión y la política de insignias\.

Los títulos\, los límites entre oraciones\, la puntuación\, los ejemplos y las llamadas a la acción pueden ser naturales en cada idioma\. Nunca traduzcas comandos\, selectores\, identificadores de evidencia ni semántica de seguridad\.

## Escribe para facilitar la lectura rápida y la traducción

- Comienza por el resultado del lector y coloca los términos importantes al principio de los títulos y los párrafos\.
- Usa la voz activa e identifica al actor responsable de una acción\.
- Dirígete directamente al lector en los procedimientos\.
- Mantén los párrafos breves y asigna a cada uno una sola función\.
- Usa listas numeradas para las secuencias y viñetas para las opciones sin orden\.
- Usa enlaces descriptivos en lugar de etiquetas genéricas como «haz clic aquí»\.
- Mantén los títulos jerárquicos\, específicos y paralelos en el mismo nivel\.
- Prefiere un lenguaje literal y sin ambigüedades que conserve el significado al traducirse\.
- Pon las condiciones antes de las instrucciones y los resultados esperados después de los comandos\.

## Valida la semántica\, no la decoración

Las pruebas de documentación deben detectar algo más que la coincidencia de títulos\. Verifican\:

- un H1 y una jerarquía lógica de encabezados\;
- secciones semánticas ordenadas y marcadores de afirmaciones críticas\;
- comandos exactos para el primer éxito e identificadores estables\;
- enlaces relativos y destinos de detalle específicos para cada locale\;
- paridad de insignias de versión con metadatos de runtime\;
- texto alternativo descriptivo en imágenes y alternativas visuales adyacentes\;
- un único ciclo de vida de Mermaid con un equivalente completo en texto\;
- tablas de dos columnas y límites de longitud para párrafos\;
- ausencia de detalles profundos de implementación designados en las páginas de destino\;

## Base de investigación

- [GitHub\: Acerca del archivo README del repositorio](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) define el propósito del README en la primera visita y recomienda mover la documentación extensa a otro lugar\.
- [Diátaxis](https://diataxis.fr/start-here/) separa las necesidades de tutoriales\, guías prácticas\, explicaciones y referencias\.
- [Microsoft\: Contenido fácil de recorrer visualmente](https://learn.microsoft.com/en-us/style-guide/scannable-content/) destaca la estructura con lo importante primero\, los párrafos breves y los puntos de entrada visuales consistentes\.
- [Estilo de documentación de Google para desarrolladores](https://developers.google.com/style/highlights) recomienda la voz activa\, dirigirse directamente al lector\, títulos descriptivos\, accesibilidad y escritura para un público global\.
- [GitHub\: Crear diagramas](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) documenta la compatibilidad con Mermaid en Markdown\.
- [W3C WAI\: Tutorial sobre imágenes](https://www.w3.org/WAI/tutorials/images/) exige alternativas textuales y equivalentes completos para elementos visuales informativos y complejos\.
