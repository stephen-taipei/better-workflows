<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Plan de qualité des README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · **Français** · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Vue d’ensemble en 41 éditions localisées et points d’accès web officiels](../../../docs/LANGUAGES.md)\. La version anglaise de ce plan éditorial reste la source canonique\.

Un README de Better Workflows est une page d’entrée\, pas un manuel de référence condensé\. Son rôle est d’aider le lecteur à répondre\, dans l’ordre\, à cinq questions \:

1. Qu’est\-ce que c’est\, et est\-ce pour moi \?
2. Quel problème cela résout\-il \?
3. Pourquoi devrais\-je faire confiance à ses affirmations \?
4. Quel est le chemin le plus court vers une première réussite \?
5. Où dois\-je aller ensuite \?

Ce plan définit le contrat de narration\, de présentation visuelle\, de localisation et de validation pour chaque README du dépôt\. La source lisible par machine est [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Partez de la décision du lecteur

GitHub affiche un README avant la majeure partie du contenu du dépôt\. Le premier écran doit donc établir la promesse du produit\, le public visé et une prochaine action clairement délimitée\. Il ne doit pas commencer par l’architecture interne\, une référence complète des commandes ou des détails de récupération des versions publiées\.

Écrivez pour les tâches suivantes des lecteurs \:

- **Nouveau visiteur \:** déterminer rapidement si Better Workflows résout un problème pertinent\.
- **Nouvel utilisateur \:** installer le plugin et obtenir un premier routage automatique réussi\.
- **Évaluateur \:** comprendre la frontière d’autorité et le comportement fail\-closed\.
- **Opérateur habitué \:** accéder directement à une réponse sur les workflows\, la sécurité\, l’architecture ou la CLI\.
- **Contributeur ou traducteur \:** trouver le contrat canonique\, les commandes de développement\, le support et la gouvernance\.

## Utilisez une narration de cause à effet

Les cinq README d’entrée utilisent la même séquence sémantique en huit parties\. Les titres peuvent être idiomatiques dans chaque langue\, mais le parcours du lecteur ne change pas\.

| Section | Question du lecteur et rôle narratif |
| --- | --- |
| Promesse et public | Qu’est\-ce que Better Workflows\, pourquoi existe\-t\-il et à qui s’adresse\-t\-il \? |
| Du problème au résultat | Que se passe\-t\-il lorsque l’intention\, l’autorité\, les éléments de preuve et le résultat du fournisseur sont confondus \? |
| Démonstration et limites | Quelles garanties rendent le résultat proposé crédible \? |
| Première réussite | Quel est le chemin complet le plus court de l’installation au résultat \? |
| Choisir la suite | Quel flux de travail ou document correspond à l’objectif du lecteur \? |
| Cycle de vie | Comment un objectif aboutit\-il à une finalisation après rapprochement des résultats\, ou s’arrête\-t\-il en toute sécurité \? |
| Confiance et limites | Que le système ne peut\-il jamais déduire\, autoriser ou affirmer \? |
| Apprendre\, obtenir de l’aide\, contribuer | Où se trouvent la documentation approfondie\, l’assistance\, la gouvernance\, le développement et la licence \? |

Cet ordre fournit un arc narratif pratique \:

- **Contexte \:** le travail guidé par des instructions destinées aux modèles peut exprimer une intention sans prouver l’autorité ni l’état\.
- **Tension \:** les effets de bord transforment cette lacune en risque pour la livraison du résultat\.
- **Résolution \:** Better Workflows lie l’objectif\, le périmètre\, les éléments de preuve\, la revue\, l’action et le rapprochement avec le résultat du fournisseur\.
- **Démonstration \:** des garanties et des limites explicites montrent comment fonctionne la résolution\.
- **Action \:** le lecteur atteint une première réussite avant de rencontrer des détails approfondis d’implémentation\.
- **Suite \:** les parcours fondés sur le rôle et le résultat orientent le lecteur vers le bon tutoriel\, guide pratique\, exposé explicatif ou document de référence\.

## Séparez le contenu d’entrée de la documentation approfondie

Utilisez le README pour les informations utiles à la décision\. Orientez vers les détails selon leur objectif \:

- [Premiers pas](getting-started.md) est le tutoriel de première utilisation\.
- [Flux de travail](workflows.md) est le guide pratique de sélection du résultat\.
- [Architecture](architecture.md) explique le plan de contrôle et les compromis\.
- [Sécurité](security-guide.md) explique l’autorité\, la vie privée\, les attestations et le comportement qui bloque les actions en l’absence de vérification\.
- [Référence CLI](cli-reference.md) est la référence des commandes\.
- Les pages localisées `docs/details/*.md` conservent l’intégralité des détails traduits\.

Ne dupliquez pas sur la page d’entrée la restauration du cache\, la propriété des verrous\, la sémantique complète du transport des fournisseurs\, l’inventaire exhaustif des commandes ou l’historique des modifications d’implémentation\. Une affirmation concise de sécurité reste sur la page \; les détails qui permettent de l’auditer appartiennent au guide canonique\.

Cette séparation suit la distinction de Diátaxis entre tutoriels\, guides pratiques\, explications et références\. Une seule page ne peut pas être optimisée pour les quatre besoins du lecteur à la fois\.

## Justifiez la place de chaque visuel

Utilisez un visuel uniquement lorsqu’il facilite sensiblement la compréhension des relations\, de la hiérarchie ou des transitions d’état par rapport à un texte suivi\.

Les pages d’entrée autorisent deux visuels \:

1. **Architecture des limites d’autorité \:** indique quelles couches façonnent l’intention\, les faits actuels\, l’autorité des outils\, les nouvelles tentatives limitées et l’état en lecture seule\.
2. **Cycle de vie de l’objectif à la finalisation \:** indique où les éléments de preuve sont contrôlés\, où les effets de bord sont autorisés et où un état inconnu arrête la progression\.

Chaque visuel doit inclure \:

- un texte alternatif concis et pertinent \;
- un équivalent textuel adjacent qui préserve la conclusion lorsque le visuel est masqué ou que Mermaid n’est pas rendu \;
- du véritable texte pour les libellés essentiels\, chaque fois que possible \;
- une question stable du lecteur qui justifie le maintien du visuel à jour\.

N’ajoutez pas de captures d’écran décoratives\, d’images chargées de texte ni de diagramme qui se contente de répéter une courte liste\. Limitez les tableaux de sélection à deux colonnes concises pour qu’ils restent utilisables sur les écrans étroits\.

## Préservez le sens d’une langue à l’autre

L’anglais est la référence sémantique\, pas un objectif de nombre de lignes\. Le chinois traditionnel\, le chinois simplifié\, le japonais et le coréen doivent sembler naturels à un lecteur natif tout en préservant le même contrat\.

Les éléments suivants doivent rester équivalents \:

- les huit sections sémantiques et leur ordre \;
- les commandes de première réussite et les identifiants des produits \;
- les cinq affirmations relatives à l’autorité\, aux éléments de preuve\, à l’état inconnu\, aux instructions pour les modèles et à la vie privée \;
- les destinations des flux de travail\, de la sécurité\, de l’architecture\, de la CLI\, de l’assistance\, de la gouvernance\, du développement et de la licence \;
- la finalité des visuels\, les étapes du cycle de vie et les solutions de remplacement textuelles \;
- la source de la version et la politique des badges\.

Les titres\, les limites des phrases\, la ponctuation\, les exemples et les appels à l’action peuvent être idiomatiques\. Conservez les commandes\, les sélecteurs et les identifiants des éléments de preuve sous leur forme originale\, et préservez toujours le sens des règles de sécurité\.

## Écrivez pour la lecture rapide et la traduction

- Commencez par le résultat du lecteur et placez les termes importants au début des titres et des paragraphes\.
- Employez la voix active et nommez l’acteur responsable d’une action\.
- Adressez\-vous directement au lecteur dans les procédures\.
- Gardez les paragraphes courts et donnez à chacun une seule fonction\.
- Utilisez des listes numérotées pour les séquences et des puces pour les choix sans ordre\.
- Utilisez des liens descriptifs plutôt que des libellés génériques comme « cliquez ici »\.
- Gardez les titres hiérarchiques\, précis et parallèles dans leur formulation au même niveau\.
- Préférez un langage littéral et sans ambiguïté qui conserve son sens à la traduction\.
- Placez les conditions avant les instructions et les résultats attendus après les commandes\.

## Validez la sémantique\, pas la décoration

Les tests de documentation doivent détecter davantage que la correspondance des titres\. Ils vérifient \:

- un titre H1 et une hiérarchie logique de sous\-titres \;
- des marqueurs sémantiques de section et d’affirmations critiques ordonnés \;
- des commandes de premier succès exactes et des identifiants stables \;
- des liens relatifs et des destinations de détails spécifiques à la langue \;
- la parité des badges de version avec les métadonnées de runtime \;
- un texte alternatif d’image explicite et des solutions de repli visuelles adjacentes \;
- un cycle de vie Mermaid unique accompagné d’un équivalent textuel complet \;
- des tableaux à deux colonnes et des limites de longueur de paragraphe \;
- l’absence de détails d’implémentation approfondis désignés sur les pages de destination \;

## Fondements de recherche

- [GitHub \: À propos du fichier README du dépôt](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) définit la finalité du README lors de la première visite et recommande de déplacer la documentation longue ailleurs\.
- [Diátaxis](https://diataxis.fr/start-here/) distingue les besoins de tutoriels\, de guides pratiques\, d’explications et de références\.
- [Microsoft \: Contenu facile à parcourir](https://learn.microsoft.com/en-us/style-guide/scannable-content/) met l’accent sur une structure qui présente l’essentiel en premier\, des paragraphes courts et des points d’entrée visuels cohérents\.
- [Style de documentation Google pour les développeurs](https://developers.google.com/style/highlights) recommande la voix active\, l’adresse directe\, les titres descriptifs\, l’accessibilité et une rédaction destinée à un public mondial\.
- [GitHub \: Création de diagrammes](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) documente la prise en charge de Mermaid dans Markdown\.
- [W3C WAI \: Tutoriel sur les images](https://www.w3.org/WAI/tutorials/images/) exige des solutions de remplacement textuelles et des équivalents complets pour les visuels informatifs et complexes\.
