<div align="center">

# Better Workflows

O Better Workflows V5.0 RC1 está disponível publicamente: um workflow Auto gratuito e open-source para QA de engenharia de IA e entrega, com evidências atuais, review gates e reconciliação de provedores.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · **Português (Brasil)** · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Explorar a documentação](https://betterworkflows.dev/pt-BR/docs/) · [Abrir o GitHub](https://github.com/stephen-taipei/better-workflows) · [Apoiar com USDT (TRC20)](https://betterworkflows.dev/#sponsor)

</div>

O V5.0 RC1 abrange Codex, Gemini CLI e Qwen Code no macOS × Node 22/24. A qualificação para Claude Code, Linux e Windows foi adiada para o V5.1. A versão GA exige pelo menos 30 dias naturais de canary, 20 inicializações qualificadas consecutivas e três repositórios distintos.

## Leve o trabalho dos agentes<br>até uma conclusão comprovável.

O V5.0 RC1 está disponível publicamente. O Auto verifica o objetivo, o escopo, o repositório e o risco, selecionando em seguida verificações direcionadas ou um workflow de evidências. Mudanças Git usam uma worktree de propriedade da tarefa; a entrega requer autorização e um resultado externo verificado.

## Quatro limites claros entre intenção e conclusão.

Defina o contrato, verifique a origem e as evidências, reconcilie os efeitos externos e só marque como concluído quando o estado final for conhecido.

- **01 · `TaskContract`** — O V5.0 RC1 está disponível publicamente. O Auto verifica o objetivo, o escopo, o repositório e o risco, selecionando em seguida verificações direcionadas ou um workflow de evidências. Mudanças Git usam uma worktree de propriedade da tarefa; a entrega requer autorização e um resultado externo verificado.
- **02 · `evidence`** — O Better Workflows V5.0 RC1 está disponível publicamente: um workflow Auto gratuito e open-source para QA de engenharia de IA e entrega, com evidências atuais, review gates e reconciliação de provedores.
- **03 · `reconciliation`** — Defina o contrato, verifique a origem e as evidências, reconcilie os efeitos externos e só marque como concluído quando o estado final for conhecido.
- **04 · `terminal state`** — Um comando executado não comprova a conclusão; um resultado que pode ser revalidado, sim.

## Início rápido

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## Passe do mapa de arquitetura para casos de uso práticos.

- [Quatro limites claros entre intenção e conclusão.](https://betterworkflows.dev/pt-BR/docs/)
- [Início rápido](https://betterworkflows.dev/pt-BR/docs/quick/)
- [Passe do mapa de arquitetura para casos de uso práticos.](https://betterworkflows.dev/pt-BR/docs/use-cases/)
- [Início rápido — Passe do mapa de arquitetura para casos de uso práticos.](https://betterworkflows.dev/pt-BR/docs/use-cases/quick/)
- [Cinema de evidências](https://betterworkflows.dev/pt-BR/docs/evidence-cinema/)

### Explorar a documentação · `pt-BR`

Esta página de referência tem uma visão geral localizada; o conteúdo interativo ainda não está totalmente traduzido.

- **01 · Quatro limites claros entre intenção e conclusão.** — Defina o contrato, verifique a origem e as evidências, reconcilie os efeitos externos e só marque como concluído quando o estado final for conhecido.
- **02 · Passe do mapa de arquitetura para casos de uso práticos.** — O V5.0 RC1 está disponível publicamente. O Auto verifica o objetivo, o escopo, o repositório e o risco, selecionando em seguida verificações direcionadas ou um workflow de evidências. Mudanças Git usam uma worktree de propriedade da tarefa; a entrega requer autorização e um resultado externo verificado.
- **03 · Início rápido** — O Better Workflows V5.0 RC1 está disponível publicamente: um workflow Auto gratuito e open-source para QA de engenharia de IA e entrega, com evidências atuais, review gates e reconciliação de provedores.

- [`Quatro limites claros entre intenção e conclusão.`](https://betterworkflows.dev/docs/reference/pt-BR/index.html) · `pt-BR`
- [`Início rápido`](https://betterworkflows.dev/docs/reference/pt-BR/preview.html) · `pt-BR`
- [`Passe do mapa de arquitetura para casos de uso práticos.`](https://betterworkflows.dev/docs/reference/pt-BR/use-cases/index.html) · `pt-BR`
- [`Início rápido — Passe do mapa de arquitetura para casos de uso práticos.`](https://betterworkflows.dev/docs/reference/pt-BR/use-cases/preview.html) · `pt-BR`
- [`Cinema de evidências`](https://betterworkflows.dev/docs/reference/pt-BR/evidence-cinema/index.html) · `pt-BR`

- [Explorar a documentação · `pt-BR`](../details/pt-BR.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### Explorar a documentação · `en`



### Explorar a documentação · `pt-BR`

- [Política de segurança](pt-BR/security.md) · `pt-BR`
- [Como contribuir](pt-BR/contributing.md) · `pt-BR`
- [Governança](pt-BR/governance.md) · `pt-BR`
- [Código de conduta](pt-BR/conduct.md) · `pt-BR`
- [Avisos sobre terceiros](pt-BR/notices.md) · `pt-BR`
- [Plano de qualidade para README](pt-BR/readme-quality.md) · `pt-BR`
- [Sistema de cores editorial](pt-BR/color-system.md) · `pt-BR`
- [Arquitetura](pt-BR/architecture.md) · `pt-BR`
- [Segurança](pt-BR/security-guide.md) · `pt-BR`
- [Referência de CLI](pt-BR/cli-reference.md) · `pt-BR`
- [Primeiros passos](pt-BR/getting-started.md) · `pt-BR`
- [Fluxos de trabalho](pt-BR/workflows.md) · `pt-BR`
- [Suporte](pt-BR/support.md) · `pt-BR`

## Ajude a manter o Better Workflows.

Um apoio único contribui para manutenção open source, documentação, localização em 41 idiomas e hospedagem do site. Não compra associação nem prioridade no roadmap ou suporte.

[Apoiar com USDT (TRC20)](https://betterworkflows.dev/#sponsor)

---

Um comando executado não comprova a conclusão; um resultado que pode ser revalidado, sim.
