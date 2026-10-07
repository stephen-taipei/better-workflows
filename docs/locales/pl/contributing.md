<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Współtworzenie

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · **Polski** · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Dziękujemy za pomoc w ulepszaniu Better Workflows\.

[README](../../../README.md) · **Współtworzenie** · [Kodeks postępowania](conduct.md) · [Bezpieczeństwo](security.md) · [Zarządzanie projektem](governance.md) · [Pomoc](support.md)

[Przegląd w 41 wersjach lokalizowanych i oficjalne punkty dostępu w sieci](../../../docs/LANGUAGES.md)\. Angielska wersja tej normatywnej polityki współtworzenia pozostaje źródłem kanonicznym\.

## Zanim zaczniesz

- W przypadku nowego publicznego kontraktu\, zmiany publicznego zachowania Auto\, granicy bezpieczeństwa lub dużej zmiany architektonicznej zacznij od issue lub dyskusji\.
- Zadbaj\, aby jeden pull request skupiał się na jednym rezultacie\.
- Nigdy nie commituj danych uwierzytelniających\, prywatnych promptów\, surowej historii konwersacji\, kluczy podpisywania hosta\, potwierdzeń dostawców ani podpisanych atestacji\.
- Zgłaszaj luki w zabezpieczeniach prywatnie\, zgodnie z opisem w [SECURITY\.md](security.md)\.

## Konfiguracja środowiska programistycznego

Wymagania\:

- Node\.js 24 lub nowszy\;
- brak zależności od podmiotów trzecich w czasie wykonywania\;
- czysta gałąź oparta na bieżącej gałęzi docelowej\.

Uruchom kompletny lokalny zestaw kontroli bazowych\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Zasady zmian

1. Zachowaj mutacje należące do Root oraz granice efektów ubocznych typu fail\-closed\.
2. Gdy zmienia się publiczne zachowanie Auto\, zaktualizuj jednocześnie jego szablon i skill\, katalog punktów wejścia\, CLI\, testy oraz całą powiązaną dokumentację\.
3. Odrzucaj nieznane opcje CLI i nieznane pola schematu\.
4. Przechowuj prywatny stan wykonawczy poza repozytorium\.
5. Dodaj testy negatywne dla każdej nowej bramki bezpieczeństwa\.
6. Nie modyfikuj istniejącej\, niezmiennej wersji plugin\-cache\. Zmieniony pakiet wymaga nowej wersji kompilacji i dokładnej weryfikacji skrótu źródła\/pamięci podręcznej\.

Przy reorganizacji obejmującej wyłącznie README zachowaj przejrzystość strony głównej\, a szczegółowe kontrakty umieść w odpowiednim pliku w [`docs/guide/`](../../../docs/guide/)\.

## Lista kontrolna żądania scalenia

- [ ] Zakres i kwestie niebędące celami są jasno określone\.
- [ ] Zachowanie i granice bezpieczeństwa są udokumentowane\.
- [ ] Ukierunkowane testy obejmują ścieżki powodzenia i niepowodzenia\.
- [ ] Pełny zestaw testów i `sbw eval` przechodzą pomyślnie\.
- [ ] `git diff --check` przechodzi pomyślnie\.
- [ ] Zmiany wersji i pamięci podręcznej przestrzegają zasad niezmiennego publikowania\, gdy mają one zastosowanie\.
- [ ] Nie dołączono sekretów\, prywatnego stanu ani zewnętrznych potwierdzeń\.

Preferowane są małe commity łatwe do przeglądu\. Nie łącz niezwiązanych porządków ze zmianą zachowania\.
