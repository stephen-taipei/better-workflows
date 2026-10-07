<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Πρώτα βήματα

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · **Ελληνικά** · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

Το V5\.0 RC1 καλύπτει τα Codex\, Gemini CLI και Qwen Code σε macOS × Node 22\/24\. Η επικύρωση για Claude Code\, Linux και Windows αναβάλλεται για το V5\.1\. Το GA απαιτεί τουλάχιστον 30 φυσικές ημέρες canary\, 20 διαδοχικές επιλέξιμες εκκινήσεις και τρία διακριτά αποθετήρια\.

| [Επισκόπηση](../../../README.md) | [Λεπτομέρειες](../../../docs/details/en.md) | **Γρήγορη εκκίνηση** | [Ροές εργασίας](workflows.md) | [Αρχιτεκτονική](architecture.md) | [Ασφάλεια](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Επισκόπηση σε 41 τοπικοποιημένες εκδόσεις και επίσημα σημεία πρόσβασης στον ιστό](../../../docs/LANGUAGES.md)\. Οι εντολές και τα αναγνωριστικά παραμένουν στην κανονική αγγλική τους μορφή\.

Το V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) είναι διαθέσιμο δημόσια\. Το πεδίο κυκλοφορίας του καλύπτει μόνο το Auto\, με τα Codex\, Gemini CLI και Qwen Code σε macOS Node 22\/24\. Ο έλεγχος καταλληλότητας για Linux και Windows αναβάλλεται για το V5\.1\, όπως και για το Claude Code\. Το GA `5.0.0` παραμένει σε εκκρεμότητα έως ότου καταγραφούν τουλάχιστον 30 φυσικές ημέρες canary\, 20 διαδοχικές έγκυρες εκκινήσεις και τρία διαφορετικά αποθετήρια\.

## Απαιτήσεις

- Node\.js 22\.14 ή νεότερο για το ενσωματωμένο βοηθητικό πρόγραμμα `sbw`\.
- Ένα αξιόπιστο τοπικό αποθετήριο\. Το Better Workflows δεν ισχυρίζεται ότι εκτελεί σε sandbox κακόβουλο κώδικα αποθετηρίου\.

Ο ριζικός κατάλογος κατάστασης της v4 είναι ανεξάρτητος από την πλατφόρμα πρακτόρων\: το `SBW_STATE_ROOT` υπερισχύει όταν έχει οριστεί\, ακολουθεί το `XDG_STATE_HOME/better-workflows`\, διαφορετικά χρησιμοποιείται το `~/.better-workflows`\. Η προεπιλεγμένη θέση δεν βρίσκεται πλέον κάτω από το `CODEX_HOME`\. Για να συνεχίσεις να χρησιμοποιείς μια υπάρχουσα κατάσταση v3 για το Codex χωρίς να τη μετακινήσεις\, όρισε ρητά το `SBW_STATE_ROOT` σε εκείνον ακριβώς τον κατάλογο `<CODEX_HOME>/sbw` πριν καλέσεις το `sbw`\.

Το V5\.0 GA \(`5.0.0`\) παραμένει σε εκκρεμότητα\. Οι παρακάτω εντολές εγκατάστασης στοχεύουν στο δημόσια διαθέσιμο V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\)\.

## Εγκατάσταση

### Codex — προτεινόμενο περιβάλλον αναφοράς

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

Άνοιξε μια νέα εργασία Codex μετά την εγκατάσταση\, ώστε να ανανεωθεί ο κατάλογος δεξιοτήτων της\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Το Gemini CLI αντιγράφει την επέκταση\. Κάνε επανεκκίνηση της συνεδρίας μετά την εγκατάσταση· για να την ενημερώσεις αργότερα\, χρησιμοποίησε το `gemini extensions update better-workflows`\.

Το πλαίσιο της επέκτασης εντοπίζει τη γέφυρα από τη διαδρομή του δικού της φορτωμένου πηγαίου κώδικα\, όχι από τον κατάλογο εργασίας του έργου σου\. Για μια τυπική εγκατάσταση σε επίπεδο χρήστη\, ο αντίστοιχος χειροκίνητος έλεγχος είναι\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Για μια επέκταση εγκατεστημένη μέσω συνδέσμου ή μόνο για τον χώρο εργασίας\, χρησιμοποίησε τον ακριβή ριζικό κατάλογο της επέκτασης που εμφανίζει η πλατφόρμα πρακτόρων\. Μην τον αντικαθιστάς με αντίγραφο εργασίας με παρόμοιο όνομα\.

### Qwen Code

Κλείδωσε την έκδοση κυκλοφορίας πριν εγκαταστήσεις το τοπικό αντίγραφο της επέκτασης\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Το Qwen Code αντιγράφει επίσης την επέκταση\, οπότε κάνε επανεκκίνηση της συνεδρίας μετά την εγκατάσταση και χρησιμοποίησε το `qwen extensions update better-workflows` για μελλοντικές ενημερώσεις\.

Για μια τυπική εγκατάσταση σε επίπεδο χρήστη\, ο αντίστοιχος χειροκίνητος έλεγχος της γέφυρας είναι\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Ο ίδιος κανόνας για τον ακριβή ριζικό κατάλογο ισχύει για εγκαταστάσεις μέσω συνδέσμου ή σε επίπεδο χώρου εργασίας\.

## Χρήση του Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Κάθε σημείο εισόδου διατηρεί το ζητούμενο Goal\. Ένα άσχετο ενεργό Goal πρέπει να τροποποιηθεί ή να εκκαθαριστεί ρητά· δεν αντικαθίσταται ποτέ σιωπηρά\.

## Προεπισκόπηση της διαδρομής

Το στιγμιότυπο δυνατοτήτων είναι μόνο για ανάγνωση και δεν ενεργοποιεί σύνδεση στον πάροχο ή σημασιολογικό έλεγχο του μοντέλου\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Για μια παράδοση που μπορεί να ελεγχθεί\, καταχώρισε και χρησιμοποίησε μία ιδιωτική\, επαληθεύσιμη εγγραφή μίας χρήσης\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Οι εγγραφές λήγουν μετά από 24 ώρες και η χρήση τους απορρίπτεται για λόγους ασφαλείας σε περίπτωση επαναχρησιμοποίησης ή απόκλισης στον χώρο εργασίας\, το πεδίο εφαρμογής\, τα Profiles\, τον κατάλογο\, τις δυνατότητες ή το πακέτο του πρόσθετου\.

## Επαλήθευσε την εγκατάσταση

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Πριν από τροποποίηση αποθετηρίου

Το Auto ξεκινά με έναν προκαταρκτικό έλεγχο του χώρου εργασίας που εκτελεί μόνο αναγνώσεις\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Οι εργασίες που δεν χρησιμοποιούν Git και οι εργασίες μόνο για ανάγνωση δεν δημιουργούν worktree\. Μια εργασία Git που κάνει αλλαγές πρέπει να δημιουργήσει ή να επαναχρησιμοποιήσει ένα `TaskWorkspaceLeaseV1` που ανήκει στην εργασία\. Αν ο κατάλογος εργασίας του πηγαίου κώδικα περιέχει αλλαγές που δεν έχουν καταχωριστεί σε commit\, η διαδικασία σταματά πριν από οποιοδήποτε stash\, αντιγραφή\, commit ή δημιουργία worktree\. Αποσυνδεδεμένο HEAD ή απουσία προορισμού απαιτεί ρητό προορισμό ενσωμάτωσης\. Οι προστατευμένοι ή απομακρυσμένοι προορισμοί μεταφέρονται σε παράδοση μέσω PR που υπόκειται σε κανόνες διακυβέρνησης\.

Αν το Codex ή άλλη πλατφόρμα πρακτόρων έχει ήδη δημιουργήσει το καθαρό worktree της τρέχουσας εργασίας\, καταχώρισέ το πριν από την επεξεργασία\, αντί να δημιουργήσεις ένα ένθετο worktree\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Η καταχώριση απαιτεί ξεχωριστό κλάδο εργασίας της μορφής `codex/*` στην αμετάβλητη αναθεώρηση βάσης\, τον ίδιο κοινό κατάλογο Git και καθαρό αντίγραφο εργασίας της πηγής\. Το Better Workflows χρησιμοποιεί το worktree\, αλλά κατά την εκκαθάριση διατηρεί τον κλάδο και τη διαδρομή που ανήκουν στην πλατφόρμα πρακτόρων\. Για προστατευμένο προορισμό\, εκτέλεσε πρώτα τη ροή εργασίας τεκμηρίων και έπειτα σύνδεσε τις ακριβείς επαληθεύσιμες εγγραφές της για τη συγχώνευση PR και τον απομακρυσμένο συγχρονισμό με το `workspace reconcile --run-id <run-id>`\.

Στη συνέχεια\: [επιλέξτε τη σωστή ροή εργασίας](workflows.md) ή περιηγηθείτε στην [αναφορά CLI](cli-reference.md)\.
