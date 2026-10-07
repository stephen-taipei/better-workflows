<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Contribuer

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · **Français** · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Merci de contribuer à l’amélioration de Better Workflows\.

[README](../../../README.md) · **Contribuer** · [Code de conduite](conduct.md) · [Sécurité](security.md) · [Gouvernance](governance.md) · [Assistance](support.md)

[Vue d’ensemble en 41 éditions localisées et points d’accès web officiels](../../../docs/LANGUAGES.md)\. La version anglaise de cette politique normative de contribution reste la référence faisant autorité\.

## Avant de commencer

- Utilisez d’abord une issue ou une discussion pour tout nouveau contrat public\, toute modification du comportement public d’Auto\, une frontière de sécurité ou un changement architectural majeur\.
- Gardez chaque pull request concentrée sur un seul résultat\.
- Ne committez jamais d’identifiants\, de prompts privés\, d’historique brut de conversation\, de clés de signature de l’hôte\, de reçus de fournisseur ou d’attestations signées\.
- Signalez les vulnérabilités de manière privée comme décrit dans [SECURITY\.md](security.md)\.

## Configuration de l’environnement de développement

Prérequis \:

- Node\.js 24 ou version ultérieure \;
- aucune dépendance tierce à l’exécution \;
- une branche propre basée sur la branche cible actuelle\.

Exécutez l’ensemble des vérifications de référence locales \:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Règles de modification

1. Préservez les mutations détenues par Root et les frontières d’effets secondaires fail\-closed\.
2. Lorsque le comportement public d’Auto change\, mettez à jour conjointement son template\, son skill\, son catalogue d’entrypoints\, la CLI\, les tests et toute la documentation concernée\.
3. Rejetez les options de CLI inconnues et les champs de schéma inconnus\.
4. Conservez l’état d’exécution privé en dehors du dépôt\.
5. Ajoutez des tests négatifs pour chaque nouvelle safety gate\.
6. Ne modifiez pas une version immuable existante du cache de plugins\. Un bundle modifié nécessite une nouvelle version de build et une vérification exacte du digest source\/cache\.

Pour une réorganisation limitée au README\, gardez la page racine facile à parcourir et placez les contrats détaillés dans le fichier correspondant sous [`docs/guide/`](../../../docs/guide/)\.

## Liste de vérification d’une demande de fusion

- [ ] Le périmètre et les objectifs exclus sont explicites\.
- [ ] Le comportement et les limites de sûreté sont documentés\.
- [ ] Des tests ciblés couvrent les chemins de réussite et d’échec\.
- [ ] La suite complète de tests et `sbw eval` réussissent\.
- [ ] `git diff --check` réussit\.
- [ ] Les modifications de version\/cache suivent les règles de publication immuable\, le cas échéant\.
- [ ] Aucun secret\, état privé ni reçu externe n’est inclus\.

Privilégiez de petits enregistrements de modifications faciles à examiner\. Ne combinez pas un nettoyage sans rapport avec un changement de comportement\.
