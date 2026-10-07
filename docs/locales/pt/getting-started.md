<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Primeiros passos

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · **Português** · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

O V5\.0 RC1 cobre o Codex\, Gemini CLI e Qwen Code em macOS × Node 22\/24\. A qualificação de Claude Code\, Linux e Windows foi adiada para a V5\.1\. O GA requer pelo menos 30 dias naturais de canary\, 20 arranques elegíveis consecutivos e três repositórios distintos\.

| [Visão geral](../../../README.md) | [Detalhes](../../../docs/details/en.md) | **Início rápido** | [Fluxos de trabalho](workflows.md) | [Arquitetura](architecture.md) | [Segurança](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Visão geral em 41 versões localizadas e pontos de acesso oficiais na Web](../../../docs/LANGUAGES.md)\. Os comandos e identificadores mantêm a forma canónica em inglês\.

O V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) está disponível publicamente\. O âmbito do lançamento abrange apenas o Auto\, com o Codex\, Gemini CLI e Qwen Code em macOS Node 22\/24\. A qualificação para Linux e Windows é adiada para o V5\.1\, tal como a qualificação do Claude Code\. O GA `5.0.0` permanece pendente até que sejam registados pelo menos 30 dias naturais de canary\, 20 arranques elegíveis consecutivos e três repositórios distintos\.

## Requisitos

- Node\.js 22\.14 ou mais recente para o utilitário `sbw` incluído\.
- Um repositório local de confiança\. O Better Workflows não afirma isolar em sandbox código malicioso de repositórios\.

O diretório raiz do estado da v4 é independente da plataforma\: `SBW_STATE_ROOT` tem prioridade quando está definido\, seguido de `XDG_STATE_HOME/better-workflows`\; caso contrário\, usa\-se `~/.better-workflows`\. Por predefinição\, já não fica sob `CODEX_HOME`\. Para continuar a usar o estado existente do Codex v3 sem o mover\, defina explicitamente `SBW_STATE_ROOT` como esse diretório exato `<CODEX_HOME>/sbw` antes de invocar `sbw`\.

O V5\.0 GA \(`5.0.0`\) permanece pendente\. Os comandos de instalação abaixo visam o V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) disponível publicamente\.

## Instalação

### Codex — referência recomendada

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

Abra uma nova tarefa do Codex após a instalação para atualizar o respetivo catálogo de competências\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

O Gemini CLI copia a extensão\. Reinicie a sessão após a instalação\; use `gemini extensions update better-workflows` para a atualizar posteriormente\.

O contexto da extensão determina a localização da ponte a partir do próprio caminho de origem carregado\, e não do diretório de trabalho do projeto\. Para uma instalação padrão no âmbito do utilizador\, a verificação manual equivalente é\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Para uma extensão ligada ou instalada no âmbito do espaço de trabalho\, use o diretório raiz exato da extensão apresentado pela plataforma\. Não o substitua por um checkout com um nome semelhante\.

### Qwen Code

Fixe a versão de lançamento antes de instalar a cópia local da extensão\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

O Qwen Code também copia a extensão\, pelo que deve reiniciar a sessão após a instalação e usar `qwen extensions update better-workflows` nas atualizações posteriores\.

Para uma instalação padrão no âmbito do utilizador\, a verificação manual equivalente da ponte é\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

A mesma regra de correspondência exata do diretório raiz aplica\-se a instalações ligadas ou no âmbito do espaço de trabalho\.

## Usar o Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Cada opção de entrada preserva o Goal solicitado\. Um Goal ativo sem relação com a tarefa tem de ser editado ou eliminado explicitamente\; nunca é substituído silenciosamente\.

## Pré\-visualizar o percurso

O instantâneo de capacidades é apenas de leitura e não desencadeia o início de sessão no fornecedor nem uma sondagem semântica do modelo\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Para uma passagem de trabalho que possa ser revista\, registe e utilize um registo verificável privado\, de utilização única\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Os registos verificáveis expiram ao fim de 24 horas e a sua utilização é recusada se forem reutilizados ou se houver desvios no espaço de trabalho\, âmbito\, Profiles\, catálogo\, capacidades ou pacote do plugin\.

## Verificar a instalação

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Antes de alterar um repositório

O Auto começa com uma verificação prévia do espaço de trabalho\, apenas de leitura\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

As tarefas que não usam Git e as tarefas apenas de leitura não criam uma worktree\. Uma tarefa Git que faça alterações tem de criar ou reutilizar um `TaskWorkspaceLeaseV1` pertencente à tarefa\. Se o diretório de trabalho da origem tiver alterações ainda não registadas num commit\, o processo para antes de qualquer stash\, cópia\, commit ou criação de worktree\. Um HEAD desligado de um ramo ou a ausência de um destino exige um destino de integração explícito\. Os destinos protegidos ou remotos passam para um processo de entrega por PR sujeito a governação\.

Se o Codex ou outra plataforma já tiver criado uma worktree limpa para a tarefa atual\, registe\-a antes de editar\, em vez de criar uma worktree aninhada\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

O registo exige um ramo de tarefa `codex/*` distinto na base inalterada\, o mesmo diretório comum do Git e um checkout da origem limpo\. O Better Workflows usa a worktree\, mas preserva o ramo e o caminho pertencentes à plataforma durante a limpeza\. Para um destino protegido\, execute primeiro o fluxo de trabalho de evidências e depois associe os seus registos verificáveis exatos de integração do PR e de sincronização remota com `workspace reconcile --run-id <run-id>`\.

A seguir\: [escolha o fluxo de trabalho certo](workflows.md) ou consulte a [referência da CLI](cli-reference.md)\.
