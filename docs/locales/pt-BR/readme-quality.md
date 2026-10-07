<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Plano de qualidade para README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · **Português \(Brasil\)** · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Visão geral em 41 versões localizadas e pontos de acesso oficiais na Web](../../../docs/LANGUAGES.md)\. A versão em inglês deste plano editorial continua sendo a referência canônica\.

Um README do Better Workflows é uma página de apresentação\, não um manual de referência condensado\. Sua função é ajudar o leitor a responder a cinco perguntas\, nesta ordem\:

1. O que é isto e serve para mim\?
2. Que problema resolve\?
3. Por que devo confiar em suas afirmações\?
4. Qual é o caminho mais curto para um primeiro sucesso\?
5. Para onde devo seguir\?

Este plano define o contrato narrativo\, visual\, de localização e de validação para cada README do repositório\. A fonte legível por máquina é [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Comece pela decisão do leitor

O GitHub apresenta um README antes da maior parte do conteúdo do repositório\. Por isso\, a primeira tela deve estabelecer a promessa do produto\, o público\-alvo e uma próxima ação com limites definidos\. Ela não deve começar pela arquitetura interna\, por uma referência completa de comandos nem por detalhes de recuperação de lançamentos\.

Escreva para estas tarefas do leitor\:

- **Novo visitante\:** decida rapidamente se o Better Workflows resolve um problema relevante\.
- **Novo usuário\:** instale o plugin e alcance uma rota automática bem\-sucedida\.
- **Avaliador\:** compreenda o limite de autoridade e o comportamento fail\-closed\.
- **Operador recorrente\:** vá direto para uma resposta sobre workflow\, segurança\, arquitetura ou CLI\.
- **Contribuidor ou tradutor\:** encontre o contrato canônico\, comandos de desenvolvimento\, suporte e governança\.

## Use uma narrativa de causa e efeito

Os cinco README de apresentação usam a mesma sequência semântica de oito partes\. Os títulos podem ser idiomáticos em cada idioma\, mas a jornada do leitor não muda\.

| Seção | Pergunta do leitor e função narrativa |
| --- | --- |
| Promessa e público | O que é o Better Workflows\, por que existe e a quem se destina\? |
| Do problema ao resultado | O que dá errado quando intenção\, autoridade\, evidências e resultado do provedor são confundidos\? |
| Prova e limites | Quais garantias tornam o resultado proposto confiável\? |
| Primeiro sucesso | Qual é o caminho completo mais curto entre a instalação e o resultado\? |
| Escolha o próximo caminho | Qual fluxo de trabalho ou documento corresponde ao objetivo do leitor\? |
| Ciclo de vida | Como um objetivo chega a uma conclusão reconciliada — ou é interrompido com segurança\? |
| Confiança e limites | O que o sistema nunca pode inferir\, autorizar ou afirmar\? |
| Aprenda\, obtenha ajuda e contribua | Onde estão a documentação aprofundada\, o suporte\, a governança\, o desenvolvimento e a licença\? |

Esta ordem oferece uma progressão prática\:

- **Contexto\:** o trabalho orientado por prompts pode expressar intenção sem comprovar autoridade nem estado\.
- **Tensão\:** os efeitos colaterais transformam essa lacuna em risco para a entrega\.
- **Resolução\:** o Better Workflows vincula objetivo\, escopo\, evidências\, revisão\, ação e reconciliação com o provedor\.
- **Prova\:** garantias e limites explícitos mostram como a resolução funciona\.
- **Ação\:** o leitor chega a um primeiro sucesso antes de encontrar detalhes aprofundados da implementação\.
- **Continuação\:** rotas baseadas no papel e no resultado levam o leitor ao tutorial\, guia prático\, explicação ou referência adequados\.

## Separe o conteúdo de apresentação da documentação aprofundada

Use o README para informações relevantes à decisão\. Direcione o aprofundamento conforme a finalidade\:

- [Primeiros passos](getting-started.md) é o tutorial de primeiro uso\.
- [Fluxos de trabalho](workflows.md) é o guia prático para selecionar resultados\.
- [Arquitetura](architecture.md) explica o plano de controle e as vantagens e desvantagens das alternativas\.
- [Segurança](security-guide.md) explica a autoridade\, a privacidade\, as atestações e o comportamento que bloqueia a operação na ausência de verificação válida\.
- [Referência da CLI](cli-reference.md) é a referência de comandos\.
- As páginas localizadas `docs/details/*.md` preservam os detalhes traduzidos de forma abrangente\.

Não duplique na página de apresentação a recuperação do cache\, a posse dos bloqueios\, a semântica completa do transporte para os provedores\, listas exaustivas de comandos ou o histórico de alterações da implementação\. Uma afirmação concisa de segurança permanece na própria página\; seu aprofundamento auditável pertence ao guia canônico\.

Essa separação segue a distinção do Diátaxis entre tutoriais\, guias práticos\, explicações e referências\. Uma única página não pode otimizar simultaneamente essas quatro necessidades do leitor\.

## Faça cada elemento visual justificar sua presença

Use um elemento visual apenas quando tornar relações\, hierarquia ou transições de estado substancialmente mais fáceis de entender do que um texto\.

As páginas de apresentação permitem dois elementos visuais\:

1. **Arquitetura dos limites de autoridade\:** esclarece quais camadas definem a intenção\, os fatos atuais\, a autoridade das ferramentas\, as novas tentativas limitadas e o estado somente de leitura\.
2. **Ciclo do objetivo à conclusão\:** esclarece onde as evidências são verificadas\, onde os efeitos colaterais são autorizados e onde um estado desconhecido interrompe o progresso\.

Cada elemento visual deve incluir\:

- texto alternativo conciso e significativo\;
- um equivalente textual adjacente que preserve a conclusão quando o elemento visual estiver oculto ou o Mermaid não for renderizado\;
- texto real para os rótulos essenciais\, sempre que possível\;
- uma pergunta estável do leitor que justifique manter o elemento visual atualizado\.

Não acrescente capturas de tela decorativas\, imagens carregadas de texto nem diagramas que apenas dupliquem uma lista curta\. Limite as tabelas de seleção a duas colunas concisas para que continuem utilizáveis em telas estreitas\.

## Preserve o significado entre idiomas

O inglês é a referência semântica\, não uma meta de quantidade de linhas\. O chinês tradicional\, o chinês simplificado\, o japonês e o coreano devem soar naturais para um leitor nativo\, preservando o mesmo contrato\.

Os seguintes elementos devem permanecer equivalentes\:

- as oito seções semânticas e sua ordem\;
- os comandos para o primeiro sucesso e os identificadores do produto\;
- as cinco afirmações sobre autoridade\, evidências\, estado desconhecido\, prompts e privacidade\;
- os destinos de fluxos de trabalho\, segurança\, arquitetura\, CLI\, suporte\, governança\, desenvolvimento e licença\;
- a finalidade dos elementos visuais\, as etapas do ciclo de vida e as alternativas textuais\;
- a origem da versão e a política de selos\.

Títulos\, limites de frases\, pontuação\, exemplos e chamadas para ação podem ser idiomáticos\. Nunca traduza comandos\, seletores\, identificadores de evidências nem semântica de segurança\.

## Escreva para leitura rápida e tradução

- Comece pelo resultado do leitor e coloque os termos importantes no início dos títulos e parágrafos\.
- Use a voz ativa e identifique quem é responsável por cada ação\.
- Dirija\-se diretamente ao leitor ao descrever procedimentos\.
- Mantenha os parágrafos curtos e dê a cada um uma única função\.
- Use listas numeradas para sequências e listas com marcadores para escolhas sem ordem sequencial\.
- Use links descritivos em vez de rótulos genéricos como “clique aqui”\.
- Mantenha os títulos hierárquicos\, específicos e paralelos no mesmo nível\.
- Prefira linguagem literal e inequívoca que preserve o significado na tradução\.
- Coloque as condições antes das instruções e os resultados esperados depois dos comandos\.

## Valide a semântica\, não a decoração

Os testes da documentação devem detectar mais do que títulos correspondentes\. Eles verificam\:

- um H1 e uma hierarquia lógica de cabeçalhos\;
- seções semânticas ordenadas e marcadores de declarações críticas\;
- comandos exatos de primeiro sucesso e identificadores estáveis\;
- links relativos e destinos detalhados específicos de cada idioma\;
- paridade de badges de versão com metadados de runtime\;
- textos alternativos \(alt\) significativos para imagens e fallbacks visuais adjacentes\;
- um único ciclo de vida Mermaid com um equivalente textual completo\;
- tabelas de duas colunas e orçamentos para o comprimento de parágrafos\;
- ausência de detalhes profundos designados de implementação nas landing pages\;

## Base de pesquisa

- [GitHub\: Sobre o arquivo README do repositório](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) define a finalidade do README na primeira visita e recomenda mover a documentação extensa para outro local\.
- [Diátaxis](https://diataxis.fr/start-here/) separa as necessidades de tutorial\, guia prático\, explicação e referência\.
- [Microsoft\: Conteúdo de leitura rápida](https://learn.microsoft.com/en-us/style-guide/scannable-content/) enfatiza uma estrutura que apresenta primeiro o mais importante\, parágrafos curtos e pontos de entrada visuais consistentes\.
- [Estilo da documentação para desenvolvedores do Google](https://developers.google.com/style/highlights) recomenda voz ativa\, tratamento direto do leitor\, títulos descritivos\, acessibilidade e escrita para um público global\.
- [GitHub\: Criar diagramas](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) documenta o suporte ao Mermaid em Markdown\.
- [W3C WAI\: Tutorial sobre imagens](https://www.w3.org/WAI/tutorials/images/) exige alternativas textuais e equivalentes completos para elementos visuais informativos e complexos\.
