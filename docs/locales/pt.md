<div align="center">

# Better Workflows

O Better Workflows V5.0 RC1 está disponível publicamente: um fluxo de trabalho Auto gratuito e open source para QA e entrega de engenharia de IA, com evidências atualizadas, review gates e reconciliação de fornecedores.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · **Português** · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Explorar a documentação](https://betterworkflows.dev/pt/docs/) · [Abrir o GitHub](https://github.com/stephen-taipei/better-workflows) · [Apoiar com USDT (TRC20)](https://betterworkflows.dev/#sponsor)

</div>

O V5.0 RC1 cobre o Codex, Gemini CLI e Qwen Code em macOS × Node 22/24. A qualificação de Claude Code, Linux e Windows foi adiada para a V5.1. O GA requer pelo menos 30 dias naturais de canary, 20 arranques elegíveis consecutivos e três repositórios distintos.

## Leve o trabalho dos agentes<br>até uma conclusão comprovável.

O V5.0 RC1 está disponível publicamente. O Auto verifica o objetivo, o âmbito, o repositório e o risco, selecionando depois verificações direcionadas ou um fluxo de trabalho de evidência. As alterações Git usam uma worktree pertencente à tarefa; a entrega requer autorização e um resultado externo verificado.

## Quatro limites explícitos entre intenção e conclusão.

Defina o contrato, verifique a origem e a evidência, reconcilie os efeitos externos e declare a conclusão apenas quando o estado terminal for conhecido.

- **01 · `TaskContract`** — O V5.0 RC1 está disponível publicamente. O Auto verifica o objetivo, o âmbito, o repositório e o risco, selecionando depois verificações direcionadas ou um fluxo de trabalho de evidência. As alterações Git usam uma worktree pertencente à tarefa; a entrega requer autorização e um resultado externo verificado.
- **02 · `evidence`** — O Better Workflows V5.0 RC1 está disponível publicamente: um fluxo de trabalho Auto gratuito e open source para QA e entrega de engenharia de IA, com evidências atualizadas, review gates e reconciliação de fornecedores.
- **03 · `reconciliation`** — Defina o contrato, verifique a origem e a evidência, reconcilie os efeitos externos e declare a conclusão apenas quando o estado terminal for conhecido.
- **04 · `terminal state`** — Executar um comando não comprova a conclusão; um resultado revalidável comprova.

## Início rápido

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## Passe do mapa de arquitetura aos casos de utilização práticos.

- [Quatro limites explícitos entre intenção e conclusão.](https://betterworkflows.dev/pt/docs/)
- [Início rápido](https://betterworkflows.dev/pt/docs/quick/)
- [Passe do mapa de arquitetura aos casos de utilização práticos.](https://betterworkflows.dev/pt/docs/use-cases/)
- [Início rápido — Passe do mapa de arquitetura aos casos de utilização práticos.](https://betterworkflows.dev/pt/docs/use-cases/quick/)
- [Cinema de evidências](https://betterworkflows.dev/pt/docs/evidence-cinema/)

### Explorar a documentação · `pt`

Esta página de referência tem uma visão geral localizada; o conteúdo interativo ainda não está totalmente traduzido.

- **01 · Quatro limites explícitos entre intenção e conclusão.** — Defina o contrato, verifique a origem e a evidência, reconcilie os efeitos externos e declare a conclusão apenas quando o estado terminal for conhecido.
- **02 · Passe do mapa de arquitetura aos casos de utilização práticos.** — O V5.0 RC1 está disponível publicamente. O Auto verifica o objetivo, o âmbito, o repositório e o risco, selecionando depois verificações direcionadas ou um fluxo de trabalho de evidência. As alterações Git usam uma worktree pertencente à tarefa; a entrega requer autorização e um resultado externo verificado.
- **03 · Início rápido** — O Better Workflows V5.0 RC1 está disponível publicamente: um fluxo de trabalho Auto gratuito e open source para QA e entrega de engenharia de IA, com evidências atualizadas, review gates e reconciliação de fornecedores.

- [`Quatro limites explícitos entre intenção e conclusão.`](https://betterworkflows.dev/docs/reference/pt/index.html) · `pt`
- [`Início rápido`](https://betterworkflows.dev/docs/reference/pt/preview.html) · `pt`
- [`Passe do mapa de arquitetura aos casos de utilização práticos.`](https://betterworkflows.dev/docs/reference/pt/use-cases/index.html) · `pt`
- [`Início rápido — Passe do mapa de arquitetura aos casos de utilização práticos.`](https://betterworkflows.dev/docs/reference/pt/use-cases/preview.html) · `pt`
- [`Cinema de evidências`](https://betterworkflows.dev/docs/reference/pt/evidence-cinema/index.html) · `pt`

- [Explorar a documentação · `pt`](../details/pt.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### Explorar a documentação · `en`



### Explorar a documentação · `pt`

- [Política de segurança](pt/security.md) · `pt`
- [Contribuir](pt/contributing.md) · `pt`
- [Governação](pt/governance.md) · `pt`
- [Código de conduta](pt/conduct.md) · `pt`
- [Avisos sobre terceiros](pt/notices.md) · `pt`
- [Modelo de qualidade para README](pt/readme-quality.md) · `pt`
- [Sistema de cores editorial](pt/color-system.md) · `pt`
- [Arquitetura](pt/architecture.md) · `pt`
- [Segurança](pt/security-guide.md) · `pt`
- [Referência de CLI](pt/cli-reference.md) · `pt`
- [Primeiros passos](pt/getting-started.md) · `pt`
- [Fluxos de trabalho](pt/workflows.md) · `pt`
- [Apoio](pt/support.md) · `pt`

## Ajude a manter o Better Workflows.

Um apoio pontual contribui para o código aberto, documentação, localização em 41 idiomas e alojamento do site. Não compra filiação nem prioridade no roadmap ou suporte.

[Apoiar com USDT (TRC20)](https://betterworkflows.dev/#sponsor)

---

Executar um comando não comprova a conclusão; um resultado revalidável comprova.
