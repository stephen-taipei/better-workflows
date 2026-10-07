<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Modelo de qualidade para README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · **Português** · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Visão geral em 41 versões localizadas e pontos de acesso oficiais na Web](../../../docs/LANGUAGES.md)\. A versão inglesa deste modelo editorial continua a ser a referência canónica\.

Um README do Better Workflows é uma página de entrada\, não um manual de referência condensado\. A sua função é ajudar quem lê a responder a cinco perguntas\, por esta ordem\:

1. O que é isto e destina\-se a mim\?
2. Que problema resolve\?
3. Porque devo confiar nas suas afirmações\?
4. Qual é o caminho mais curto para um primeiro sucesso\?
5. Para onde devo seguir\?

Este modelo define o contrato narrativo\, visual\, de localização e de validação para cada README do repositório\. A fonte legível por máquina é [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Comece pela decisão de quem lê

O GitHub apresenta um README antes da maior parte do conteúdo do repositório\. O primeiro ecrã deve\, por isso\, estabelecer a promessa do produto\, o público\-alvo e uma próxima ação com limites definidos\. Não deve começar pela arquitetura interna\, por uma referência completa de comandos nem por pormenores de recuperação de lançamentos\.

Escreva para estas tarefas de quem lê\:

- **Novo visitante\:** decidir rapidamente se o Better Workflows resolve um problema relevante\.
- **Novo utilizador\:** instalar o plugin e concluir um caminho automático com sucesso\.
- **Avaliador\:** compreender o limite de autoridade e o comportamento fail\-closed\.
- **Operador habitual\:** aceder diretamente a uma resposta sobre fluxo de trabalho\, segurança\, arquitetura ou CLI\.
- **Contribuidor ou tradutor\:** encontrar o contrato canónico\, comandos de desenvolvimento\, suporte e governação\.

## Use uma narrativa de causa e efeito

Os cinco README de entrada usam a mesma sequência semântica de oito partes\. Os títulos podem ser idiomáticos em cada língua\, mas o percurso de quem lê não muda\.

| Secção | Pergunta de quem lê e função narrativa |
| --- | --- |
| Promessa e público | O que é o Better Workflows\, porque existe e a quem se destina\? |
| Do problema ao resultado | O que corre mal quando se confundem intenção\, autoridade\, evidências e resultado do fornecedor\? |
| Prova e limites | Que garantias tornam credível o resultado proposto\? |
| Primeiro sucesso | Qual é o percurso completo mais curto entre a instalação e o resultado\? |
| Escolher o próximo caminho | Que fluxo de trabalho ou documento corresponde ao objetivo de quem lê\? |
| Ciclo de vida | Como passa um objetivo a uma conclusão reconciliada — ou para em segurança\? |
| Confiança e limites | O que é que o sistema nunca pode inferir\, autorizar ou afirmar\? |
| Aprender\, obter ajuda e contribuir | Onde estão a documentação aprofundada\, o apoio\, a governação\, o desenvolvimento e a licença\? |

Esta ordem proporciona uma progressão prática\:

- **Contexto\:** o trabalho orientado por prompts pode expressar intenção sem provar autoridade nem estado\.
- **Tensão\:** os efeitos laterais transformam essa lacuna num risco para a entrega\.
- **Resolução\:** o Better Workflows associa objetivo\, âmbito\, evidências\, revisão\, ação e reconciliação com o fornecedor\.
- **Prova\:** garantias e limites explícitos mostram como funciona a resolução\.
- **Ação\:** quem lê chega a um primeiro sucesso antes de encontrar pormenores aprofundados da implementação\.
- **Continuação\:** percursos baseados no papel e no resultado conduzem quem lê ao tutorial\, guia prático\, explicação ou referência adequados\.

## Separe o conteúdo de entrada da documentação aprofundada

Use o README para informação relevante para a decisão\. Encaminhe o aprofundamento segundo a finalidade\:

- [Primeiros passos](getting-started.md) é o tutorial de primeira utilização\.
- [Fluxos de trabalho](workflows.md) é o guia prático para escolher resultados\.
- [Arquitetura](architecture.md) explica o plano de controlo e os compromissos entre alternativas\.
- [Segurança](security-guide.md) explica a autoridade\, a privacidade\, as atestações e o comportamento que bloqueia a operação na ausência de verificação válida\.
- [Referência da CLI](cli-reference.md) é a referência de comandos\.
- As páginas localizadas `docs/details/*.md` preservam os pormenores traduzidos de forma abrangente\.

Não duplique na página de entrada a recuperação da cache\, a titularidade dos bloqueios\, a semântica completa do transporte para os fornecedores\, listas exaustivas de comandos ou o histórico de alterações da implementação\. Uma afirmação concisa de segurança permanece na própria página\; o seu aprofundamento auditável pertence ao guia canónico\.

Esta separação segue a distinção do Diátaxis entre tutoriais\, guias práticos\, explicações e referências\. Uma única página não pode otimizar simultaneamente estas quatro necessidades de quem lê\.

## Faça com que cada elemento visual justifique a sua presença

Use um elemento visual apenas quando tornar as relações\, a hierarquia ou as transições de estado substancialmente mais fáceis de compreender do que um texto\.

As páginas de entrada permitem dois elementos visuais\:

1. **Arquitetura dos limites de autoridade\:** esclarece que camadas definem a intenção\, os factos atuais\, a autoridade das ferramentas\, as novas tentativas limitadas e o estado apenas de leitura\.
2. **Ciclo do objetivo à conclusão\:** esclarece onde são verificadas as evidências\, onde são autorizados os efeitos laterais e onde um estado desconhecido interrompe o progresso\.

Cada elemento visual deve incluir\:

- texto alternativo conciso e significativo\;
- um equivalente textual adjacente que preserve a conclusão quando o elemento visual estiver oculto ou o Mermaid não for renderizado\;
- texto real para os rótulos essenciais\, sempre que possível\;
- uma pergunta estável de quem lê que justifique manter o elemento visual atualizado\.

Não acrescente capturas de ecrã decorativas\, imagens carregadas de texto nem diagramas que apenas dupliquem uma lista curta\. Limite as tabelas de seleção a duas colunas concisas\, para que continuem a ser utilizáveis em ecrãs estreitos\.

## Preserve o significado entre línguas

O inglês é a referência semântica\, não uma meta de número de linhas\. O chinês tradicional\, o chinês simplificado\, o japonês e o coreano devem soar naturais a quem tem essas línguas como língua materna\, preservando o mesmo contrato\.

Os seguintes elementos devem permanecer equivalentes\:

- as oito secções semânticas e a sua ordem\;
- os comandos para o primeiro sucesso e os identificadores do produto\;
- as cinco afirmações sobre autoridade\, evidências\, estado desconhecido\, prompts e privacidade\;
- os destinos de fluxos de trabalho\, segurança\, arquitetura\, CLI\, apoio\, governação\, desenvolvimento e licença\;
- a finalidade dos elementos visuais\, as fases do ciclo de vida e as alternativas textuais\;
- a origem da versão e a política de selos\.

Os títulos\, os limites das frases\, a pontuação\, os exemplos e as chamadas à ação podem ser idiomáticos\. Nunca traduza comandos\, seletores\, identificadores de evidências nem semântica de segurança\.

## Escreva para leitura rápida e tradução

- Comece pelo resultado de quem lê e coloque os termos importantes no início dos títulos e dos parágrafos\.
- Use a voz ativa e identifique quem é responsável por cada ação\.
- Dirija\-se diretamente a quem lê ao descrever procedimentos\.
- Mantenha os parágrafos curtos e dê a cada um uma única função\.
- Use listas numeradas para sequências e listas com marcadores para escolhas sem ordem sequencial\.
- Use ligações descritivas em vez de rótulos genéricos como “clique aqui”\.
- Mantenha os títulos hierárquicos\, específicos e paralelos dentro do mesmo nível\.
- Prefira linguagem literal e inequívoca que mantenha o significado na tradução\.
- Coloque as condições antes das instruções e os resultados esperados depois dos comandos\.

## Valide a semântica\, não a decoração

Os testes da documentação devem detetar mais do que títulos correspondentes\. Verificam\:

- um H1 e uma hierarquia lógica de cabeçalhos\;
- marcadores ordenados de secções semânticas e de afirmações críticas\;
- comandos exatos de primeiro sucesso e identificadores estáveis\;
- links relativos e destinos de detalhe específicos da localidade\;
- paridade do badge de versão com os metadados de runtime\;
- texto alternativo com significado para imagens e alternativas visuais adjacentes\;
- um único ciclo de vida Mermaid com um equivalente de texto completo\;
- limites de comprimento para tabelas de duas colunas e parágrafos\;
- ausência de pormenores profundos de implementação designados nas landing pages\;

## Base de investigação

- [GitHub\: Acerca do ficheiro README do repositório](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) define a finalidade do README na primeira visita e recomenda colocar a documentação extensa noutro local\.
- [Diátaxis](https://diataxis.fr/start-here/) distingue as necessidades de tutorial\, guia prático\, explicação e referência\.
- [Microsoft\: Conteúdo de leitura rápida](https://learn.microsoft.com/en-us/style-guide/scannable-content/) destaca uma estrutura que apresenta primeiro o mais importante\, parágrafos curtos e pontos de entrada visuais consistentes\.
- [Estilo da documentação para programadores do Google](https://developers.google.com/style/highlights) recomenda voz ativa\, tratamento direto de quem lê\, títulos descritivos\, acessibilidade e escrita para um público global\.
- [GitHub\: Criar diagramas](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) documenta o suporte de Mermaid em Markdown\.
- [W3C WAI\: Tutorial sobre imagens](https://www.w3.org/WAI/tutorials/images/) exige alternativas textuais e equivalentes completos para elementos visuais informativos e complexos\.
