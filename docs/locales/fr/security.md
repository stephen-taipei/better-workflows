<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Politique de sécurité

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · **Français** · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Contribuer](contributing.md) · [Code de conduite](conduct.md) · **Sécurité** · [Gouvernance](governance.md) · [Assistance](support.md)

[Vue d’ensemble en 41 éditions localisées et points d’accès web officiels](../../../docs/LANGUAGES.md)\. La version anglaise de cette politique normative de sécurité reste la référence faisant autorité\.

Si l’unique source de preuves proposée contient un historique privé ou des informations opérationnelles sensibles dont les éléments sensibles ne peuvent pas être supprimés\, ne les collectez pas et ne les transmettez pas\. Consignez uniquement une justification `REJECTED_WITH_EVIDENCE` expurgée des informations sensibles\.

## Versions prises en charge

| Version | Prise en charge |
| --- | --- |
| Dernière version publiée et compilation immuable de Codex | Prises en charge |
| Anciennes versions du cache immuable | Cibles de retour à une version antérieure \; les correctifs ne sont pas rétroportés\, sauf annonce explicite |
| Dérivations non publiées ou contenu du cache modifié | Non pris en charge |

## Signaler une vulnérabilité

Veuillez utiliser le [signalement privé de vulnérabilités de GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. N’ouvrez pas de ticket public pour une vulnérabilité présumée\.

Incluez \:

- la version et la compilation de l’extension concernées \;
- l’environnement et la version de Node\.js \;
- les étapes minimales de reproduction \;
- la limite de sécurité attendue et celle observée \;
- l’impact et toute solution de contournement connue \;
- l’indication de la présence ou non d’informations confidentielles dans le rapport\.

N’incluez pas d’identifiants actifs\, de clés de signature\, de jetons de fournisseurs\, d’instructions privées brutes ni de données personnelles de tiers\.

## Réponse

Le responsable de la maintenance accusera réception d’un rapport exploitable\, en validera le périmètre et coordonnera la correction et la divulgation\. Aucun SLA à délai de réponse fixe n’est promis\. Les résultats inconnus ou non rapprochés restent bloqués\, avec refus de poursuivre tant qu’ils ne sont pas vérifiés\.

## Limites de sécurité

Better Workflows suppose que le dépôt local\, la machine hôte et la chaîne d’outils exécutables sont fiables\. Le modèle de permissions de Node constitue une défense en profondeur et non un bac à sable du système d’exploitation pour du code malveillant\. Consultez le [guide de sécurité](security-guide.md) complet\.
