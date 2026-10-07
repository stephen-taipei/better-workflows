<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Συνεισφορά

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · **Ελληνικά** · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Σας ευχαριστούμε που βοηθάτε στη βελτίωση του Better Workflows\.

[README](../../../README.md) · **Συνεισφορά** · [Κώδικας συμπεριφοράς](conduct.md) · [Ασφάλεια](security.md) · [Διακυβέρνηση](governance.md) · [Υποστήριξη](support.md)

[Επισκόπηση σε 41 τοπικοποιημένες εκδόσεις και επίσημα σημεία πρόσβασης στον ιστό](../../../docs/LANGUAGES.md)\. Η αγγλική έκδοση αυτής της κανονιστικής πολιτικής συνεισφοράς παραμένει η αυθεντική πηγή αναφοράς\.

## Πριν ξεκινήσετε

- Χρησιμοποιήστε πρώτα ένα issue ή discussion για ένα νέο δημόσιο contract\, μια αλλαγή στη δημόσια συμπεριφορά του Auto\, ένα όριο ασφαλείας ή μια μεγάλη αρχιτεκτονική αλλαγή\.
- Διατηρήστε κάθε pull request εστιασμένο σε ένα μόνο αποτέλεσμα\.
- Μην κάνετε ποτέ commit διαπιστευτήρια\, ιδιωτικά prompt\, ανεπεξέργαστο ιστορικό συνομιλίας\, κλειδιά υπογραφής κεντρικού υπολογιστή\, αποδείξεις παρόχου ή υπογεγραμμένες βεβαιώσεις\.
- Αναφέρετε ευπάθειες ιδιωτικά όπως περιγράφεται στο [SECURITY\.md](security.md)\.

## Ρύθμιση περιβάλλοντος ανάπτυξης

Απαιτήσεις\:

- Node\.js 24 ή νεότερη έκδοση·
- καμία εξάρτηση τρίτου μέρους κατά την εκτέλεση·
- καθαρός κλάδος βασισμένος στον τρέχοντα κλάδο προορισμού\.

Εκτελέστε ολόκληρο το τοπικό σύνολο βασικών ελέγχων\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Κανόνες αλλαγών

1. Διατηρήστε τις μεταλλάξεις υπό την ιδιοκτησία του Root και τα fail\-closed όρια παρενεργειών\.
2. Όταν αλλάζει η δημόσια συμπεριφορά του Auto\, ενημερώστε ταυτόχρονα το πρότυπο και το skill του\, τον κατάλογο entrypoint\, το CLI\, τις δοκιμές και όλη την επηρεαζόμενη τεκμηρίωση\.
3. Απορρίψτε άγνωστες επιλογές CLI και άγνωστα πεδία schema\.
4. Διατηρήστε την ιδιωτική κατάσταση χρόνου εκτέλεσης εκτός του αποθετηρίου\.
5. Προσθέστε αρνητικές δοκιμές για κάθε νέα πύλη ασφαλείας\.
6. Μην τροποποιείτε μια υπάρχουσα αμετάβλητη έκδοση plugin\-cache\. Ένα τροποποιημένο bundle απαιτεί νέα έκδοση build και ακριβή επαλήθευση digest πηγής\/cache\.

Για αναδιοργάνωση που αφορά μόνο το README\, διατηρήστε την αρχική σελίδα ευανάγνωστη με μια ματιά και τοποθετήστε τα αναλυτικά συμβόλαια στο αντίστοιχο αρχείο κάτω από το [`docs/guide/`](../../../docs/guide/)\.

## Λίστα ελέγχου αιτήματος ενσωμάτωσης

- [ ] Το πεδίο εφαρμογής και όσα δεν αποτελούν στόχους είναι ρητά διατυπωμένα\.
- [ ] Η συμπεριφορά και τα όρια ασφάλειας είναι τεκμηριωμένα\.
- [ ] Οι στοχευμένες δοκιμές καλύπτουν διαδρομές επιτυχίας και αποτυχίας\.
- [ ] Ολόκληρη η σουίτα δοκιμών και το `sbw eval` ολοκληρώνονται επιτυχώς\.
- [ ] Το `git diff --check` ολοκληρώνεται επιτυχώς\.
- [ ] Οι αλλαγές έκδοσης και κρυφής μνήμης ακολουθούν τους κανόνες αμετάβλητης δημοσίευσης\, όπου εφαρμόζονται\.
- [ ] Δεν περιλαμβάνονται μυστικά\, ιδιωτική κατάσταση ή εξωτερικά αποδεικτικά\.

Προτιμώνται μικρές καταχωρίσεις αλλαγών που μπορούν να ελεγχθούν εύκολα\. Μην συνδυάζετε άσχετες εργασίες καθαρισμού με αλλαγή συμπεριφοράς\.
