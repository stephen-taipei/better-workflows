<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Sikkerhedspolitik

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · **Dansk** · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Bidrag](contributing.md) · [Adfærdskodeks](conduct.md) · **Sikkerhed** · [Projektstyring](governance.md) · [Hjælp](support.md)

[Oversigt i 41 lokaliserede udgaver og officielle indgange på nettet](../../../docs/LANGUAGES.md)\. Den engelske version af denne normative sikkerhedspolitik forbliver den autoritative kilde\.

Hvis den eneste foreslåede evidenskilde indeholder privat historik eller følsomt operationelt materiale\, som ikke kan renses for følsomme oplysninger\, må det ikke indsamles eller overføres\. Registrer kun en begrundelse med `REJECTED_WITH_EVIDENCE`\, hvor følsomme oplysninger er sløret\.

## Understøttede versioner

| Version | Understøttelse |
| --- | --- |
| Seneste offentliggjorte udgivelse og uforanderligt Codex\-build | Understøttet |
| Ældre uforanderlige cacheversioner | Mål for tilbagerulning\; rettelser overføres ikke til ældre versioner\, medmindre det udtrykkeligt annonceres |
| Ikke\-udgivne forgreninger eller ændret cacheindhold | Ikke understøttet |

## Rapportér en sårbarhed

Brug venligst [privat rapportering af sårbarheder på GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. Opret ikke en offentlig sag om en formodet sårbarhed\.

Medtag\:

- berørt version og udvidelsesbuild\;
- miljø og Node\.js\-version\;
- minimale trin til at genskabe problemet\;
- forventet og observeret sikkerhedsgrænse\;
- konsekvens og eventuel kendt midlertidig løsning\;
- om rapporten indeholder fortroligt materiale\.

Medtag ikke aktive legitimationsoplysninger\, signeringsnøgler\, udbydertokens\, private prompter i rå form eller tredjepersoners personoplysninger\.

## Svar

Den vedligeholdelsesansvarlige bekræfter modtagelsen af en brugbar rapport\, validerer dens omfang og koordinerer afhjælpning og offentliggørelse\. Der loves ingen SLA med fast svartid\. Ukendte eller ikke\-afstemte udfald forbliver blokerede\, når verifikation mangler\.

## Sikkerhedsgrænser

Better Workflows forudsætter et betroet lokalt kodelager\, en betroet vært og en betroet eksekverbar værktøjskæde\. Tilladelsesmodellen i Node giver forsvar i dybden og er ikke en operativsystemsandbox til ondsindet kode\. Se den komplette [sikkerhedsvejledning](security-guide.md)\.
