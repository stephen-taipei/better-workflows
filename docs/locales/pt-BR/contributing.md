<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Como contribuir

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · **Português \(Brasil\)** · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Obrigado por ajudar a melhorar o Better Workflows\.

[README](../../../README.md) · **Como contribuir** · [Código de conduta](conduct.md) · [Segurança](security.md) · [Governança](governance.md) · [Suporte](support.md)

[Visão geral em 41 versões localizadas e pontos de acesso oficiais na Web](../../../docs/LANGUAGES.md)\. A versão em inglês desta política normativa de contribuição continua sendo a referência canônica\.

## Antes de começar

- Use uma issue ou discussão primeiro para um novo contrato público\, uma mudança no comportamento público do Auto\, um limite de segurança ou uma grande alteração arquitetural\.
- Mantenha cada pull request focado em um único resultado\.
- Nunca faça commit de credenciais\, prompts privados\, histórico bruto de conversas\, chaves de assinatura do host\, comprovantes de provedores ou atestações assinadas\.
- Relate vulnerabilidades de forma privada conforme descrito em [SECURITY\.md](security.md)\.

## Configuração do ambiente de desenvolvimento

Requisitos\:

- Node\.js 24 ou mais recente\;
- nenhuma dependência de terceiros em tempo de execução\;
- uma ramificação limpa baseada na ramificação de destino atual\.

Execute todas as verificações básicas locais\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Regras de alteração

1. Preserve mutações de propriedade do Root e limites de efeitos colaterais fail\-closed\.
2. Quando o comportamento público do Auto mudar\, atualize seu template e skill\, catálogo de entrypoints\, CLI\, testes e toda a documentação afetada em conjunto\.
3. Rejeite opções de CLI desconhecidas e campos de schema desconhecidos\.
4. Mantenha o estado de runtime privado fora do repositório\.
5. Adicione testes negativos para cada novo safety gate\.
6. Não modifique uma versão existente e imutável do plugin\-cache\. Um bundle alterado requer uma nova versão de build e verificação exata do digest de origem\/cache\.

Na organização exclusiva do README\, mantenha a página raiz fácil de percorrer e coloque os contratos detalhados no arquivo correspondente em [`docs/guide/`](../../../docs/guide/)\.

## Lista de verificação da solicitação de integração

- [ ] O escopo e os objetivos excluídos estão explícitos\.
- [ ] O comportamento e os limites de segurança estão documentados\.
- [ ] Os testes focados cobrem os caminhos de sucesso e de falha\.
- [ ] A suíte completa de testes e `sbw eval` passam\.
- [ ] `git diff --check` passa\.
- [ ] As alterações de versão\/cache seguem as regras de publicação imutável\, quando aplicável\.
- [ ] Não são incluídos segredos\, estado privado nem comprovantes externos\.

Dê preferência a registros de alterações pequenos e fáceis de revisar\. Não combine uma limpeza sem relação com uma mudança de comportamento\.
