<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Balangkas ng kalidad ng README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · **Filipino** · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Pangkalahatang\-ideya sa 41 lokal na bersyon at mga opisyal na pasukan sa web](../../../docs/LANGUAGES.md)\. Ang bersiyong Ingles ng balangkas na ito sa pagsulat ang nananatiling kanonikal na sanggunian\.

Ang README ng Better Workflows ay pahinang panimula\, hindi pinagsiksik na manwal na sanggunian\. Tungkulin nitong tulungan ang mambabasa na sagutin ang limang tanong nang sunod\-sunod\:

1. Ano ito\, at para ba ito sa akin\?
2. Anong problema ang nilulutas nito\?
3. Bakit ko dapat pagkatiwalaan ang mga pahayag nito\?
4. Ano ang pinakamaikling landas tungo sa unang tagumpay\?
5. Saan ako dapat magpatuloy\?

Itinatakda ng balangkas na ito ang kasunduan sa pagsasalaysay\, biswal na pagpapakita\, pag\-aangkop sa wika at lugar\, at pagpapatunay para sa bawat README ng imbakan\. Ang pinagmulang nababasa ng makina ay ang [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Magsimula sa pasiya ng mambabasa

Ipinapakita ng GitHub ang README bago ang karamihan ng nilalaman ng imbakan\. Kaya kailangang linawin sa unang makikita sa iskrin ang pangako ng produkto\, ang nilalayong mga mambabasa\, at ang susunod na aksiyong may malinaw na hangganan\. Hindi ito dapat magsimula sa panloob na arkitektura\, kumpletong sanggunian ng mga utos\, o detalye ng pagpapanumbalik ng mga inilabas na bersiyon\.

Sumulat para sa mga gawaing ito ng mga mambabasa\:

- **Bagong bisita\:** mabilis na magpasya kung nilulutas ng Better Workflows ang isang nauugnay na problema\.
- **Bagong user\:** i\-install ang plugin at maabot ang isang matagumpay na awtomatikong ruta\.
- **Evaluator\:** unawain ang boundary ng awtoridad at fail\-closed na gawi\.
- **Bumabalik na operator\:** lumipat sa isang sagot sa workflow\, seguridad\, arkitektura\, o CLI\.
- **Tagapag\-ambag o tagasalin\:** hanapin ang kanonikal na kontrata\, mga command sa development\, suporta\, at pamamahala\.

## Gumamit ng salaysay ng sanhi at bunga

Ang limang README na pahinang panimula ay gumagamit ng parehong semantikong pagkakasunod\-sunod na may walong bahagi\. Maaaring likas sa bawat wika ang mga pamagat\, ngunit hindi nagbabago ang paglalakbay ng mambabasa\.

| Bahagi | Tanong ng mambabasa at papel sa salaysay |
| --- | --- |
| Pangako at nilalayong mambabasa | Ano ang Better Workflows\, bakit ito umiiral\, at para kanino ito\? |
| Mula sa problema tungo sa resulta | Ano ang nagkakamali kapag pinagkakahalo ang hangarin\, awtoridad\, ebidensiya\, at resulta ng tagapagbigay\? |
| Patunay at mga hangganan | Aling mga garantiya ang nagpapaniwala sa iminungkahing resulta\? |
| Unang tagumpay | Ano ang pinakamaikling kumpletong landas mula sa pagkakabit hanggang sa resulta\? |
| Piliin ang susunod na landas | Aling daloy ng trabaho o dokumento ang tumutugma sa layunin ng mambabasa\? |
| Siklo ng buhay | Paano humahantong ang isang layunin sa pagkumpletong may napagtugmang mga resulta—o sa ligtas na paghinto\? |
| Tiwala at mga limitasyon | Ano ang hindi kailanman maaaring ipagpalagay\, pahintulutan\, o angkinin ng sistema bilang totoo\? |
| Matuto\, humingi ng tulong\, mag\-ambag | Nasaan ang detalyadong dokumentasyon\, suporta\, pamamahala\, pagpapaunlad\, at lisensiya\? |

Nagbibigay ang kaayusang ito ng praktikal na daloy ng salaysay\:

- **Konteksto\:** maaaring magpahayag ng hangarin ang gawaing ginagabayan ng mga tagubilin sa modelo nang hindi pinatutunayan ang awtoridad o estado\.
- **Tensiyon\:** ginagawang panganib sa paghahatid ng resulta ng mga pagbabagong may epekto sa estado ang puwang na iyon\.
- **Paglutas\:** pinag\-uugnay ng Better Workflows ang layunin\, saklaw\, ebidensiya\, pagsusuri\, aksiyon\, at pagtutugma sa resulta ng tagapagbigay\.
- **Patunay\:** ipinapakita ng malinaw na mga garantiya at hangganan kung paano gumagana ang paglutas\.
- **Aksiyon\:** nararating ng mambabasa ang unang tagumpay bago makaharap ang masusing detalye ng implementasyon\.
- **Pagpapatuloy\:** dinadala ng mga landas ayon sa gampanin at resulta ang mambabasa sa angkop na araling gabay\, gabay sa pagsasagawa\, paliwanag\, o sanggunian\.

## Ihiwalay ang nilalaman ng pahinang panimula sa detalyadong dokumentasyon

Gamitin ang README para sa impormasyong may kaugnayan sa pagpapasiya\. Ituro ang mas malalim na detalye ayon sa layunin\:

- [Pagsisimula](getting-started.md) ang araling gabay para sa unang paggamit\.
- [Mga daloy ng trabaho](workflows.md) ang gabay sa pagsasagawa para sa pagpili ng resulta\.
- [Arkitektura](architecture.md) ang nagpapaliwanag sa bahaging pangkontrol at sa pagtitimbang ng mga pakinabang at kapalit\.
- [Seguridad](security-guide.md) ang nagpapaliwanag sa awtoridad\, pagkapribado\, mga pahayag ng pagpapatunay\, at paraan ng pagkilos na humaharang sa mga aksiyon kapag walang beripikasyon\.
- [Sanggunian ng CLI](cli-reference.md) ang sanggunian ng mga utos\.
- Pinananatili ng mga pahinang `docs/details/*.md` na iniangkop sa lokal na gamit ang buong isinaling detalye\.

Huwag ulitin sa pahinang panimula ang pagpapanumbalik ng cache\, pagmamay\-ari ng mga lock\, buong kahulugan ng mekanismo ng paglilipat ng datos ng mga tagapagbigay\, kumpletong talaan ng mga utos\, o kasaysayan ng mga pagbabago sa implementasyon\. Nananatili sa pahina ang maikling pahayag tungkol sa kaligtasan\; ang masusing detalyeng maaaring siyasatin upang patunayan ito ay nararapat sa kanonikal na gabay\.

Sinusunod ng paghihiwalay na ito ang pagkakaiba sa Diátaxis ng mga araling gabay\, gabay sa pagsasagawa\, paliwanag\, at sanggunian\. Hindi maaaring gawing pinakamainam ang iisang pahina para sa lahat ng apat na pangangailangan ng mambabasa nang sabay\-sabay\.

## Bigyang\-katwiran ang puwesto ng bawat biswal

Gumamit lamang ng biswal kapag higit nitong pinadadali ang pag\-unawa sa mga ugnayan\, herarkiya\, o paglipat ng estado kaysa sa karaniwang tuluyan\.

Pinapayagan ng mga pahinang panimula ang dalawang biswal\:

1. **Arkitektura ng hangganan ng awtoridad\:** sinasagot kung aling mga patong ang humuhubog sa hangarin\, kasalukuyang mga katotohanan\, awtoridad ng mga kasangkapan\, mga muling pagsubok na may hangganan\, at estadong maaari lamang basahin\.
2. **Siklo ng buhay mula layunin hanggang pagkumpleto\:** sinasagot kung saan sinusuri ang ebidensiya\, kung saan pinapahintulutan ang mga pagbabagong may epekto sa estado\, at kung saan pinatitigil ng hindi alam na estado ang pag\-usad\.

Kailangang kasama sa bawat biswal ang\:

- maikli at makabuluhang pamalit na teksto\;
- katabing tekstong katumbas na nagpapanatili sa konklusyon kapag nakatago ang biswal o hindi naipapakita ang Mermaid\;
- tunay na teksto para sa mahahalagang etiketa hangga’t maaari\;
- tanong ng mambabasa na nananatiling mahalaga at nagbibigay\-katwiran sa pagpapanatiling napapanahon ng biswal\.

Huwag magdagdag ng pandekorasyong mga kuha ng iskrin\, larawang puno ng teksto\, o dayagram na inuulit lamang ang isang maikling listahan\. Limitahan ang mga talahanayan ng pagpili sa dalawang kolum na may maikling nilalaman upang manatiling nagagamit ang mga ito sa makikitid na iskrin\.

## Panatilihin ang kahulugan sa iba’t ibang wika

Ang Ingles ang sanggunian sa kahulugan\, hindi bilang ng linyang kailangang tapatan\. Dapat maging natural ang Tradisyonal na Tsino\, Pinasimpleng Tsino\, Hapones\, at Koreano para sa mambabasang katutubong tagapagsalita habang pinananatili ang parehong kasunduan\.

Kailangang manatiling katumbas ang mga sumusunod\:

- ang walong semantikong bahagi at ang pagkakasunod\-sunod ng mga ito\;
- ang mga utos para sa unang tagumpay at mga pantukoy ng produkto\;
- ang limang pahayag tungkol sa awtoridad\, ebidensiya\, hindi alam na estado\, mga tagubilin sa modelo\, at pagkapribado\;
- ang mga destinasyon para sa daloy ng trabaho\, seguridad\, arkitektura\, CLI\, suporta\, pamamahala\, pagpapaunlad\, at lisensiya\;
- ang layunin ng biswal\, mga yugto ng siklo ng buhay\, at mga pamalit na teksto\;
- ang pinagmulan ng bersiyon at patakaran sa mga pananda\.

Maaaring maging likas sa wika ang mga pamagat\, hangganan ng pangungusap\, bantas\, halimbawa\, at panawagan sa pagkilos\. Panatilihin ang orihinal na anyo ng mga utos\, tagapili\, at pantukoy ng ebidensiya\, at huwag baguhin ang kahulugan ng mga tuntunin sa seguridad\.

## Sumulat para sa mabilisang pagbasa at pagsasalin

- Unahin ang resulta para sa mambabasa at ilagay ang mahahalagang termino sa simula ng mga pamagat at talata\.
- Gumamit ng tinig na tahasan at pangalanan ang gumagawa na may pananagutan sa aksiyon\.
- Tuwirang kausapin ang mambabasa sa mga pamamaraan\.
- Panatilihing maikli ang mga talata at bigyan ang bawat isa ng iisang gampanin\.
- Gumamit ng mga listahang may bilang para sa pagkakasunod\-sunod at mga tuldok para sa mga pagpiling walang takdang ayos\.
- Gumamit ng mga kawing na naglalarawan ng patutunguhan sa halip na pangkalahatang etiketang gaya ng “pindutin dito”\.
- Panatilihing may herarkiya\, tiyak\, at magkakatulad ang porma ng mga pamagat sa parehong antas\.
- Piliin ang literal at walang kalabuang pananalitang nananatili ang kahulugan sa pagsasalin\.
- Ilagay ang mga kondisyon bago ang mga tagubilin at ang inaasahang resulta pagkatapos ng mga utos\.

## Patunayan ang semantika\, hindi ang dekorasyon

Kailangang matukoy ng mga pagsubok sa dokumentasyon ang higit pa sa pagtutugma ng mga pamagat\. Sinusuri ng mga ito ang\:

- isang H1 at lohikal na herarkiya ng heading\;
- may\-pagkakasunod\-sunod na semantic section at mga critical\-claim marker\;
- eksaktong mga first\-success command at mga stable na identifier\;
- mga relatibong link at mga destinasyon ng detalye na partikular sa lokalidad\;
- parity ng version badge sa metadata ng runtime\;
- makabuluhang alt text ng larawan at mga katabing visual fallback\;
- iisang Mermaid lifecycle na may kumpletong katumbas na teksto\;
- dalawang\-kolum na talahanayan at mga limitasyon sa haba ng talata\;
- kawalan ng itinalagang malalim na detalye ng pagpapatupad mula sa mga landing page\;

## Batayan ng pananaliksik

- [GitHub\: Tungkol sa README ng imbakan](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) nagtatakda ng layunin ng README sa unang pagbisita at nagrerekomendang ilipat ang mahahabang dokumentasyon sa ibang lugar\.
- [Diátaxis](https://diataxis.fr/start-here/) naghihiwalay sa mga pangangailangan para sa araling gabay\, gabay sa pagsasagawa\, paliwanag\, at sanggunian\.
- [Microsoft\: Nilalamang madaling basahin nang pahapyaw](https://learn.microsoft.com/en-us/style-guide/scannable-content/) nagbibigay\-diin sa kaayusang inuuna ang mahalaga\, maiikling talata\, at magkakatugmang biswal na pasukan\.
- [Estilo ng dokumentasyon ng Google para sa mga tagapagpaunlad](https://developers.google.com/style/highlights) nagrerekomenda ng tinig na tahasan\, tuwirang pakikipag\-usap\, mga pamagat na naglalarawan\, aksesibilidad\, at pagsulat para sa mga mambabasa sa buong mundo\.
- [GitHub\: Paglikha ng mga dayagram](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) nagdodokumento ng suporta para sa Mermaid sa Markdown\.
- [W3C WAI\: Araling gabay tungkol sa mga larawan](https://www.w3.org/WAI/tutorials/images/) nangangailangan ng mga pamalit na teksto at kumpletong katumbas para sa mga biswal na nagbibigay ng impormasyon at mga komplikadong biswal\.
