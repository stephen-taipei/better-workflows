<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Wzorzec jakości README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · **Polski** · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Przegląd w 41 wersjach lokalizowanych i oficjalne punkty dostępu w sieci](../../../docs/LANGUAGES.md)\. Angielska wersja tego wzorca redakcyjnego pozostaje wersją kanoniczną\.

README projektu Better Workflows jest stroną startową\, a nie skróconym podręcznikiem referencyjnym\. Ma pomagać czytelnikowi odpowiedzieć kolejno na pięć pytań\:

1. Co to jest i czy jest dla mnie\?
2. Jaki problem rozwiązuje\?
3. Dlaczego mam ufać zawartym tu deklaracjom\?
4. Jaka jest najkrótsza droga do pierwszego sukcesu\?
5. Dokąd mam przejść dalej\?

Ten wzorzec określa kontrakt dotyczący narracji\, elementów wizualnych\, lokalizacji i walidacji każdego README w repozytorium\. Źródło w formacie czytelnym maszynowo znajduje się w [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Zacznij od decyzji czytelnika

GitHub pokazuje README przed większością treści repozytorium\. Pierwszy ekran musi więc przedstawić obietnicę produktu\, grupę docelową oraz następne działanie o określonych granicach\. Nie może zaczynać się od architektury wewnętrznej\, kompletnego wykazu poleceń ani szczegółów odzyskiwania wydań\.

Pisz z myślą o tych zadaniach czytelników\:

- **Nowy odwiedzający\:** szybko oceń\, czy Better Workflows rozwiązuje istotny problem\.
- **Nowy użytkownik\:** zainstaluj wtyczkę i przejdź jedną udaną trasę automatyczną\.
- **Osoba oceniająca\:** poznaj granice uprawnień i zachowanie fail\-closed\.
- **Powracający operator\:** przejdź od razu do odpowiedzi dotyczącej workflow\, bezpieczeństwa\, architektury lub CLI\.
- **Współtwórca lub tłumacz\:** znajdź kanoniczny kontrakt\, polecenia deweloperskie\, wsparcie i zasady zarządzania\.

## Stosuj narrację przyczynowo\-skutkową

Pięć startowych plików README stosuje tę samą ośmioczęściową sekwencję semantyczną\. Nagłówki mogą być idiomatyczne w każdym języku\, ale droga czytelnika pozostaje taka sama\.

| Sekcja | Pytanie czytelnika i rola w narracji |
| --- | --- |
| Obietnica i odbiorcy | Czym jest Better Workflows\, dlaczego istnieje i dla kogo jest przeznaczony\? |
| Od problemu do wyniku | Co idzie nie tak\, gdy utożsamia się intencję\, uprawnienia\, dowody i wynik po stronie dostawcy\? |
| Dowód i granice | Jakie gwarancje uwiarygodniają proponowany wynik\? |
| Pierwszy sukces | Jaka jest najkrótsza kompletna droga od instalacji do wyniku\? |
| Wybór dalszej ścieżki | Który przepływ pracy lub dokument odpowiada celowi czytelnika\? |
| Cykl życia | Jak cel prowadzi do zakończenia potwierdzonego uzgodnieniem stanu — albo do bezpiecznego zatrzymania\? |
| Zaufanie i ograniczenia | Czego system nigdy nie może wywnioskować\, autoryzować ani deklarować\? |
| Nauka\, pomoc i współtworzenie | Gdzie są szczegółowa dokumentacja\, pomoc\, zasady zarządzania\, informacje dla deweloperów i licencja\? |

Ta kolejność tworzy praktyczny tok narracji\:

- **Kontekst\:** praca oparta na promptach może wyrażać intencję bez potwierdzania uprawnień lub stanu\.
- **Napięcie\:** skutki uboczne zmieniają tę lukę w ryzyko dla dostarczenia wyniku\.
- **Rozwiązanie\:** Better Workflows wiąże cel\, zakres\, dowody\, przegląd\, działanie i uzgodnienie stanu z dostawcą\.
- **Dowód\:** jawne gwarancje i granice pokazują\, jak działa rozwiązanie\.
- **Działanie\:** czytelnik osiąga pierwszy sukces\, zanim zetknie się ze szczegółowymi informacjami o implementacji\.
- **Kontynuacja\:** ścieżki oparte na roli i wyniku kierują czytelnika do właściwego samouczka\, poradnika praktycznego\, objaśnienia lub materiału referencyjnego\.

## Oddziel treść startową od szczegółowej dokumentacji

Używaj README do przekazywania informacji istotnych dla decyzji\. Kieruj do szczegółów zgodnie z ich przeznaczeniem\:

- [Pierwsze kroki](getting-started.md) to samouczek pierwszego użycia\.
- [Przepływy pracy](workflows.md) to praktyczny poradnik wyboru wyniku\.
- [Architektura](architecture.md) wyjaśnia warstwę sterowania oraz korzyści i koszty poszczególnych rozwiązań\.
- [Bezpieczeństwo](security-guide.md) wyjaśnia uprawnienia\, prywatność\, poświadczenia oraz zachowanie polegające na blokowaniu działania przy braku pozytywnej weryfikacji\.
- [Dokumentacja referencyjna CLI](cli-reference.md) stanowi wykaz poleceń\.
- Zlokalizowane strony `docs/details/*.md` zachowują kompletne przetłumaczone szczegóły\.

Nie powielaj na stronie startowej informacji o odzyskiwaniu pamięci podręcznej\, własności blokad\, pełnej semantyce transportu w komunikacji z dostawcami\, wyczerpujących list poleceń ani historii zmian implementacji\. Zwięzła deklaracja bezpieczeństwa pozostaje na tej stronie\; szczegóły umożliwiające jej audyt należą do kanonicznego przewodnika\.

Ten podział jest zgodny z rozróżnieniem Diátaxis na samouczki\, poradniki praktyczne\, objaśnienia i materiały referencyjne\. Jedna strona nie może jednocześnie optymalnie zaspokajać wszystkich czterech potrzeb czytelnika\.

## Każdy element wizualny musi uzasadniać swoją obecność

Używaj elementu wizualnego tylko wtedy\, gdy pozwala zrozumieć relacje\, hierarchię lub przejścia między stanami znacznie łatwiej niż tekst\.

Strony startowe dopuszczają dwa elementy wizualne\:

1. **Architektura granic uprawnień\:** wyjaśnia\, które warstwy kształtują intencję\, aktualne fakty\, uprawnienia narzędzi\, ograniczone ponowienia i stan tylko do odczytu\.
2. **Cykl od celu do zakończenia\:** wyjaśnia\, gdzie sprawdzane są dowody\, gdzie autoryzowane są skutki uboczne i gdzie nieznany stan zatrzymuje postęp\.

Każdy element wizualny musi zawierać\:

- zwięzły i znaczący tekst alternatywny\;
- sąsiadujący odpowiednik tekstowy\, który zachowuje wniosek\, gdy element wizualny jest ukryty lub Mermaid się nie renderuje\;
- rzeczywisty tekst dla istotnych etykiet\, gdy tylko jest to możliwe\;
- stałe pytanie czytelnika\, które uzasadnia utrzymywanie aktualności elementu wizualnego\.

Nie dodawaj dekoracyjnych zrzutów ekranu\, obrazów przeładowanych tekstem ani diagramów\, które jedynie powielają krótką listę\. Ogranicz tabele wyboru do dwóch zwięzłych kolumn\, aby pozostawały użyteczne na wąskich ekranach\.

## Zachowuj znaczenie między językami

Język angielski jest odniesieniem semantycznym\, a nie wzorcem liczby wierszy\. Tradycyjny chiński\, uproszczony chiński\, japoński i koreański powinny brzmieć naturalnie dla rodzimego czytelnika\, zachowując ten sam kontrakt\.

Następujące elementy muszą pozostać równoważne\:

- osiem sekcji semantycznych i ich kolejność\;
- polecenia prowadzące do pierwszego sukcesu i identyfikatory produktu\;
- pięć deklaracji dotyczących uprawnień\, dowodów\, nieznanego stanu\, promptów i prywatności\;
- miejsca docelowe dotyczące przepływów pracy\, bezpieczeństwa\, architektury\, CLI\, pomocy\, zarządzania\, rozwoju i licencji\;
- cel elementów wizualnych\, etapy cyklu życia i alternatywy tekstowe\;
- źródło wersji i zasady stosowania plakietek\.

Nagłówki\, podział na zdania\, interpunkcja\, przykłady i wezwania do działania mogą być idiomatyczne\. Nigdy nie tłumacz poleceń\, selektorów\, identyfikatorów dowodów ani semantyki bezpieczeństwa\.

## Pisz z myślą o szybkim przeglądaniu i tłumaczeniu

- Zaczynaj od wyniku czytelnika i umieszczaj ważne pojęcia na początku nagłówków i akapitów\.
- Używaj strony czynnej i wskazuj podmiot odpowiedzialny za działanie\.
- W procedurach zwracaj się bezpośrednio do czytelnika\.
- Pisz krótkie akapity i przypisuj każdemu tylko jedno zadanie\.
- Używaj list numerowanych do sekwencji\, a wypunktowań do wyborów bez ustalonej kolejności\.
- Używaj opisowych odnośników zamiast ogólnych etykiet takich jak „kliknij tutaj”\.
- Zachowuj hierarchię i konkretność nagłówków oraz równoległą budowę na tym samym poziomie\.
- Preferuj dosłowny\, jednoznaczny język\, który zachowuje znaczenie w tłumaczeniu\.
- Umieszczaj warunki przed instrukcjami\, a oczekiwane wyniki po poleceniach\.

## Weryfikuj semantykę\, nie dekorację

Testy dokumentacji muszą wykrywać więcej niż zgodność nagłówków\. Sprawdzają\:

- jeden nagłówek H1 i logiczna hierarchia nagłówków\;
- uporządkowana sekcja semantyczna i znaczniki kluczowych deklaracji\;
- precyzyjne polecenia gwarantujące sukces za pierwszym razem i stabilne identyfikatory\;
- łącza względne i cele szczegółów właściwe dla danej lokalizacji\;
- zgodność plakietki wersji z metadanymi środowiska uruchomieniowego\;
- znaczący tekst alternatywny obrazów i sąsiadujące wizualne elementy zastępcze\;
- pojedynczy cykl życia Mermaid z pełnym odpowiednikiem tekstowym\;
- tabela dwukolumnowa i limity długości akapitów\;
- brak wyznaczonych szczegółów głębokiej implementacji na stronach docelowych\;

## Podstawa badawcza

- [GitHub\: Informacje o pliku README repozytorium](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) określa rolę README podczas pierwszej wizyty i zaleca przenoszenie obszernej dokumentacji w inne miejsce\.
- [Diátaxis](https://diataxis.fr/start-here/) rozdziela potrzeby związane z samouczkami\, poradnikami praktycznymi\, objaśnieniami i materiałami referencyjnymi\.
- [Microsoft\: Treść łatwa do szybkiego przeglądania](https://learn.microsoft.com/en-us/style-guide/scannable-content/) podkreśla strukturę przedstawiającą najważniejsze informacje na początku\, krótkie akapity i spójne wizualne punkty wejścia\.
- [Styl dokumentacji deweloperskiej Google](https://developers.google.com/style/highlights) zaleca stronę czynną\, bezpośrednie zwracanie się do czytelnika\, opisowe nagłówki\, dostępność i pisanie z myślą o odbiorcach z całego świata\.
- [GitHub\: Tworzenie diagramów](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) dokumentuje obsługę Mermaid w Markdown\.
- [W3C WAI\: Samouczek dotyczący obrazów](https://www.w3.org/WAI/tutorials/images/) wymaga alternatyw tekstowych i pełnych odpowiedników informacyjnych oraz złożonych elementów wizualnych\.
