<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Pag\-aambag

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · **Filipino** · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Salamat sa pagtulong na mapahusay ang Better Workflows\.

[README](../../../README.md) · **Pag\-aambag** · [Kodigo ng asal](conduct.md) · [Seguridad](security.md) · [Pamamahala](governance.md) · [Suporta](support.md)

[Pangkalahatang\-ideya sa 41 lokal na bersyon at mga opisyal na pasukan sa web](../../../docs/LANGUAGES.md)\. Ang bersiyong Ingles ng patakarang ito sa pag\-aambag na nagtatakda ng mga tuntunin ang nananatiling opisyal na batayan\.

## Bago magsimula

- Gumamit muna ng issue o discussion para sa bagong pampublikong kontrata\, pagbabago sa pampublikong gawi ng Auto\, security boundary\, o malaking pagbabago sa arkitektura\.
- Panatilihing nakatuon ang isang pull request sa iisang resulta\.
- Huwag kailanman mag\-commit ng mga credential\, pribadong prompt\, raw na history ng pag\-uusap\, host signing key\, resibo ng provider\, o nilagdaang attestation\.
- Pribadong iulat ang mga kahinaan gaya ng inilarawan sa [SECURITY\.md](security.md)\.

## Paghahanda para sa pagpapaunlad

Mga kinakailangan\:

- Node\.js 24 o mas bago\;
- walang kinakailangang bahagi mula sa ikatlong partido sa oras ng pagpapatakbo\;
- malinis na sangay na nakabatay sa kasalukuyang target na sangay\.

Patakbuhin ang buong lokal na batayang pagsusuri\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Mga tuntunin sa pagbabago

1. Panatilihin ang mutation na pagmamay\-ari ng Root at mga fail\-closed side\-effect boundary\.
2. Kapag nagbago ang pampublikong gawi ng Auto\, sabay\-sabay na i\-update ang template at skill nito\, katalogo ng entrypoint\, CLI\, mga test\, at lahat ng apektadong dokumentasyon\.
3. Tanggihan ang mga hindi kilalang opsyon sa CLI at hindi kilalang field ng schema\.
4. Panatilihin ang pribadong runtime state sa labas ng repository\.
5. Magdagdag ng mga negative test para sa bawat bagong safety gate\.
6. Huwag baguhin ang umiiral na immutable na bersyon ng plugin\-cache\. Ang binagong bundle ay nangangailangan ng bagong build version at eksaktong beripikasyon ng source\/cache digest\.

Para sa pagsasaayos na README lamang ang saklaw\, panatilihing madaling basahin nang pahapyaw ang pahina sa ugat at ilagay ang detalyadong mga kontrata sa katugmang talaksan sa ilalim ng [`docs/guide/`](../../../docs/guide/)\.

## Talaan ng pagsusuri para sa kahilingan sa pagsasama ng mga pagbabago

- [ ] Tahasang nakasaad ang saklaw at ang mga hindi layunin\.
- [ ] Nakadokumento ang pag\-uugali at mga hangganan ng kaligtasan\.
- [ ] Saklaw ng mga nakatuong pagsubok ang mga landas ng tagumpay at kabiguan\.
- [ ] Pumapasa ang buong hanay ng pagsubok at `sbw eval`\.
- [ ] Pumapasa ang `git diff --check`\.
- [ ] Sumusunod ang mga pagbabago sa bersiyon\/cache sa mga tuntunin ng paglalathalang hindi na maaaring baguhin\, kung naaangkop\.
- [ ] Walang kasamang mga lihim\, pribadong estado\, o katibayan ng pagtanggap mula sa labas\.

Mas mainam ang maliliit na pagtatala ng mga pagbabago na madaling masuri\. Huwag isama ang hindi kaugnay na paglilinis sa isang pagbabago ng pag\-uugali\.
