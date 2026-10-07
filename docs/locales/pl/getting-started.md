<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Pierwsze kroki

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · **Polski** · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

Wersja V5\.0 RC1 obejmuje Codex\, Gemini CLI i Qwen Code w środowisku macOS × Node 22\/24\. Kwalifikacja Claude Code\, Linux i Windows została odroczona do wersji V5\.1\. GA wymaga co najmniej 30 naturalnych dni canary\, 20 kolejnych kwalifikujących się uruchomień i trzech odrębnych repozytoriów\.

| [Przegląd](../../../README.md) | [Szczegóły](../../../docs/details/en.md) | **Szybki start** | [Przepływy pracy](workflows.md) | [Architektura](architecture.md) | [Bezpieczeństwo](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Przegląd w 41 wersjach lokalizowanych i oficjalne punkty dostępu w sieci](../../../docs/LANGUAGES.md)\. Polecenia i identyfikatory zachowują kanoniczną postać w języku angielskim\.

Wersja V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) jest publicznie dostępna\. Zakres tego wydania obejmuje wyłącznie Auto\, wraz z Codex\, Gemini CLI i Qwen Code na systemie macOS z Node 22\/24\. Kwalifikacja dla systemów Linux i Windows została odroczona do wersji V5\.1\, podobnie jak kwalifikacja Claude Code\. Wydanie GA `5.0.0` pozostaje wstrzymane do czasu odnotowania co najmniej 30 naturalnych dni canary\, 20 kolejnych kwalifikujących się uruchomień i trzech odrębnych repozytoriów\.

## Wymagania

- Node\.js 22\.14 lub nowszy dla dołączonego narzędzia pomocniczego `sbw`\.
- Zaufane lokalne repozytorium\. Better Workflows nie zapewnia piaskownicy dla złośliwego kodu z repozytorium\.

Katalog główny stanu v4 jest niezależny od platformy agenta\: `SBW_STATE_ROOT` ma pierwszeństwo\, gdy jest ustawione\, następnie używane jest `XDG_STATE_HOME/better-workflows`\, a w przeciwnym razie `~/.better-workflows`\. Domyślna lokalizacja nie znajduje się już pod `CODEX_HOME`\. Aby nadal korzystać z istniejącego stanu v3 dla Codex bez jego przenoszenia\, ustaw jawnie `SBW_STATE_ROOT` na dokładnie ten katalog `<CODEX_HOME>/sbw` przed wywołaniem `sbw`\.

Wydanie V5\.0 GA \(`5.0.0`\) pozostaje w toku\. Poniższe polecenia instalacyjne dotyczą publicznie dostępnej wersji V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\)\.

## Instalacja

### Codex — zalecany punkt odniesienia

```bash
# Install the publicly available V5.0.rc1 release candidate.
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
node plugins/better-workflows/scripts/sbw.mjs version --json
node plugins/better-workflows/scripts/sbw.mjs update status --json
# Before the first check, status is unknown. Choose one update mode; manual is
# the default. off disables network access even for an explicit check, while an
# explicit check can query manual or automatic mode without the 24-hour throttle.
node plugins/better-workflows/scripts/sbw.mjs update configure --mode off
node plugins/better-workflows/scripts/sbw.mjs update configure --mode manual
node plugins/better-workflows/scripts/sbw.mjs update configure --mode automatic
node plugins/better-workflows/scripts/sbw.mjs update check --json
# automatic is opt-in, interactive-only, best effort, and at most once/24h;
# success and failure both consume the slot. Automatic checks are skipped in CI,
# --json, and non-interactive paths. It never auto-installs; only fixed public
# metadata is used.
```

Po instalacji otwórz nowe zadanie Codex\, aby odświeżyć jego katalog umiejętności\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI kopiuje rozszerzenie\. Po instalacji uruchom sesję ponownie\; do późniejszego odświeżenia użyj `gemini extensions update better-workflows`\.

Kontekst rozszerzenia ustala położenie mostu na podstawie ścieżki własnego załadowanego kodu źródłowego\, a nie katalogu roboczego projektu\. Dla standardowej instalacji na poziomie użytkownika równoważna ręczna kontrola wygląda następująco\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

W przypadku rozszerzenia podłączonego przez link lub zainstalowanego na poziomie obszaru roboczego użyj dokładnie tego katalogu głównego rozszerzenia\, który wskazuje platforma agenta\. Nie zastępuj go kopią roboczą o podobnej nazwie\.

### Qwen Code

Przypnij konkretną wersję wydania przed zainstalowaniem lokalnej kopii rozszerzenia\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code również kopiuje rozszerzenie\, dlatego po instalacji uruchom sesję ponownie\, a do późniejszych aktualizacji używaj `qwen extensions update better-workflows`\.

Dla standardowej instalacji na poziomie użytkownika równoważna ręczna kontrola mostu wygląda następująco\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Ta sama zasada dotycząca dokładnego katalogu głównego obowiązuje dla instalacji podłączonych przez link lub ograniczonych do obszaru roboczego\.

## Użyj Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Każdy punkt wejścia zachowuje żądany cel Goal\. Niepowiązany aktywny cel Goal trzeba jawnie zmienić lub wyczyścić\; nigdy nie jest zastępowany po cichu\.

## Podejrzyj trasę

Pobranie migawki możliwości wymaga tylko odczytu i nie uruchamia logowania u dostawcy ani semantycznego sprawdzenia modelu\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Aby przekazanie można było poddać przeglądowi\, zarejestruj i wykorzystaj jeden prywatny\, jednorazowy\, weryfikowalny zapis\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Zapisy wygasają po 24 godzinach\, a ich użycie jest odrzucane ze względów bezpieczeństwa przy ponownym użyciu lub rozbieżnościach w obszarze roboczym\, zakresie\, Profiles\, katalogu\, możliwościach albo pakiecie wtyczki\.

## Zweryfikuj instalację

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Przed zmianą repozytorium

Auto zaczyna od wstępnej kontroli obszaru roboczego wykonywanej tylko do odczytu\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Zadania niekorzystające z Git oraz zadania tylko do odczytu nie tworzą worktree\. Zadanie Git wprowadzające zmiany musi utworzyć lub ponownie wykorzystać należący do zadania `TaskWorkspaceLeaseV1`\. Jeśli katalog roboczy źródła zawiera zmiany niezatwierdzone w commicie\, proces zatrzymuje się przed jakąkolwiek operacją stash\, kopiowaniem\, operacją commit lub utworzeniem worktree\. Odłączony HEAD lub brak celu wymaga jawnego wskazania celu integracji\. Chronione lub zdalne cele są przenoszone do procesu dostarczania przez PR podlegającego regułom zarządzania\.

Jeśli Codex lub inna platforma agenta utworzyła już czyste worktree bieżącego zadania\, zarejestruj je przed edycją\, zamiast tworzyć zagnieżdżone worktree\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Rejestracja wymaga odrębnej gałęzi zadania zgodnej z wzorcem `codex/*` na niezmienionej rewizji bazowej\, tego samego wspólnego katalogu Git i czystej kopii roboczej źródła\. Better Workflows używa worktree\, ale podczas sprzątania zachowuje gałąź oraz ścieżkę należące do platformy agenta\. Dla chronionego celu najpierw uruchom przepływ pracy związany z dowodami\, a następnie powiąż jego dokładne weryfikowalne zapisy scalenia PR i synchronizacji zdalnej za pomocą `workspace reconcile --run-id <run-id>`\.

Dalej\: [wybierz odpowiedni przepływ pracy](workflows.md) lub przejrzyj [dokumentację referencyjną CLI](cli-reference.md)\.
