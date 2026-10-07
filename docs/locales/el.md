<div align="center">

# Better Workflows

Το Better Workflows V5.0 RC1 είναι διαθέσιμο δημόσια: μια δωρεάν ροή εργασίας Auto ανοιχτού κώδικα για QA και παράδοση μηχανικής AI, με τρέχοντα αποδεικτικά στοιχεία, review gates και εναρμόνιση παρόχων.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · **Ελληνικά** · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Εξερεύνηση τεκμηρίωσης](https://betterworkflows.dev/el/docs/) · [Άνοιγμα GitHub](https://github.com/stephen-taipei/better-workflows) · [Υποστήριξη με USDT (TRC20)](https://betterworkflows.dev/#sponsor)

</div>

Το V5.0 RC1 καλύπτει τα Codex, Gemini CLI και Qwen Code σε macOS × Node 22/24. Η επικύρωση για Claude Code, Linux και Windows αναβάλλεται για το V5.1. Το GA απαιτεί τουλάχιστον 30 φυσικές ημέρες canary, 20 διαδοχικές επιλέξιμες εκκινήσεις και τρία διακριτά αποθετήρια.

## Οδηγήστε την εργασία του agent<br>σε αποδείξιμη ολοκλήρωση.

Το V5.0 RC1 είναι διαθέσιμο δημόσια. Το Auto ελέγχει τον στόχο, το πεδίο εφαρμογής, το αποθετήριο και τον κίνδυνο, και στη συνέχεια επιλέγει στοχευμένους ελέγχους ή μια ροή εργασίας αποδεικτικών στοιχείων. Οι αλλαγές Git χρησιμοποιούν ένα worktree που ανήκει στην εργασία· η παράδοση απαιτεί εξουσιοδότηση και ένα επαληθευμένο εξωτερικό αποτέλεσμα.

## Τέσσερα σαφή όρια από την πρόθεση έως την ολοκλήρωση.

Ορίστε το contract, επαληθεύστε πηγή και evidence, συμφωνήστε τις εξωτερικές επιδράσεις και δηλώστε ολοκλήρωση μόνο όταν είναι γνωστή η τελική κατάσταση.

- **01 · `TaskContract`** — Το V5.0 RC1 είναι διαθέσιμο δημόσια. Το Auto ελέγχει τον στόχο, το πεδίο εφαρμογής, το αποθετήριο και τον κίνδυνο, και στη συνέχεια επιλέγει στοχευμένους ελέγχους ή μια ροή εργασίας αποδεικτικών στοιχείων. Οι αλλαγές Git χρησιμοποιούν ένα worktree που ανήκει στην εργασία· η παράδοση απαιτεί εξουσιοδότηση και ένα επαληθευμένο εξωτερικό αποτέλεσμα.
- **02 · `evidence`** — Το Better Workflows V5.0 RC1 είναι διαθέσιμο δημόσια: μια δωρεάν ροή εργασίας Auto ανοιχτού κώδικα για QA και παράδοση μηχανικής AI, με τρέχοντα αποδεικτικά στοιχεία, review gates και εναρμόνιση παρόχων.
- **03 · `reconciliation`** — Ορίστε το contract, επαληθεύστε πηγή και evidence, συμφωνήστε τις εξωτερικές επιδράσεις και δηλώστε ολοκλήρωση μόνο όταν είναι γνωστή η τελική κατάσταση.
- **04 · `terminal state`** — Μια εντολή που εκτελέστηκε δεν αποδεικνύει ολοκλήρωση· ένα επανελέγξιμο αποτέλεσμα την αποδεικνύει.

## Γρήγορη εκκίνηση

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## Από τον χάρτη αρχιτεκτονικής σε πρακτικά σενάρια χρήσης.

- [Τέσσερα σαφή όρια από την πρόθεση έως την ολοκλήρωση.](https://betterworkflows.dev/el/docs/)
- [Γρήγορη εκκίνηση](https://betterworkflows.dev/el/docs/quick/)
- [Από τον χάρτη αρχιτεκτονικής σε πρακτικά σενάρια χρήσης.](https://betterworkflows.dev/el/docs/use-cases/)
- [Γρήγορη εκκίνηση — Από τον χάρτη αρχιτεκτονικής σε πρακτικά σενάρια χρήσης.](https://betterworkflows.dev/el/docs/use-cases/quick/)
- [Κινηματογράφος τεκμηρίων](https://betterworkflows.dev/el/docs/evidence-cinema/)

### Εξερεύνηση τεκμηρίωσης · `el`

Αυτή η σελίδα αναφοράς διαθέτει μεταφρασμένη επισκόπηση· το διαδραστικό περιεχόμενο δεν έχει ακόμη μεταφραστεί πλήρως.

- **01 · Τέσσερα σαφή όρια από την πρόθεση έως την ολοκλήρωση.** — Ορίστε το contract, επαληθεύστε πηγή και evidence, συμφωνήστε τις εξωτερικές επιδράσεις και δηλώστε ολοκλήρωση μόνο όταν είναι γνωστή η τελική κατάσταση.
- **02 · Από τον χάρτη αρχιτεκτονικής σε πρακτικά σενάρια χρήσης.** — Το V5.0 RC1 είναι διαθέσιμο δημόσια. Το Auto ελέγχει τον στόχο, το πεδίο εφαρμογής, το αποθετήριο και τον κίνδυνο, και στη συνέχεια επιλέγει στοχευμένους ελέγχους ή μια ροή εργασίας αποδεικτικών στοιχείων. Οι αλλαγές Git χρησιμοποιούν ένα worktree που ανήκει στην εργασία· η παράδοση απαιτεί εξουσιοδότηση και ένα επαληθευμένο εξωτερικό αποτέλεσμα.
- **03 · Γρήγορη εκκίνηση** — Το Better Workflows V5.0 RC1 είναι διαθέσιμο δημόσια: μια δωρεάν ροή εργασίας Auto ανοιχτού κώδικα για QA και παράδοση μηχανικής AI, με τρέχοντα αποδεικτικά στοιχεία, review gates και εναρμόνιση παρόχων.

- [`Τέσσερα σαφή όρια από την πρόθεση έως την ολοκλήρωση.`](https://betterworkflows.dev/docs/reference/el/index.html) · `el`
- [`Γρήγορη εκκίνηση`](https://betterworkflows.dev/docs/reference/el/preview.html) · `el`
- [`Από τον χάρτη αρχιτεκτονικής σε πρακτικά σενάρια χρήσης.`](https://betterworkflows.dev/docs/reference/el/use-cases/index.html) · `el`
- [`Γρήγορη εκκίνηση — Από τον χάρτη αρχιτεκτονικής σε πρακτικά σενάρια χρήσης.`](https://betterworkflows.dev/docs/reference/el/use-cases/preview.html) · `el`
- [`Κινηματογράφος τεκμηρίων`](https://betterworkflows.dev/docs/reference/el/evidence-cinema/index.html) · `el`

- [Εξερεύνηση τεκμηρίωσης · `el`](../details/el.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### Εξερεύνηση τεκμηρίωσης · `en`



### Εξερεύνηση τεκμηρίωσης · `el`

- [Πολιτική ασφάλειας](el/security.md) · `el`
- [Συνεισφορά](el/contributing.md) · `el`
- [Διακυβέρνηση](el/governance.md) · `el`
- [Κώδικας συμπεριφοράς](el/conduct.md) · `el`
- [Γνωστοποιήσεις σχετικά με τρίτους](el/notices.md) · `el`
- [Πλαίσιο ποιότητας README](el/readme-quality.md) · `el`
- [Εκδοτικό σύστημα χρωμάτων](el/color-system.md) · `el`
- [Αρχιτεκτονική](el/architecture.md) · `el`
- [Ασφάλεια](el/security-guide.md) · `el`
- [Αναφορά CLI](el/cli-reference.md) · `el`
- [Πρώτα βήματα](el/getting-started.md) · `el`
- [Ροές εργασίας](el/workflows.md) · `el`
- [Υποστήριξη](el/support.md) · `el`

## Βοηθήστε να διατηρείται το Better Workflows.

Μια εφάπαξ συνεισφορά στηρίζει τον ανοιχτό κώδικα, την τεκμηρίωση, τις 41 γλώσσες και τη φιλοξενία. Δεν αγοράζει συνδρομή ή προτεραιότητα σε roadmap και υποστήριξη.

[Υποστήριξη με USDT (TRC20)](https://betterworkflows.dev/#sponsor)

---

Μια εντολή που εκτελέστηκε δεν αποδεικνύει ολοκλήρωση· ένα επανελέγξιμο αποτέλεσμα την αποδεικνύει.
