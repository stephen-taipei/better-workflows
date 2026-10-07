<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Política de segurança

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · **Português \(Brasil\)** · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Como contribuir](contributing.md) · [Código de conduta](conduct.md) · **Segurança** · [Governança](governance.md) · [Suporte](support.md)

[Visão geral em 41 versões localizadas e pontos de acesso oficiais na Web](../../../docs/LANGUAGES.md)\. A versão em inglês desta política normativa de segurança continua sendo a referência canônica\.

Se a única fonte de evidências proposta contiver histórico privado ou material operacional sensível do qual não seja possível remover os dados sensíveis\, não o colete nem transmita\. Registre apenas uma justificativa `REJECTED_WITH_EVIDENCE` com os dados sensíveis ocultados\.

## Versões com suporte

| Versão | Suporte |
| --- | --- |
| Versão publicada mais recente e compilação imutável do Codex | Com suporte |
| Versões anteriores do cache imutável | Destinos de reversão\; as correções não são aplicadas retroativamente\, salvo anúncio explícito |
| Derivações ainda não lançadas ou conteúdo do cache modificado | Sem suporte |

## Relatar uma vulnerabilidade

Use o [relato privado de vulnerabilidades do GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. Não abra uma questão pública para uma suspeita de vulnerabilidade\.

Inclua\:

- a versão e a compilação do plugin afetadas\;
- o ambiente e a versão do Node\.js\;
- os passos mínimos para reproduzir o problema\;
- o limite de segurança esperado e o observado\;
- o impacto e quaisquer soluções alternativas conhecidas\;
- a indicação de que o relatório contém ou não material confidencial\.

Não inclua credenciais ativas\, chaves de assinatura\, tokens de provedores\, instruções privadas em formato bruto nem dados pessoais de terceiros\.

## Resposta

O responsável pela manutenção confirmará o recebimento de um relatório utilizável\, validará seu escopo e coordenará a correção e a divulgação\. Não há promessa de SLA com prazo de resposta fixo\. Resultados desconhecidos ou não reconciliados permanecem bloqueados\, recusando\-se a continuidade enquanto não forem verificados\.

## Limites de segurança

O Better Workflows pressupõe um repositório local\, uma máquina hospedeira e uma cadeia de ferramentas executáveis confiáveis\. O Modelo de Permissões do Node é uma defesa em profundidade e não é um ambiente isolado no nível do sistema operacional para código malicioso\. Consulte o [guia de segurança](security-guide.md) completo\.
