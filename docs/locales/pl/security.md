<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Polityka bezpieczeństwa

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · **Polski** · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Współtworzenie](contributing.md) · [Kodeks postępowania](conduct.md) · **Bezpieczeństwo** · [Zarządzanie projektem](governance.md) · [Pomoc](support.md)

[Przegląd w 41 wersjach lokalizowanych i oficjalne punkty dostępu w sieci](../../../docs/LANGUAGES.md)\. Angielska wersja tej normatywnej polityki bezpieczeństwa pozostaje źródłem kanonicznym\.

Jeśli jedyne proponowane źródło dowodów zawiera prywatną historię lub poufne materiały operacyjne\, z których nie można usunąć wrażliwych informacji\, nie zbieraj ich ani nie przesyłaj\. Zapisz wyłącznie uzasadnienie `REJECTED_WITH_EVIDENCE` z zamaskowanymi wrażliwymi informacjami\.

## Obsługiwane wersje

| Wersja | Wsparcie |
| --- | --- |
| Najnowsze opublikowane wydanie i niezmienna kompilacja Codex | Wspierane |
| Starsze niezmienne wersje pamięci podręcznej | Wersje docelowe przy wycofywaniu zmian\; poprawki nie są przenoszone do starszych wersji\, chyba że zostanie to wyraźnie ogłoszone |
| Nieopublikowane rozwidlenia lub zmodyfikowana zawartość pamięci podręcznej | Niewspierane |

## Zgłaszanie podatności

Skorzystaj z [prywatnego zgłaszania podatności w GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. Nie otwieraj publicznego zgłoszenia dotyczącego podejrzewanej podatności\.

Uwzględnij\:

- wersję\, której dotyczy problem\, i kompilację wtyczki\;
- środowisko i wersję Node\.js\;
- minimalne kroki odtworzenia problemu\;
- oczekiwaną i zaobserwowaną granicę bezpieczeństwa\;
- wpływ i wszelkie znane obejścia\;
- informację\, czy raport zawiera materiały poufne\.

Nie dołączaj aktywnych danych uwierzytelniających\, kluczy podpisujących\, tokenów dostawców\, prywatnych poleceń dla modeli w surowej postaci ani danych osobowych osób trzecich\.

## Odpowiedź

Opiekun projektu potwierdzi otrzymanie użytecznego raportu\, zweryfikuje jego zakres oraz skoordynuje usunięcie problemu i ujawnienie informacji\. Nie jest obiecywane SLA określające stały czas odpowiedzi\. Nieznane lub nieuzgodnione wyniki pozostają zablokowane przy braku weryfikacji\.

## Granice bezpieczeństwa

Better Workflows zakłada zaufane lokalne repozytorium\, host i wykonywalny łańcuch narzędzi\. Model uprawnień Node zapewnia ochronę wielowarstwową i nie jest piaskownicą systemu operacyjnego dla złośliwego kodu\. Zobacz pełny [przewodnik po bezpieczeństwie](security-guide.md)\.
