<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Contribuir

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · **Português** · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Obrigado por ajudar a melhorar o Better Workflows\.

[README](../../../README.md) · **Contribuir** · [Código de conduta](conduct.md) · [Segurança](security.md) · [Governação](governance.md) · [Apoio](support.md)

[Visão geral em 41 versões localizadas e pontos de acesso oficiais na Web](../../../docs/LANGUAGES.md)\. A versão inglesa desta política normativa de contribuição continua a ser a referência canónica\.

## Antes de começar

- Use primeiro um issue ou discussão para um novo contrato público\, uma alteração ao comportamento público do Auto\, um limite de segurança ou uma grande mudança arquitetural\.
- Mantenha cada pull request focado num único resultado\.
- Nunca envie credenciais\, prompts privados\, histórico de conversação em bruto\, chaves de assinatura do anfitrião\, recibos de fornecedor ou atestações assinadas\.
- Reporte vulnerabilidades de forma privada conforme descrito em [SECURITY\.md](security.md)\.

## Preparação do ambiente de desenvolvimento

Requisitos\:

- Node\.js 24 ou mais recente\;
- nenhuma dependência de terceiros em tempo de execução\;
- um ramo limpo baseado no ramo de destino atual\.

Execute todas as verificações de base locais\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Regras de alteração

1. Preserve a mutação pertencente ao Root e os limites de efeitos secundários fail\-closed\.
2. Quando o comportamento público do Auto mudar\, atualize em conjunto o seu modelo e skill\, o catálogo de pontos de entrada\, a CLI\, os testes e toda a documentação afetada\.
3. Rejeite opções de CLI desconhecidas e campos de esquema desconhecidos\.
4. Mantenha o estado de runtime privado fora do repositório\.
5. Adicione testes negativos para cada novo safety gate\.
6. Não altere uma versão imutável existente da cache do plugin\. Um pacote alterado requer uma nova versão de compilação e verificação exata do digest da fonte\/cache\.

Na organização exclusiva do README\, mantenha a página de raiz fácil de percorrer e coloque os contratos pormenorizados no ficheiro correspondente em [`docs/guide/`](../../../docs/guide/)\.

## Lista de verificação do pedido de integração

- [ ] O âmbito e os objetivos excluídos estão explícitos\.
- [ ] O comportamento e os limites de segurança estão documentados\.
- [ ] Os testes específicos abrangem os percursos de sucesso e de falha\.
- [ ] A bateria completa de testes e `sbw eval` passam\.
- [ ] `git diff --check` passa\.
- [ ] As alterações de versão\/cache seguem as regras de publicação imutável\, quando aplicável\.
- [ ] Não são incluídos segredos\, estado privado nem comprovativos externos\.

Dê preferência a registos de alterações pequenos e fáceis de rever\. Não junte uma limpeza sem relação com uma alteração de comportamento\.
