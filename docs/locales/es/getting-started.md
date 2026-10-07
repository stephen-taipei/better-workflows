<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Primeros pasos

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · **Español** · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 cubre Codex\, Gemini CLI y Qwen Code en macOS × Node 22\/24\. La calificación de Claude Code\, Linux y Windows se pospone a V5\.1\. GA requiere al menos 30 días naturales de canary\, 20 inicios válidos consecutivos y tres repositorios distintos\.

| [Resumen](../../../README.md) | [Detalles](../../../docs/details/en.md) | **Inicio rápido** | [Flujos de trabajo](workflows.md) | [Arquitectura](architecture.md) | [Seguridad](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Resumen en 41 versiones localizadas y puntos de acceso web oficiales](../../../docs/LANGUAGES.md)\. Los comandos y los identificadores conservan su forma canónica en inglés\.

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) está disponible públicamente\. El alcance de su lanzamiento cubre únicamente Auto\, con Codex\, Gemini CLI y Qwen Code en macOS Node 22\/24\. La cualificación para Linux y Windows se pospone a V5\.1\, al igual que la de Claude Code\. GA `5.0.0` sigue pendiente hasta registrar al menos 30 días naturales en canary\, 20 inicios válidos consecutivos y tres repositorios distintos\.

## Requisitos

- Node\.js 22\.14 o posterior para el asistente integrado `sbw`\.
- Un repositorio local de confianza\. Better Workflows no afirma aislar mediante sandbox código malicioso de repositorios\.

La raíz de estado de v4 es independiente de la plataforma de agentes\: `SBW_STATE_ROOT` tiene prioridad cuando está definida\, después se usa `XDG_STATE_HOME/better-workflows` y\, en caso contrario\, `~/.better-workflows`\. Ya no se sitúa de forma predeterminada bajo `CODEX_HOME`\. Para seguir usando un estado existente de v3 para Codex sin moverlo\, establece `SBW_STATE_ROOT` explícitamente en ese directorio exacto `<CODEX_HOME>/sbw` antes de invocar `sbw`\.

V5\.0 GA \(`5.0.0`\) sigue pendiente\. Los comandos de instalación indicados abajo se dirigen a V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\)\, disponible públicamente\.

## Instalación

### Codex — referencia recomendada

```bash
# Install the publicly available V5.0.rc1 release candidate.
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
node plugins/better-workflows/scripts/sbw.mjs version --json
node plugins/better-workflows/scripts/sbw.mjs update status --json
# Before the first check, status is unknown. Choose one update mode; manual is
# the default. off disables network access even for an explicit check, while an
# explicit check can query manual or automatic mode without the 24-hour throttle.
node plugins/better-workflows/scripts/sbw.mjs update configure --mode off
node plugins/better-workflows/scripts/sbw.mjs update configure --mode manual
node plugins/better-workflows/scripts/sbw.mjs update configure --mode automatic
node plugins/better-workflows/scripts/sbw.mjs update check --json
# automatic is opt-in, interactive-only, best effort, and at most once/24h;
# success and failure both consume the slot. Automatic checks are skipped in CI,
# --json, and non-interactive paths. It never auto-installs; only fixed public
# metadata is used.
```

Abre una nueva tarea de Codex después de la instalación para que se actualice su catálogo de habilidades\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI copia la extensión\. Reinicia la sesión después de la instalación\; usa `gemini extensions update better-workflows` para actualizarla más adelante\.

El contexto de la extensión resuelve la ubicación del puente a partir de la ruta de su propio código fuente cargado\, no del directorio de trabajo de tu proyecto\. Para una instalación estándar a nivel de usuario\, la comprobación manual equivalente es\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Para una extensión enlazada o limitada al espacio de trabajo\, usa la raíz exacta de la extensión que muestra la plataforma de agentes\. No la sustituyas por una copia de trabajo con un nombre parecido\.

### Qwen Code

Fija el lanzamiento a una versión concreta antes de instalar la copia local de la extensión\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code también copia la extensión\, así que reinicia la sesión después de la instalación y usa `qwen extensions update better-workflows` para las actualizaciones posteriores\.

Para una instalación estándar a nivel de usuario\, la comprobación manual equivalente del puente es\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

La misma regla sobre la raíz exacta se aplica a las instalaciones enlazadas o limitadas al espacio de trabajo\.

## Usar Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Cada entrada conserva el Goal solicitado\. Un Goal activo que no esté relacionado debe editarse o borrarse explícitamente\; nunca se sustituye de forma silenciosa\.

## Previsualiza la ruta

La instantánea de capacidades es de solo lectura y no activa el inicio de sesión con el proveedor ni una comprobación semántica del modelo\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Para un traspaso que se pueda revisar\, registra y utiliza un único registro verificable privado y de un solo uso\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Los registros caducan después de 24 horas\, y se rechaza su uso por seguridad ante una reutilización o desviaciones en el espacio de trabajo\, el alcance\, Profiles\, el catálogo\, las capacidades o el paquete del complemento\.

## Verifica la instalación

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Antes de modificar un repositorio

Auto empieza con una comprobación preliminar del espacio de trabajo que solo realiza lecturas\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Las tareas ajenas a Git y las de solo lectura no crean un worktree\. Una tarea de Git que realice cambios debe crear o reutilizar un `TaskWorkspaceLeaseV1` que pertenezca a la tarea\. Si el directorio de trabajo de origen contiene cambios sin confirmar en un commit\, el proceso se detiene antes de cualquier stash\, copia\, commit o creación de worktree\. Un HEAD desacoplado o la ausencia de un destino requieren un destino de integración explícito\. Los destinos protegidos o remotos pasan a una entrega mediante PR sujeta a las reglas de gobernanza\.

Si Codex u otra plataforma de agentes ya creó el worktree limpio de la tarea actual\, regístralo antes de editar\, en lugar de crear un worktree anidado\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

El registro exige una rama de tarea independiente con el patrón `codex/*` en la revisión base sin cambios\, el mismo directorio común de Git y una copia de trabajo limpia de la fuente\. Better Workflows usa el worktree\, pero conserva la rama y la ruta que pertenecen a la plataforma de agentes durante la limpieza\. Para un destino protegido\, ejecuta primero el flujo de evidencias y\, después\, vincula sus registros verificables exactos de fusión de PR y sincronización remota con `workspace reconcile --run-id <run-id>`\.

Siguiente paso\: [elegir el flujo de trabajo adecuado](workflows.md) o consultar la [referencia de la CLI](cli-reference.md)\.
