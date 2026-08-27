export const LOCALE_KEYS = [
  "TITLE",
  "DESCRIPTION",
  "SKIP",
  "MENU",
  "LANGUAGE",
  "HERO_TITLE",
  "HERO_ACCENT",
  "HERO_LEAD",
  "DOCS_CTA",
  "GITHUB_CTA",
  "CONTROL_TITLE",
  "CONTROL_SUMMARY",
  "REPO_TITLE",
  "REPO_BODY",
  "QUICK_START",
  "DOCS_TITLE",
  "CLOSING_TITLE",
  "THEME_LIGHT",
  "THEME_DARK",
  "SPONSOR_CTA",
  "SPONSOR_TITLE",
  "SPONSOR_BODY"
];

export const CONNECTORS_LOCALES = [
  "en", "zh-Hant", "zh-Hant-TW", "zh-Hant-HK", "zh-Hans", "vi", "uk", "tr", "th", "sv", "sk", "ru", "ro", "pt", "pt-BR", "pl", "nl", "nb", "my", "ms", "lo", "ko", "km", "ja", "it", "id", "hu", "hr", "hi", "he", "fr", "fil", "fi", "es", "es-MX", "el", "de", "da", "cs", "ca", "ar"
];

export const DEFAULT_LOCALE = "zh-Hant-TW";

export const locales = [
  {
    code: "ar", label: "العربية", dir: "rtl", messages: {
      TITLE: "Better Workflows | سير عمل للوكلاء قابل للإثبات",
      DESCRIPTION: "طبقة تحكم مفتوحة المصدر تبدأ بالهدف وتربط سير عمل الوكلاء بأدلة راهنة ومراجعات ومطابقة موفر الخدمة.",
      SKIP: "الانتقال إلى المحتوى الرئيسي", MENU: "القائمة", LANGUAGE: "اللغة",
      HERO_TITLE: "انقل عمل الوكيل", HERO_ACCENT: "إلى إنجاز يمكن إثباته.",
      HERO_LEAD: "يثبّت Better Workflows الهدف والنطاق والصلاحية، ثم يربط كل قرار بأدلة راهنة قابلة لإعادة التحقق وبنتيجة خارجية تمت مطابقتها.",
      DOCS_CTA: "استكشف الوثائق", GITHUB_CTA: "افتح GitHub",
      CONTROL_TITLE: "أربع حدود واضحة بين النية والإنجاز.",
      CONTROL_SUMMARY: "حدّد العقد، تحقّق من المصدر والأدلة، طابق الآثار الخارجية، ثم أعلن الاكتمال فقط عندما تكون الحالة النهائية معروفة.",
      REPO_TITLE: "المصدر الرسمي موجود على GitHub.",
      REPO_BODY: "راجع الشيفرة والقوالب وعقود الأدلة والاختبارات في المستودع العام. ملف README هو نقطة البدء المعتمدة.",
      QUICK_START: "البدء السريع", DOCS_TITLE: "تابع من الخريطة المعمارية إلى حالات الاستخدام العملية.",
      CLOSING_TITLE: "تشغيل أمر ليس دليلاً على الاكتمال؛ النتيجة القابلة لإعادة التحقق هي الدليل.",
      THEME_LIGHT: "التبديل إلى الوضع الفاتح", THEME_DARK: "التبديل إلى الوضع الداكن"
    }
  },
  {
    code: "ca", label: "Català", messages: {
      TITLE: "Better Workflows | Fluxos d’agents demostrables",
      DESCRIPTION: "Pla de control de codi obert i orientat a objectius per a fluxos d’agents amb evidència actualitzada, revisions i conciliació del proveïdor.",
      SKIP: "Ves al contingut principal", MENU: "Menú", LANGUAGE: "Idioma",
      HERO_TITLE: "Porta la feina dels agents", HERO_ACCENT: "fins a un final demostrable.",
      HERO_LEAD: "Better Workflows fixa l’objectiu, l’abast i l’autoritat, i vincula cada decisió a evidència actualitzada i revalidable i a un resultat extern conciliat.",
      DOCS_CTA: "Explora la documentació", GITHUB_CTA: "Obre GitHub",
      CONTROL_TITLE: "Quatre límits clars entre la intenció i la finalització.",
      CONTROL_SUMMARY: "Defineix el contracte, verifica la font i l’evidència, concilia els efectes externs i només declara la finalització quan l’estat terminal és conegut.",
      REPO_TITLE: "El codi font oficial és a GitHub.",
      REPO_BODY: "Consulta el codi, les plantilles, els contractes d’evidència i les proves al repositori públic. El README és el punt d’inici canònic.",
      QUICK_START: "Inici ràpid", DOCS_TITLE: "Passa del mapa d’arquitectura als casos d’ús pràctics.",
      CLOSING_TITLE: "Executar una ordre no prova que la feina s’hagi acabat; un resultat revalidable sí.",
      THEME_LIGHT: "Canvia al tema clar", THEME_DARK: "Canvia al tema fosc"
    }
  },
  {
    code: "cs", label: "Čeština", messages: {
      TITLE: "Better Workflows | Prokazatelné pracovní postupy agentů",
      DESCRIPTION: "Open-source řídicí vrstva zaměřená na cíle pro pracovní postupy agentů s aktuálními důkazy, kontrolami a vyrovnáním stavu poskytovatele.",
      SKIP: "Přejít na hlavní obsah", MENU: "Nabídka", LANGUAGE: "Jazyk",
      HERO_TITLE: "Doveďte práci agentů", HERO_ACCENT: "k prokazatelnému dokončení.",
      HERO_LEAD: "Better Workflows ukotví cíl, rozsah a oprávnění a každé rozhodnutí sváže s aktuálními, znovu ověřitelnými důkazy a vyrovnaným externím výsledkem.",
      DOCS_CTA: "Prozkoumat dokumentaci", GITHUB_CTA: "Otevřít GitHub",
      CONTROL_TITLE: "Čtyři jasné hranice mezi záměrem a dokončením.",
      CONTROL_SUMMARY: "Definujte smlouvu, ověřte zdroj a důkazy, vyrovnejte externí dopady a dokončení potvrďte teprve tehdy, když je koncový stav známý.",
      REPO_TITLE: "Oficiální zdrojový kód je na GitHubu.",
      REPO_BODY: "Ve veřejném repozitáři najdete kód, šablony, smlouvy důkazů i testy. Kanonickým výchozím bodem je README.",
      QUICK_START: "Rychlý start", DOCS_TITLE: "Přejděte od mapy architektury k praktickým scénářům.",
      CLOSING_TITLE: "Spuštěný příkaz není důkaz dokončení; znovu ověřitelný výsledek ano.",
      THEME_LIGHT: "Přepnout na světlý motiv", THEME_DARK: "Přepnout na tmavý motiv"
    }
  },
  {
    code: "da", label: "Dansk", messages: {
      TITLE: "Better Workflows | Dokumenterbare agent-workflows",
      DESCRIPTION: "Open source, goal-first kontrolplan til agent-workflows med aktuel evidens, review-gates og afstemning mod udbyderen.",
      SKIP: "Gå til hovedindhold", MENU: "Menu", LANGUAGE: "Sprog",
      HERO_TITLE: "Før agentarbejde", HERO_ACCENT: "helt frem til en dokumenterbar afslutning.",
      HERO_LEAD: "Better Workflows fastlåser mål, scope og authority og binder hver beslutning til aktuel, genvaliderbar evidens og et afstemt eksternt resultat.",
      DOCS_CTA: "Udforsk dokumentationen", GITHUB_CTA: "Åbn GitHub",
      CONTROL_TITLE: "Fire tydelige grænser mellem hensigt og afslutning.",
      CONTROL_SUMMARY: "Definér kontrakten, verificér kilde og evidens, afstem eksterne effekter, og erklær først arbejdet færdigt, når sluttilstanden er kendt.",
      REPO_TITLE: "Den officielle kildekode ligger på GitHub.",
      REPO_BODY: "Se kode, skabeloner, evidence contracts og test i det offentlige kodearkiv. README er det kanoniske startpunkt.",
      QUICK_START: "Kom hurtigt i gang", DOCS_TITLE: "Gå fra arkitekturkortet til praktiske brugsscenarier.",
      CLOSING_TITLE: "En kørt kommando beviser ikke, at arbejdet er færdigt; et genvaliderbart resultat gør.",
      THEME_LIGHT: "Skift til lyst tema", THEME_DARK: "Skift til mørkt tema"
    }
  },
  {
    code: "de", label: "Deutsch", messages: {
      TITLE: "Better Workflows | Nachweisbare Agent-Workflows",
      DESCRIPTION: "Open-Source-Control-Plane nach dem Goal-first-Prinzip für Agent-Workflows mit aktuellen Nachweisen, Review-Gates und Provider-Abgleich.",
      SKIP: "Zum Hauptinhalt springen", MENU: "Menü", LANGUAGE: "Sprache",
      HERO_TITLE: "Agent-Arbeit bis", HERO_ACCENT: "zum nachweisbaren Abschluss führen.",
      HERO_LEAD: "Better Workflows fixiert Ziel, Scope und Authority und bindet jede Entscheidung an aktuelle, erneut prüfbare Nachweise sowie ein abgeglichenes externes Ergebnis.",
      DOCS_CTA: "Dokumentation ansehen", GITHUB_CTA: "GitHub öffnen",
      CONTROL_TITLE: "Vier klare Grenzen zwischen Absicht und Abschluss.",
      CONTROL_SUMMARY: "Vertrag definieren, Quelle und Nachweise prüfen, externe Effekte abgleichen und erst abschließen, wenn der Endzustand bekannt ist.",
      REPO_TITLE: "Der offizielle Quellcode liegt auf GitHub.",
      REPO_BODY: "Code, Templates, Evidence Contracts und Tests sind im öffentlichen Repository einsehbar. Das README ist der kanonische Einstieg.",
      QUICK_START: "Schnellstart", DOCS_TITLE: "Von der Architekturübersicht zu praktischen Anwendungsfällen.",
      CLOSING_TITLE: "Ein ausgeführter Befehl beweist keinen Abschluss; ein erneut prüfbares Ergebnis schon.",
      THEME_LIGHT: "Zum hellen Design wechseln", THEME_DARK: "Zum dunklen Design wechseln"
    }
  },
  {
    code: "el", label: "Ελληνικά", messages: {
      TITLE: "Better Workflows | Αποδείξιμες ροές εργασίας agent",
      DESCRIPTION: "Ανοιχτού κώδικα, goal-first επίπεδο ελέγχου για ροές agent με επίκαιρα αποδεικτικά στοιχεία, πύλες ελέγχου και συμφωνία παρόχου.",
      SKIP: "Μετάβαση στο κύριο περιεχόμενο", MENU: "Μενού", LANGUAGE: "Γλώσσα",
      HERO_TITLE: "Οδηγήστε την εργασία του agent", HERO_ACCENT: "σε αποδείξιμη ολοκλήρωση.",
      HERO_LEAD: "Το Better Workflows παγώνει goal, scope και authority και συνδέει κάθε απόφαση με επίκαιρα, επανελέγξιμα αποδεικτικά στοιχεία και συμφωνημένο εξωτερικό αποτέλεσμα.",
      DOCS_CTA: "Εξερεύνηση τεκμηρίωσης", GITHUB_CTA: "Άνοιγμα GitHub",
      CONTROL_TITLE: "Τέσσερα σαφή όρια από την πρόθεση έως την ολοκλήρωση.",
      CONTROL_SUMMARY: "Ορίστε το contract, επαληθεύστε πηγή και evidence, συμφωνήστε τις εξωτερικές επιδράσεις και δηλώστε ολοκλήρωση μόνο όταν είναι γνωστή η τελική κατάσταση.",
      REPO_TITLE: "Ο επίσημος πηγαίος κώδικας βρίσκεται στο GitHub.",
      REPO_BODY: "Δείτε κώδικα, πρότυπα, evidence contracts και δοκιμές στο δημόσιο αποθετήριο. Το README είναι το κανονικό σημείο εκκίνησης.",
      QUICK_START: "Γρήγορη εκκίνηση", DOCS_TITLE: "Από τον χάρτη αρχιτεκτονικής σε πρακτικά σενάρια χρήσης.",
      CLOSING_TITLE: "Μια εντολή που εκτελέστηκε δεν αποδεικνύει ολοκλήρωση· ένα επανελέγξιμο αποτέλεσμα την αποδεικνύει.",
      THEME_LIGHT: "Εναλλαγή σε φωτεινό θέμα", THEME_DARK: "Εναλλαγή σε σκοτεινό θέμα"
    }
  },
  {
    code: "en", label: "English", messages: {
      TITLE: "Better Workflows | Provable agent workflows",
      DESCRIPTION: "An open-source, goal-first control plane for agent workflows with current evidence, review gates, source binding, and provider reconciliation.",
      SKIP: "Skip to main content", MENU: "Menu", LANGUAGE: "Language",
      HERO_TITLE: "Take agent work", HERO_ACCENT: "to a provable finish.",
      HERO_LEAD: "Better Workflows freezes the goal, scope, and authority, then binds every decision to current, re-verifiable evidence and a reconciled external outcome.",
      DOCS_CTA: "Explore the documentation", GITHUB_CTA: "Open GitHub",
      CONTROL_TITLE: "Four explicit boundaries from intent to completion.",
      CONTROL_SUMMARY: "Define the contract, verify source and evidence, reconcile external effects, and declare completion only when the terminal state is known.",
      REPO_TITLE: "The official source lives on GitHub.",
      REPO_BODY: "Inspect the code, templates, evidence contracts, and tests in the public repository. The README is the canonical starting point.",
      QUICK_START: "Quick start", DOCS_TITLE: "Move from the architecture map to practical use cases.",
      CLOSING_TITLE: "Running a command is not proof of completion; a re-verifiable outcome is.",
      THEME_LIGHT: "Switch to light theme", THEME_DARK: "Switch to dark theme"
    }
  },
  {
    code: "es", label: "Español", messages: {
      TITLE: "Better Workflows | Flujos de agentes demostrables",
      DESCRIPTION: "Plano de control open source y goal-first para flujos de agentes con evidencia actualizada, revisiones, enlace al origen y conciliación del proveedor.",
      SKIP: "Saltar al contenido principal", MENU: "Menú", LANGUAGE: "Idioma",
      HERO_TITLE: "Lleva el trabajo de los agentes", HERO_ACCENT: "hasta un final demostrable.",
      HERO_LEAD: "Better Workflows fija el objetivo, el alcance y la autoridad, y vincula cada decisión con evidencia actualizada y revalidable y con un resultado externo conciliado.",
      DOCS_CTA: "Explorar la documentación", GITHUB_CTA: "Abrir GitHub",
      CONTROL_TITLE: "Cuatro límites explícitos entre la intención y la finalización.",
      CONTROL_SUMMARY: "Define el contrato, verifica la fuente y la evidencia, concilia los efectos externos y declara el trabajo terminado solo cuando se conoce el estado final.",
      REPO_TITLE: "El código fuente oficial está en GitHub.",
      REPO_BODY: "Consulta el código, las plantillas, los contratos de evidencia y las pruebas en el repositorio público. El README es el punto de partida canónico.",
      QUICK_START: "Inicio rápido", DOCS_TITLE: "Pasa del mapa de arquitectura a casos de uso prácticos.",
      CLOSING_TITLE: "Ejecutar un comando no demuestra que el trabajo terminó; un resultado revalidable sí.",
      THEME_LIGHT: "Cambiar al tema claro", THEME_DARK: "Cambiar al tema oscuro"
    }
  },
  {
    code: "es-MX", label: "Español (México)", messages: {
      TITLE: "Better Workflows | Flujos de agentes comprobables",
      DESCRIPTION: "Plano de control de código abierto y goal-first para flujos de agentes con evidencia vigente, revisiones y conciliación con el proveedor.",
      SKIP: "Ir al contenido principal", MENU: "Menú", LANGUAGE: "Idioma",
      HERO_TITLE: "Lleva el trabajo de los agentes", HERO_ACCENT: "hasta un cierre comprobable.",
      HERO_LEAD: "Better Workflows fija el objetivo, el alcance y la autoridad, y enlaza cada decisión con evidencia vigente que puede revisarse de nuevo y con un resultado externo conciliado.",
      DOCS_CTA: "Explorar la documentación", GITHUB_CTA: "Abrir GitHub",
      CONTROL_TITLE: "Cuatro límites claros entre la intención y el cierre.",
      CONTROL_SUMMARY: "Define el contrato, verifica la fuente y la evidencia, concilia los efectos externos y marca como terminado solo cuando conoces el estado final.",
      REPO_TITLE: "El código fuente oficial está en GitHub.",
      REPO_BODY: "Revisa el código, las plantillas, los contratos de evidencia y las pruebas en el repositorio público. El README es el punto de partida oficial.",
      QUICK_START: "Guía rápida", DOCS_TITLE: "Pasa del mapa de arquitectura a casos de uso reales.",
      CLOSING_TITLE: "Que un comando corra no comprueba que el trabajo terminó; un resultado que puedes volver a validar sí.",
      THEME_LIGHT: "Cambiar a tema claro", THEME_DARK: "Cambiar a tema oscuro"
    }
  },
  {
    code: "fi", label: "Suomi", messages: {
      TITLE: "Better Workflows | Todennettavat agenttityönkulut",
      DESCRIPTION: "Avoimen lähdekoodin goal-first-ohjaustaso agenttityönkuluille, joissa käytetään ajantasaista näyttöä, tarkastusportteja ja palveluntarjoajan täsmäytystä.",
      SKIP: "Siirry pääsisältöön", MENU: "Valikko", LANGUAGE: "Kieli",
      HERO_TITLE: "Vie agenttien työ", HERO_ACCENT: "todennettavaan päätökseen.",
      HERO_LEAD: "Better Workflows lukitsee tavoitteen, laajuuden ja valtuudet sekä sitoo jokaisen päätöksen ajantasaiseen, uudelleen varmennettavaan näyttöön ja täsmäytettyyn ulkoiseen tulokseen.",
      DOCS_CTA: "Tutustu dokumentaatioon", GITHUB_CTA: "Avaa GitHub",
      CONTROL_TITLE: "Neljä selkeää rajaa aikomuksesta valmistumiseen.",
      CONTROL_SUMMARY: "Määritä sopimus, varmista lähde ja näyttö, täsmäytä ulkoiset vaikutukset ja ilmoita valmiiksi vasta, kun lopputila tunnetaan.",
      REPO_TITLE: "Virallinen lähdekoodi on GitHubissa.",
      REPO_BODY: "Tutki julkisessa repositoriossa koodia, malleja, evidence contract -määrityksiä ja testejä. README on ensisijainen aloituspiste.",
      QUICK_START: "Pika-aloitus", DOCS_TITLE: "Siirry arkkitehtuurikartasta käytännön käyttötapauksiin.",
      CLOSING_TITLE: "Komennon suorittaminen ei todista valmistumista; uudelleen varmennettava tulos todistaa.",
      THEME_LIGHT: "Vaihda vaaleaan teemaan", THEME_DARK: "Vaihda tummaan teemaan"
    }
  },
  {
    code: "fil", label: "Filipino", messages: {
      TITLE: "Better Workflows | Mga napapatunayang workflow ng agent",
      DESCRIPTION: "Open-source na control plane na inuuna ang layunin para sa mga daloy ng trabaho ng agent, na may napapanahong ebidensya, mga tarangkahan ng pagsusuri, at pagtutugma sa provider.",
      SKIP: "Lumaktaw sa pangunahing nilalaman", MENU: "Menu", LANGUAGE: "Wika",
      HERO_TITLE: "Dalhin ang trabaho ng agent", HERO_ACCENT: "sa napapatunayang pagtatapos.",
      HERO_LEAD: "Itinatakda ng Better Workflows ang layunin, saklaw, at awtoridad, at itinatali ang bawat desisyon sa napapanahon at muling mapapatunayang ebidensya at naipagtugmang panlabas na resulta.",
      DOCS_CTA: "Tingnan ang dokumentasyon", GITHUB_CTA: "Buksan ang GitHub",
      CONTROL_TITLE: "Apat na malinaw na hangganan mula intensyon hanggang pagkumpleto.",
      CONTROL_SUMMARY: "Itakda ang kasunduan, beripikahin ang pinagmulan at ebidensya, itugma ang mga panlabas na epekto, at ideklarang kumpleto lamang kapag tiyak na ang panghuling kalagayan.",
      REPO_TITLE: "Nasa GitHub ang opisyal na source code.",
      REPO_BODY: "Suriin ang code, mga padron, kontrata ng ebidensya, at mga pagsubok sa pampublikong imbakan. Ang README ang opisyal na panimulang punto.",
      QUICK_START: "Mabilisang simula", DOCS_TITLE: "Mula sa mapa ng arkitektura tungo sa mga praktikal na kaso ng paggamit.",
      CLOSING_TITLE: "Ang pagpapatakbo ng utos ay hindi patunay ng pagkumpleto; ang muling mapapatunayang resulta ang patunay.",
      THEME_LIGHT: "Lumipat sa maliwanag na tema", THEME_DARK: "Lumipat sa madilim na tema"
    }
  },
  {
    code: "fr", label: "Français", messages: {
      TITLE: "Better Workflows | Workflows d’agents démontrables",
      DESCRIPTION: "Plan de contrôle open source et goal-first pour workflows d’agents, avec preuves à jour, revues, liaison à la source et rapprochement avec le fournisseur.",
      SKIP: "Aller au contenu principal", MENU: "Menu", LANGUAGE: "Langue",
      HERO_TITLE: "Conduisez le travail des agents", HERO_ACCENT: "jusqu’à une fin démontrable.",
      HERO_LEAD: "Better Workflows fige l’objectif, le périmètre et l’autorité, puis relie chaque décision à des preuves à jour et revérifiables ainsi qu’à un résultat externe rapproché.",
      DOCS_CTA: "Explorer la documentation", GITHUB_CTA: "Ouvrir GitHub",
      CONTROL_TITLE: "Quatre frontières explicites entre l’intention et l’achèvement.",
      CONTROL_SUMMARY: "Définissez le contrat, vérifiez la source et les preuves, rapprochez les effets externes, puis ne déclarez la fin que lorsque l’état terminal est connu.",
      REPO_TITLE: "Le code source officiel est sur GitHub.",
      REPO_BODY: "Consultez le code, les templates, les contrats de preuve et les tests dans le dépôt public. Le README est le point de départ canonique.",
      QUICK_START: "Démarrage rapide", DOCS_TITLE: "Passez de la carte d’architecture aux cas d’usage pratiques.",
      CLOSING_TITLE: "L’exécution d’une commande ne prouve pas l’achèvement ; un résultat revérifiable, oui.",
      THEME_LIGHT: "Passer au thème clair", THEME_DARK: "Passer au thème sombre"
    }
  },
  {
    code: "he", label: "עברית", dir: "rtl", messages: {
      TITLE: "Better Workflows | תהליכי agent ניתנים להוכחה",
      DESCRIPTION: "שכבת בקרה בקוד פתוח ובגישת goal-first לתהליכי agent, עם ראיות עדכניות, שערי ביקורת והתאמה מול הספק.",
      SKIP: "דילוג לתוכן הראשי", MENU: "תפריט", LANGUAGE: "שפה",
      HERO_TITLE: "הובילו את עבודת ה-agent", HERO_ACCENT: "לסיום שניתן להוכיח.",
      HERO_LEAD: "Better Workflows מקבע את היעד, ההיקף והסמכות, וקושר כל החלטה לראיות עדכניות שניתן לאמת שוב ולתוצאה חיצונית שעברה התאמה.",
      DOCS_CTA: "עיון בתיעוד", GITHUB_CTA: "פתיחת GitHub",
      CONTROL_TITLE: "ארבעה גבולות ברורים בין כוונה להשלמה.",
      CONTROL_SUMMARY: "הגדירו את החוזה, אמתו את המקור והראיות, התאימו את ההשפעות החיצוניות והכריזו על השלמה רק כשהמצב הסופי ידוע.",
      REPO_TITLE: "קוד המקור הרשמי נמצא ב-GitHub.",
      REPO_BODY: "עיינו בקוד, בתבניות, בחוזי הראיות ובבדיקות במאגר הציבורי. ה-README הוא נקודת הפתיחה הרשמית.",
      QUICK_START: "התחלה מהירה", DOCS_TITLE: "עברו ממפת הארכיטקטורה למקרי שימוש מעשיים.",
      CLOSING_TITLE: "פקודה שרצה אינה הוכחה להשלמה; תוצאה שניתן לאמת שוב היא כן.",
      THEME_LIGHT: "מעבר לערכת נושא בהירה", THEME_DARK: "מעבר לערכת נושא כהה"
    }
  },
  {
    code: "hi", label: "हिन्दी", messages: {
      TITLE: "Better Workflows | पूर्णता सत्यापित करने योग्य एजेंट कार्यप्रवाह",
      DESCRIPTION: "अद्यतन साक्ष्य, समीक्षा-द्वार और सेवा प्रदाता से मिलान के साथ लक्ष्य-प्रथम मुक्त-स्रोत एजेंट कार्यप्रवाह नियंत्रण-परत।",
      SKIP: "मुख्य सामग्री पर जाएँ", MENU: "मेन्यू", LANGUAGE: "भाषा",
      HERO_TITLE: "एजेंट के काम को", HERO_ACCENT: "सत्यापित किए जा सकने वाले समापन तक पहुँचाएँ।",
      HERO_LEAD: "Better Workflows लक्ष्य, दायरा और अधिकार स्थिर करता है और हर निर्णय को अद्यतन, दोबारा सत्यापित किए जा सकने वाले साक्ष्य तथा मिलान किए गए बाहरी परिणाम से बाँधता है।",
      DOCS_CTA: "दस्तावेज़ देखें", GITHUB_CTA: "GitHub खोलें",
      CONTROL_TITLE: "इरादे से समापन तक चार स्पष्ट सीमाएँ।",
      CONTROL_SUMMARY: "Contract तय करें, source और evidence सत्यापित करें, बाहरी प्रभावों का मिलान करें और अंतिम स्थिति ज्ञात होने पर ही कार्य पूर्ण घोषित करें।",
      REPO_TITLE: "आधिकारिक स्रोत कोड GitHub पर है।",
      REPO_BODY: "सार्वजनिक रिपॉज़िटरी में कोड, टेम्पलेट, evidence contracts और परीक्षण देखें। README आधिकारिक शुरुआती बिंदु है।",
      QUICK_START: "त्वरित शुरुआत", DOCS_TITLE: "आर्किटेक्चर मानचित्र से व्यावहारिक उपयोग-परिदृश्यों तक जाएँ।",
      CLOSING_TITLE: "सिर्फ़ कमांड चलना पूर्णता का प्रमाण नहीं है; दोबारा सत्यापित परिणाम ही प्रमाण है।",
      THEME_LIGHT: "हल्की थीम पर जाएँ", THEME_DARK: "गहरी थीम पर जाएँ"
    }
  },
  {
    code: "hr", label: "Hrvatski", messages: {
      TITLE: "Better Workflows | Dokazivi tijekovi rada agenata",
      DESCRIPTION: "Open-source, goal-first upravljačka ravnina za tijekove rada agenata s ažurnim dokazima, pregledima i usklađivanjem pružatelja.",
      SKIP: "Prijeđi na glavni sadržaj", MENU: "Izbornik", LANGUAGE: "Jezik",
      HERO_TITLE: "Dovedite rad agenata", HERO_ACCENT: "do dokazivog završetka.",
      HERO_LEAD: "Better Workflows zaključava cilj, opseg i ovlasti te svaku odluku veže uz ažurne, ponovno provjerljive dokaze i usklađen vanjski ishod.",
      DOCS_CTA: "Istraži dokumentaciju", GITHUB_CTA: "Otvori GitHub",
      CONTROL_TITLE: "Četiri jasne granice od namjere do završetka.",
      CONTROL_SUMMARY: "Definirajte ugovor, provjerite izvor i dokaze, uskladite vanjske učinke te dovršetak proglasite tek kada je završno stanje poznato.",
      REPO_TITLE: "Službeni izvorni kod nalazi se na GitHubu.",
      REPO_BODY: "Pregledajte kod, predloške, ugovore dokaza i testove u javnom repozitoriju. README je službena početna točka.",
      QUICK_START: "Brzi početak", DOCS_TITLE: "Od karte arhitekture prijeđite na praktične slučajeve uporabe.",
      CLOSING_TITLE: "Izvršena naredba nije dokaz završetka; ponovno provjerljiv ishod jest.",
      THEME_LIGHT: "Prebaci na svijetlu temu", THEME_DARK: "Prebaci na tamnu temu"
    }
  },
  {
    code: "hu", label: "Magyar", messages: {
      TITLE: "Better Workflows | Bizonyítható agent-munkafolyamatok",
      DESCRIPTION: "Nyílt forráskódú, goal-first vezérlősík agent-munkafolyamatokhoz naprakész bizonyítékokkal, ellenőrzési kapukkal és szolgáltatói egyeztetéssel.",
      SKIP: "Ugrás a fő tartalomra", MENU: "Menü", LANGUAGE: "Nyelv",
      HERO_TITLE: "Vigye el az agent munkáját", HERO_ACCENT: "a bizonyítható befejezésig.",
      HERO_LEAD: "A Better Workflows rögzíti a célt, a hatókört és a jogosultságot, majd minden döntést naprakész, újra ellenőrizhető bizonyítékhoz és egyeztetett külső eredményhez köt.",
      DOCS_CTA: "Dokumentáció megnyitása", GITHUB_CTA: "GitHub megnyitása",
      CONTROL_TITLE: "Négy egyértelmű határ a szándéktól a befejezésig.",
      CONTROL_SUMMARY: "Határozza meg a szerződést, ellenőrizze a forrást és a bizonyítékot, egyeztesse a külső hatásokat, és csak ismert végállapotnál jelentsen befejezést.",
      REPO_TITLE: "A hivatalos forráskód a GitHubon található.",
      REPO_BODY: "A nyilvános tárolóban megtekinthető a kód, a sablonok, az evidence contractok és a tesztek. A README a hivatalos kiindulópont.",
      QUICK_START: "Gyors kezdés", DOCS_TITLE: "Az architektúratérképtől a gyakorlati használati esetekig.",
      CLOSING_TITLE: "Egy parancs lefutása nem bizonyítja a befejezést; egy újra ellenőrizhető eredmény igen.",
      THEME_LIGHT: "Váltás világos témára", THEME_DARK: "Váltás sötét témára"
    }
  },
  {
    code: "id", label: "Bahasa Indonesia", messages: {
      TITLE: "Better Workflows | Alur kerja agent yang dapat dibuktikan",
      DESCRIPTION: "Control plane open-source dan goal-first untuk alur kerja agent dengan bukti terkini, gerbang peninjauan, serta rekonsiliasi provider.",
      SKIP: "Lewati ke konten utama", MENU: "Menu", LANGUAGE: "Bahasa",
      HERO_TITLE: "Bawa pekerjaan agent", HERO_ACCENT: "hingga selesai dengan bukti.",
      HERO_LEAD: "Better Workflows mengunci goal, scope, dan authority, lalu mengikat setiap keputusan pada bukti terkini yang dapat diverifikasi ulang dan hasil eksternal yang telah direkonsiliasi.",
      DOCS_CTA: "Jelajahi dokumentasi", GITHUB_CTA: "Buka GitHub",
      CONTROL_TITLE: "Empat batas tegas dari niat hingga penyelesaian.",
      CONTROL_SUMMARY: "Tentukan contract, verifikasi source dan evidence, rekonsiliasi efek eksternal, lalu nyatakan selesai hanya saat terminal state sudah diketahui.",
      REPO_TITLE: "Kode sumber resmi tersedia di GitHub.",
      REPO_BODY: "Tinjau kode, templat, evidence contracts, dan pengujian di repositori publik. README adalah titik awal resmi.",
      QUICK_START: "Mulai cepat", DOCS_TITLE: "Lanjutkan dari peta arsitektur ke kasus penggunaan praktis.",
      CLOSING_TITLE: "Perintah yang berjalan bukan bukti selesai; hasil yang dapat diverifikasi ulang adalah buktinya.",
      THEME_LIGHT: "Beralih ke tema terang", THEME_DARK: "Beralih ke tema gelap"
    }
  },
  {
    code: "it", label: "Italiano", messages: {
      TITLE: "Better Workflows | Workflow degli agenti dimostrabili",
      DESCRIPTION: "Piano di controllo open source e goal-first per i workflow degli agenti con evidenze aggiornate, gate di revisione, source binding e riconciliazione con il provider.",
      SKIP: "Vai al contenuto principale", MENU: "Menu", LANGUAGE: "Lingua",
      HERO_TITLE: "Porta il lavoro degli agenti", HERO_ACCENT: "a una conclusione dimostrabile.",
      HERO_LEAD: "Better Workflows fissa obiettivo, ambito e autorità, quindi lega ogni decisione a evidenze aggiornate e riverificabili e a un risultato esterno riconciliato.",
      DOCS_CTA: "Esplora la documentazione", GITHUB_CTA: "Apri GitHub",
      CONTROL_TITLE: "Quattro confini espliciti dall’intento al completamento.",
      CONTROL_SUMMARY: "Definisci il contratto, verifica fonte ed evidenze, riconcilia gli effetti esterni e dichiara il completamento solo quando lo stato terminale è noto.",
      REPO_TITLE: "Il codice sorgente ufficiale è su GitHub.",
      REPO_BODY: "Consulta codice, template, evidence contract e test nel repository pubblico. Il README è il punto di partenza ufficiale.",
      QUICK_START: "Avvio rapido", DOCS_TITLE: "Passa dalla mappa dell’architettura ai casi d’uso pratici.",
      CLOSING_TITLE: "L’esecuzione di un comando non prova il completamento; un risultato riverificabile sì.",
      THEME_LIGHT: "Passa al tema chiaro", THEME_DARK: "Passa al tema scuro"
    }
  },
  {
    code: "ja", label: "日本語", messages: {
      TITLE: "Better Workflows | 完了を検証できるエージェントワークフロー",
      DESCRIPTION: "現在のソースに紐付き、なお有効な証拠、レビューゲート、ソースへの結び付け、provider 状態の照合を備えた、オープンソースで目標優先のエージェントワークフロー制御プレーンです。",
      SKIP: "メインコンテンツへ移動", MENU: "メニュー", LANGUAGE: "言語",
      HERO_TITLE: "エージェントの仕事を", HERO_ACCENT: "完了を検証できる状態まで導く。",
      HERO_LEAD: "Better Workflows は goal、scope、authority を固定し、すべての判断を現在のソースに紐付き、なお有効で再検証可能な証拠と、照合済みの外部結果に結び付けます。",
      DOCS_CTA: "ドキュメントを見る", GITHUB_CTA: "GitHub を開く",
      CONTROL_TITLE: "意図から完了までを分ける、4 つの明確な境界。",
      CONTROL_SUMMARY: "contract を定義し、source と evidence を検証し、外部で生じた結果を照合したうえで、終端状態が判明したときだけ完了を宣言します。",
      REPO_TITLE: "公式ソースコードは GitHub で公開しています。",
      REPO_BODY: "公開リポジトリでコード、テンプレート、evidence contracts、テストを確認できます。正式な開始地点は README です。",
      QUICK_START: "クイックスタート", DOCS_TITLE: "アーキテクチャマップから実践的なユースケースへ進む。",
      CLOSING_TITLE: "コマンドが動いたことは完了の証明ではありません。再検証できる結果こそが証拠です。",
      THEME_LIGHT: "ライトテーマに切り替える", THEME_DARK: "ダークテーマに切り替える"
    }
  },
  {
    code: "km", label: "ខ្មែរ", messages: {
      TITLE: "Better Workflows | លំហូរការងារ agent ដែលអាចបញ្ជាក់បាន",
      DESCRIPTION: "ផ្ទាំងបញ្ជាកូដបើកចំហដែលផ្តោតលើគោលដៅជាមុន សម្រាប់លំហូរការងារ agent ជាមួយភស្តុតាងដែលនៅតែត្រូវនឹងប្រភព ច្រកពិនិត្យ និងការផ្ទៀងផ្ទាត់ជាមួយអ្នកផ្តល់សេវា។",
      SKIP: "រំលងទៅមាតិកាសំខាន់", MENU: "ម៉ឺនុយ", LANGUAGE: "ភាសា",
      HERO_TITLE: "នាំការងារ agent", HERO_ACCENT: "ទៅកាន់ការបញ្ចប់ដែលអាចបញ្ជាក់បាន។",
      HERO_LEAD: "Better Workflows កំណត់គោលដៅ វិសាលភាព និងសិទ្ធិអំណាច ហើយភ្ជាប់រាល់សេចក្តីសម្រេចទៅនឹងភស្តុតាងដែលនៅតែត្រូវនឹងប្រភព និងអាចផ្ទៀងផ្ទាត់ឡើងវិញ ព្រមទាំងលទ្ធផលខាងក្រៅដែលបានផ្ទៀងផ្ទាត់។",
      DOCS_CTA: "មើលឯកសារ", GITHUB_CTA: "បើក GitHub",
      CONTROL_TITLE: "ព្រំដែនច្បាស់ចំនួនបួនពីគោលបំណងដល់ការបញ្ចប់។",
      CONTROL_SUMMARY: "កំណត់កិច្ចសន្យា ផ្ទៀងផ្ទាត់ប្រភព និងភស្តុតាង ផ្ទៀងផ្ទាត់ផលប៉ះពាល់ខាងក្រៅ ហើយប្រកាសថាបានបញ្ចប់តែពេលស្គាល់ស្ថានភាពចុងក្រោយ។",
      REPO_TITLE: "កូដប្រភពផ្លូវការមាននៅលើ GitHub។",
      REPO_BODY: "ពិនិត្យកូដ គំរូ កិច្ចសន្យាភស្តុតាង និងការធ្វើតេស្តនៅក្នុងឃ្លាំងកូដសាធារណៈ។ README គឺជាចំណុចចាប់ផ្តើមផ្លូវការ។",
      QUICK_START: "ចាប់ផ្តើមរហ័ស", DOCS_TITLE: "បន្តពីផែនទីស្ថាបត្យកម្មទៅករណីប្រើប្រាស់ជាក់ស្តែង។",
      CLOSING_TITLE: "ការដំណើរការពាក្យបញ្ជាមិនមែនជាភស្តុតាងនៃការបញ្ចប់ទេ; លទ្ធផលដែលអាចផ្ទៀងផ្ទាត់ឡើងវិញទើបជាភស្តុតាង។",
      THEME_LIGHT: "ប្ដូរទៅរចនាប័ទ្មភ្លឺ", THEME_DARK: "ប្ដូរទៅរចនាប័ទ្មងងឹត"
    }
  },
  {
    code: "ko", label: "한국어", messages: {
      TITLE: "Better Workflows | 완료를 입증할 수 있는 에이전트 워크플로",
      DESCRIPTION: "현재 소스에 바인딩되어 여전히 유효한 증거, 리뷰 게이트, 소스 바인딩, provider 상태 대조를 갖춘 오픈 소스 목표 우선 에이전트 워크플로 제어 플레인입니다.",
      SKIP: "주요 콘텐츠로 건너뛰기", MENU: "메뉴", LANGUAGE: "언어",
      HERO_TITLE: "에이전트의 작업을", HERO_ACCENT: "완료를 입증할 수 있는 상태까지 이끕니다.",
      HERO_LEAD: "Better Workflows는 goal, scope, authority를 고정하고 모든 판단을 현재 소스에 바인딩되어 여전히 유효하고 재검증 가능한 증거 및 대조가 끝난 외부 결과에 연결합니다.",
      DOCS_CTA: "문서 살펴보기", GITHUB_CTA: "GitHub 열기",
      CONTROL_TITLE: "의도에서 완료까지 나누는 네 가지 명확한 경계.",
      CONTROL_SUMMARY: "contract를 정의하고 source와 evidence를 검증하며 외부 작업 결과를 대조한 뒤, terminal state가 확인된 경우에만 완료를 선언합니다.",
      REPO_TITLE: "공식 소스 코드는 GitHub에 있습니다.",
      REPO_BODY: "공개 저장소에서 코드, 템플릿, evidence contracts, 테스트를 확인하세요. 공식 시작점은 README입니다.",
      QUICK_START: "빠른 시작", DOCS_TITLE: "아키텍처 지도에서 실전 사용 사례로 이어집니다.",
      CLOSING_TITLE: "명령이 실행됐다는 사실은 완료의 증거가 아닙니다. 재검증 가능한 결과가 증거입니다.",
      THEME_LIGHT: "밝은 테마로 전환", THEME_DARK: "어두운 테마로 전환"
    }
  },
  {
    code: "lo", label: "ລາວ", messages: {
      TITLE: "Better Workflows | ຂັ້ນຕອນ agent ທີ່ພິສູດໄດ້",
      DESCRIPTION: "ຊັ້ນຄວບຄຸມແບບໂອເພນຊອຣສທີ່ເນັ້ນເປົ້າໝາຍກ່ອນ ສຳລັບຂັ້ນຕອນການເຮັດວຽກຂອງ agent ພ້ອມຫຼັກຖານທີ່ຍັງກົງກັບແຫຼ່ງທີ່ມາ ດ່ານກວດທົບທວນ ແລະການກວດທຽບກັບ provider.",
      SKIP: "ຂ້າມໄປຫາເນື້ອຫາຫຼັກ", MENU: "ເມນູ", LANGUAGE: "ພາສາ",
      HERO_TITLE: "ນຳວຽກຂອງ agent", HERO_ACCENT: "ໄປສູ່ການສຳເລັດທີ່ພິສູດໄດ້.",
      HERO_LEAD: "Better Workflows ກຳນົດເປົ້າໝາຍ ຂອບເຂດ ແລະສິດອຳນາດໃຫ້ຄົງທີ່ ແລ້ວເຊື່ອມທຸກການຕັດສິນໃຈກັບຫຼັກຖານທີ່ຍັງກົງກັບແຫຼ່ງທີ່ມາແລະກວດຊ້ຳໄດ້ ພ້ອມຜົນລັບພາຍນອກທີ່ກວດທຽບແລ້ວ.",
      DOCS_CTA: "ເບິ່ງເອກະສານ", GITHUB_CTA: "ເປີດ GitHub",
      CONTROL_TITLE: "ສີ່ຂອບເຂດທີ່ຊັດເຈນຈາກຄວາມຕັ້ງໃຈຫາການສຳເລັດ.",
      CONTROL_SUMMARY: "ກຳນົດສັນຍາ ກວດແຫຼ່ງທີ່ມາແລະຫຼັກຖານ ກວດທຽບຜົນກະທົບພາຍນອກ ແລະປະກາດວ່າສຳເລັດເມື່ອຮູ້ສະຖານະສຸດທ້າຍແລ້ວເທົ່ານັ້ນ.",
      REPO_TITLE: "ລະຫັດຕົ້ນສະບັບທາງການຢູ່ເທິງ GitHub.",
      REPO_BODY: "ເບິ່ງລະຫັດ ແມ່ແບບ ສັນຍາຫຼັກຖານ ແລະການທົດສອບໃນຄັງລະຫັດສາທາລະນະ. README ແມ່ນຈຸດເລີ່ມຕົ້ນທາງການ.",
      QUICK_START: "ເລີ່ມຕົ້ນດ່ວນ", DOCS_TITLE: "ໄປຈາກແຜນທີ່ສະຖາປັດຕະຍະກຳຫາກໍລະນີນຳໃຊ້ຈິງ.",
      CLOSING_TITLE: "ການດຳເນີນຄຳສັ່ງບໍ່ແມ່ນຫຼັກຖານວ່າວຽກສຳເລັດ; ຜົນລັບທີ່ກວດຊ້ຳໄດ້ຕ່າງຫາກແມ່ນຫຼັກຖານ.",
      THEME_LIGHT: "ປ່ຽນເປັນໂໝດສະຫວ່າງ", THEME_DARK: "ປ່ຽນເປັນໂໝດມືດ"
    }
  },
  {
    code: "ms", label: "Bahasa Melayu", messages: {
      TITLE: "Better Workflows | Aliran kerja agent yang boleh dibuktikan",
      DESCRIPTION: "Control plane sumber terbuka dan goal-first untuk aliran kerja agent dengan bukti terkini, gerbang semakan dan penyelarasan provider.",
      SKIP: "Langkau ke kandungan utama", MENU: "Menu", LANGUAGE: "Bahasa",
      HERO_TITLE: "Bawa kerja agent", HERO_ACCENT: "hingga selesai dengan bukti.",
      HERO_LEAD: "Better Workflows menetapkan goal, scope dan authority, kemudian mengikat setiap keputusan kepada bukti terkini yang boleh disahkan semula serta hasil luaran yang telah diselaraskan.",
      DOCS_CTA: "Terokai dokumentasi", GITHUB_CTA: "Buka GitHub",
      CONTROL_TITLE: "Empat sempadan jelas daripada niat hingga selesai.",
      CONTROL_SUMMARY: "Tetapkan contract, sahkan source dan evidence, selaraskan kesan luaran, dan isytiharkan completion hanya apabila terminal state diketahui.",
      REPO_TITLE: "Kod sumber rasmi tersedia di GitHub.",
      REPO_BODY: "Semak kod, templat, evidence contracts dan ujian dalam repositori awam. README ialah titik mula rasmi.",
      QUICK_START: "Mula pantas", DOCS_TITLE: "Daripada peta seni bina kepada kes penggunaan praktikal.",
      CLOSING_TITLE: "Arahan yang dilaksanakan bukan bukti kerja selesai; hasil yang boleh disahkan semula ialah buktinya.",
      THEME_LIGHT: "Tukar kepada tema cerah", THEME_DARK: "Tukar kepada tema gelap"
    }
  },
  {
    code: "my", label: "မြန်မာ", messages: {
      TITLE: "Better Workflows | သက်သေပြနိုင်သော agent workflow များ",
      DESCRIPTION: "လက်ရှိရင်းမြစ်နှင့် ကိုက်ညီပြီး သက်တမ်းရှိဆဲ အထောက်အထား၊ ပြန်လည်သုံးသပ်ရေးအဆင့်များနှင့် provider အခြေအနေတိုက်ဆိုင်စစ်ဆေးမှု ပါသော အများသုံးမူရင်းကုဒ်၊ ရည်မှန်းချက်ဦးစားပေး agent လုပ်ငန်းစဉ် ထိန်းချုပ်မှုအလွှာ။",
      SKIP: "အဓိကအကြောင်းအရာသို့ သွားရန်", MENU: "မီနူး", LANGUAGE: "ဘာသာစကား",
      HERO_TITLE: "agent အလုပ်ကို", HERO_ACCENT: "သက်သေပြနိုင်သည့် အဆုံးသတ်အထိ ယူဆောင်ပါ။",
      HERO_LEAD: "Better Workflows သည် ရည်မှန်းချက်၊ လုပ်ငန်းအတိုင်းအတာနှင့် လုပ်ပိုင်ခွင့်ကို သတ်မှတ်ပြီး ဆုံးဖြတ်ချက်တိုင်းကို လက်ရှိရင်းမြစ်နှင့် ကိုက်ညီကာ သက်တမ်းရှိဆဲဖြစ်ပြီး ပြန်လည်စစ်ဆေးနိုင်သော အထောက်အထားနှင့် တိုက်ဆိုင်စစ်ဆေးထားသော ပြင်ပရလဒ်တို့နှင့် ချိတ်ဆက်သည်။",
      DOCS_CTA: "စာရွက်စာတမ်းကို ကြည့်ရန်", GITHUB_CTA: "GitHub ဖွင့်ရန်",
      CONTROL_TITLE: "ရည်ရွယ်ချက်မှ ပြီးစီးမှုအထိ ရှင်းလင်းသော နယ်နိမိတ်လေးခု။",
      CONTROL_SUMMARY: "စာချုပ်ကို သတ်မှတ်ပြီး ရင်းမြစ်နှင့် အထောက်အထားကို စစ်ဆေးပါ။ ပြင်ပသက်ရောက်မှုများကို တိုက်ဆိုင်စစ်ဆေးပြီး နောက်ဆုံးအခြေအနေကို သိရှိမှသာ ပြီးစီးကြောင်း ကြေညာပါ။",
      REPO_TITLE: "တရားဝင် မူရင်းကုဒ်ကို GitHub တွင် ရရှိနိုင်သည်။",
      REPO_BODY: "အများပြည်သူ ကုဒ်သိုလှောင်ရာထဲရှိ ကုဒ်၊ ပုံစံများ၊ အထောက်အထားဆိုင်ရာ စာချုပ်များနှင့် စမ်းသပ်ချက်များကို စစ်ဆေးပါ။ README သည် တရားဝင် စတင်ရာနေရာဖြစ်သည်။",
      QUICK_START: "အမြန်စတင်ရန်", DOCS_TITLE: "စနစ်တည်ဆောက်ပုံမြေပုံမှ လက်တွေ့အသုံးပြုမှုများသို့ ဆက်သွားပါ။",
      CLOSING_TITLE: "အမိန့်တစ်ခုကို လုပ်ဆောင်ခြင်းသည် ပြီးစီးကြောင်း သက်သေမဟုတ်ပါ; ပြန်လည်စစ်ဆေးနိုင်သော ရလဒ်ကသာ သက်သေဖြစ်သည်။",
      THEME_LIGHT: "အလင်းအပြင်အဆင်သို့ ပြောင်းရန်", THEME_DARK: "အမှောင်အပြင်အဆင်သို့ ပြောင်းရန်"
    }
  },
  {
    code: "nb", label: "Norsk bokmål", messages: {
      TITLE: "Better Workflows | Etterprøvbare agent-workflyter",
      DESCRIPTION: "Åpen kildekode og goal-first kontrollplan for agent-workflyter med oppdatert evidens, kontrollporter og avstemming mot leverandøren.",
      SKIP: "Gå til hovedinnhold", MENU: "Meny", LANGUAGE: "Språk",
      HERO_TITLE: "Før agentarbeidet", HERO_ACCENT: "helt fram til en etterprøvbar avslutning.",
      HERO_LEAD: "Better Workflows låser mål, scope og authority og knytter hver beslutning til oppdatert, revaliderbar evidens og et avstemt eksternt resultat.",
      DOCS_CTA: "Utforsk dokumentasjonen", GITHUB_CTA: "Åpne GitHub",
      CONTROL_TITLE: "Fire tydelige grenser fra hensikt til fullføring.",
      CONTROL_SUMMARY: "Definer kontrakten, verifiser kilde og evidens, avstem eksterne effekter, og erklær først fullført når sluttilstanden er kjent.",
      REPO_TITLE: "Den offisielle kildekoden ligger på GitHub.",
      REPO_BODY: "Se kode, templates, evidence contracts og tester i det offentlige repositoriet. README er det kanoniske startpunktet.",
      QUICK_START: "Kom raskt i gang", DOCS_TITLE: "Gå fra arkitekturkartet til praktiske brukstilfeller.",
      CLOSING_TITLE: "At en kommando kjørte, beviser ikke fullføring; et revaliderbart resultat gjør det.",
      THEME_LIGHT: "Bytt til lyst tema", THEME_DARK: "Bytt til mørkt tema"
    }
  },
  {
    code: "nl", label: "Nederlands", messages: {
      TITLE: "Better Workflows | Aantoonbare agentworkflows",
      DESCRIPTION: "Open-source, goal-first control plane voor agentworkflows met actueel bewijs, reviewpoorten, bronbinding en providerafstemming.",
      SKIP: "Naar hoofdinhoud", MENU: "Menu", LANGUAGE: "Taal",
      HERO_TITLE: "Breng agentwerk", HERO_ACCENT: "tot een aantoonbaar einde.",
      HERO_LEAD: "Better Workflows legt doel, scope en bevoegdheid vast en koppelt elke beslissing aan actueel, opnieuw verifieerbaar bewijs en een afgestemde externe uitkomst.",
      DOCS_CTA: "Bekijk de documentatie", GITHUB_CTA: "Open GitHub",
      CONTROL_TITLE: "Vier expliciete grenzen van intentie tot voltooiing.",
      CONTROL_SUMMARY: "Definieer het contract, verifieer bron en bewijs, stem externe effecten af en verklaar pas voltooid wanneer de eindstatus bekend is.",
      REPO_TITLE: "De officiële broncode staat op GitHub.",
      REPO_BODY: "Bekijk code, templates, evidence contracts en tests in de openbare repository. De README is het canonieke startpunt.",
      QUICK_START: "Snel starten", DOCS_TITLE: "Ga van de architectuurkaart naar praktische toepassingen.",
      CLOSING_TITLE: "Een uitgevoerd commando bewijst geen voltooiing; een opnieuw verifieerbare uitkomst wel.",
      THEME_LIGHT: "Naar licht thema", THEME_DARK: "Naar donker thema"
    }
  },
  {
    code: "pl", label: "Polski", messages: {
      TITLE: "Better Workflows | Weryfikowalne przepływy agentów",
      DESCRIPTION: "Warstwa sterowania o otwartym kodzie, działająca według zasady goal-first, dla przepływów agentów z aktualnymi dowodami, bramkami przeglądu, wiązaniem źródła i uzgodnieniem stanu dostawcy.",
      SKIP: "Przejdź do treści głównej", MENU: "Menu", LANGUAGE: "Język",
      HERO_TITLE: "Doprowadź pracę agentów", HERO_ACCENT: "do weryfikowalnego zakończenia.",
      HERO_LEAD: "Better Workflows utrwala cel, zakres i uprawnienia, a każdą decyzję wiąże z aktualnymi, ponownie weryfikowalnymi dowodami oraz uzgodnionym wynikiem zewnętrznym.",
      DOCS_CTA: "Poznaj dokumentację", GITHUB_CTA: "Otwórz GitHub",
      CONTROL_TITLE: "Cztery wyraźne granice od zamiaru do ukończenia.",
      CONTROL_SUMMARY: "Zdefiniuj kontrakt, zweryfikuj źródło i dowody, uzgodnij skutki zewnętrzne i ogłoś ukończenie dopiero po poznaniu stanu końcowego.",
      REPO_TITLE: "Oficjalny kod źródłowy jest na GitHubie.",
      REPO_BODY: "Sprawdź kod, szablony, kontrakty dowodowe i testy w publicznym repozytorium. README jest kanonicznym punktem startowym.",
      QUICK_START: "Szybki start", DOCS_TITLE: "Przejdź od mapy architektury do praktycznych przypadków użycia.",
      CLOSING_TITLE: "Uruchomione polecenie nie dowodzi ukończenia; ponownie weryfikowalny wynik tak.",
      THEME_LIGHT: "Przełącz na jasny motyw", THEME_DARK: "Przełącz na ciemny motyw"
    }
  },
  {
    code: "pt", label: "Português", messages: {
      TITLE: "Better Workflows | Fluxos de agentes comprováveis",
      DESCRIPTION: "Plano de controlo open source e goal-first para fluxos de agentes com evidência atualizada, revisões, ligação à origem e reconciliação do fornecedor.",
      SKIP: "Saltar para o conteúdo principal", MENU: "Menu", LANGUAGE: "Idioma",
      HERO_TITLE: "Leve o trabalho dos agentes", HERO_ACCENT: "até uma conclusão comprovável.",
      HERO_LEAD: "O Better Workflows fixa o objetivo, o âmbito e a autoridade e liga cada decisão a evidência atualizada e revalidável e a um resultado externo reconciliado.",
      DOCS_CTA: "Explorar a documentação", GITHUB_CTA: "Abrir o GitHub",
      CONTROL_TITLE: "Quatro limites explícitos entre intenção e conclusão.",
      CONTROL_SUMMARY: "Defina o contrato, verifique a origem e a evidência, reconcilie os efeitos externos e declare a conclusão apenas quando o estado terminal for conhecido.",
      REPO_TITLE: "O código-fonte oficial está no GitHub.",
      REPO_BODY: "Consulte o código, os templates, os contratos de evidência e os testes no repositório público. O README é o ponto de partida oficial.",
      QUICK_START: "Início rápido", DOCS_TITLE: "Passe do mapa de arquitetura aos casos de utilização práticos.",
      CLOSING_TITLE: "Executar um comando não comprova a conclusão; um resultado revalidável comprova.",
      THEME_LIGHT: "Mudar para o tema claro", THEME_DARK: "Mudar para o tema escuro"
    }
  },
  {
    code: "pt-BR", label: "Português (Brasil)", messages: {
      TITLE: "Better Workflows | Fluxos de agentes comprováveis",
      DESCRIPTION: "Plano de controle open source e goal-first para fluxos de agentes com evidências atuais, revisões, vínculo à origem e reconciliação do provedor.",
      SKIP: "Ir para o conteúdo principal", MENU: "Menu", LANGUAGE: "Idioma",
      HERO_TITLE: "Leve o trabalho dos agentes", HERO_ACCENT: "até uma conclusão comprovável.",
      HERO_LEAD: "O Better Workflows fixa o objetivo, o escopo e a autoridade e vincula cada decisão a evidências atuais e revalidáveis e a um resultado externo reconciliado.",
      DOCS_CTA: "Explorar a documentação", GITHUB_CTA: "Abrir o GitHub",
      CONTROL_TITLE: "Quatro limites claros entre intenção e conclusão.",
      CONTROL_SUMMARY: "Defina o contrato, verifique a origem e as evidências, reconcilie os efeitos externos e só marque como concluído quando o estado final for conhecido.",
      REPO_TITLE: "O código-fonte oficial está no GitHub.",
      REPO_BODY: "Confira o código, os templates, os contratos de evidência e os testes no repositório público. O README é o ponto de partida oficial.",
      QUICK_START: "Início rápido", DOCS_TITLE: "Passe do mapa de arquitetura para casos de uso práticos.",
      CLOSING_TITLE: "Um comando executado não comprova a conclusão; um resultado que pode ser revalidado, sim.",
      THEME_LIGHT: "Mudar para tema claro", THEME_DARK: "Mudar para tema escuro"
    }
  },
  {
    code: "ro", label: "Română", messages: {
      TITLE: "Better Workflows | Fluxuri de agenți demonstrabile",
      DESCRIPTION: "Plan de control open-source și goal-first pentru fluxuri de agenți, cu dovezi actualizate, porți de review și reconcilierea cu furnizorul.",
      SKIP: "Salt la conținutul principal", MENU: "Meniu", LANGUAGE: "Limbă",
      HERO_TITLE: "Duceți munca agenților", HERO_ACCENT: "până la un final demonstrabil.",
      HERO_LEAD: "Better Workflows fixează obiectivul, domeniul și autoritatea și leagă fiecare decizie de dovezi actualizate, revalidabile și de un rezultat extern reconciliat.",
      DOCS_CTA: "Explorați documentația", GITHUB_CTA: "Deschideți GitHub",
      CONTROL_TITLE: "Patru limite explicite de la intenție la finalizare.",
      CONTROL_SUMMARY: "Definiți contractul, verificați sursa și dovezile, reconciliați efectele externe și declarați finalizarea doar când starea terminală este cunoscută.",
      REPO_TITLE: "Codul sursă oficial este pe GitHub.",
      REPO_BODY: "Consultați codul, șabloanele, contractele de dovezi și testele din repozitoriul public. README este punctul de pornire oficial.",
      QUICK_START: "Pornire rapidă", DOCS_TITLE: "Treceți de la harta arhitecturii la cazuri practice de utilizare.",
      CLOSING_TITLE: "Rularea unei comenzi nu dovedește finalizarea; un rezultat revalidabil o dovedește.",
      THEME_LIGHT: "Comutați la tema deschisă", THEME_DARK: "Comutați la tema închisă"
    }
  },
  {
    code: "ru", label: "Русский", messages: {
      TITLE: "Better Workflows | Проверяемые рабочие процессы агентов",
      DESCRIPTION: "Плоскость управления с открытым исходным кодом и подходом goal-first для процессов агентов с актуальными доказательствами, ревью и сверкой состояния провайдера.",
      SKIP: "Перейти к основному содержанию", MENU: "Меню", LANGUAGE: "Язык",
      HERO_TITLE: "Доведите работу агентов", HERO_ACCENT: "до доказуемого завершения.",
      HERO_LEAD: "Better Workflows фиксирует цель, область и полномочия и связывает каждое решение с актуальными, повторно проверяемыми доказательствами и сверенным внешним результатом.",
      DOCS_CTA: "Открыть документацию", GITHUB_CTA: "Открыть GitHub",
      CONTROL_TITLE: "Четыре явные границы от намерения до завершения.",
      CONTROL_SUMMARY: "Определите контракт, проверьте источник и доказательства, сверьте внешние эффекты и объявляйте завершение только при известном конечном состоянии.",
      REPO_TITLE: "Официальный исходный код размещён на GitHub.",
      REPO_BODY: "Изучите код, шаблоны, контракты доказательств и тесты в публичном репозитории. README — официальная отправная точка.",
      QUICK_START: "Быстрый старт", DOCS_TITLE: "От карты архитектуры — к практическим сценариям.",
      CLOSING_TITLE: "Запуск команды не доказывает завершение; повторно проверяемый результат доказывает.",
      THEME_LIGHT: "Переключить на светлую тему", THEME_DARK: "Переключить на тёмную тему"
    }
  },
  {
    code: "sk", label: "Slovenčina", messages: {
      TITLE: "Better Workflows | Preukázateľné pracovné postupy agentov",
      DESCRIPTION: "Open-source, goal-first riadiaca vrstva pre pracovné postupy agentov s aktuálnymi dôkazmi, kontrolami a zosúladením poskytovateľa.",
      SKIP: "Prejsť na hlavný obsah", MENU: "Ponuka", LANGUAGE: "Jazyk",
      HERO_TITLE: "Doveďte prácu agentov", HERO_ACCENT: "k preukázateľnému dokončeniu.",
      HERO_LEAD: "Better Workflows ukotví cieľ, rozsah a oprávnenia a každé rozhodnutie previaže s aktuálnymi, opätovne overiteľnými dôkazmi a zosúladeným externým výsledkom.",
      DOCS_CTA: "Preskúmať dokumentáciu", GITHUB_CTA: "Otvoriť GitHub",
      CONTROL_TITLE: "Štyri jasné hranice od zámeru po dokončenie.",
      CONTROL_SUMMARY: "Definujte zmluvu, overte zdroj a dôkazy, zosúlaďte externé účinky a dokončenie vyhláste až vtedy, keď je koncový stav známy.",
      REPO_TITLE: "Oficiálny zdrojový kód je na GitHube.",
      REPO_BODY: "Vo verejnom repozitári nájdete kód, šablóny, zmluvy dôkazov a testy. README je oficiálny východiskový bod.",
      QUICK_START: "Rýchly štart", DOCS_TITLE: "Prejdite od mapy architektúry k praktickým prípadom použitia.",
      CLOSING_TITLE: "Spustenie príkazu nedokazuje dokončenie; opätovne overiteľný výsledok áno.",
      THEME_LIGHT: "Prepnúť na svetlý motív", THEME_DARK: "Prepnúť na tmavý motív"
    }
  },
  {
    code: "sv", label: "Svenska", messages: {
      TITLE: "Better Workflows | Bevisbara agentarbetsflöden",
      DESCRIPTION: "Kontrollplan med öppen källkod och goal-first för agentarbetsflöden med aktuella bevis, granskningsgrindar och leverantörsavstämning.",
      SKIP: "Hoppa till huvudinnehållet", MENU: "Meny", LANGUAGE: "Språk",
      HERO_TITLE: "För agentarbetet", HERO_ACCENT: "hela vägen till ett bevisbart slut.",
      HERO_LEAD: "Better Workflows låser mål, scope och authority och knyter varje beslut till aktuella, återvaliderbara bevis och ett avstämt externt resultat.",
      DOCS_CTA: "Utforska dokumentationen", GITHUB_CTA: "Öppna GitHub",
      CONTROL_TITLE: "Fyra tydliga gränser från avsikt till slutförande.",
      CONTROL_SUMMARY: "Definiera kontraktet, verifiera källa och bevis, stäm av externa effekter och markera arbetet som slutfört först när sluttillståndet är känt.",
      REPO_TITLE: "Den officiella källkoden finns på GitHub.",
      REPO_BODY: "Granska kod, templates, evidence contracts och tester i det offentliga repositoriet. README är den officiella startpunkten.",
      QUICK_START: "Snabbstart", DOCS_TITLE: "Gå från arkitekturkartan till praktiska användningsfall.",
      CLOSING_TITLE: "Att ett kommando kördes bevisar inte slutförande; ett återvaliderbart resultat gör det.",
      THEME_LIGHT: "Byt till ljust tema", THEME_DARK: "Byt till mörkt tema"
    }
  },
  {
    code: "th", label: "ไทย", messages: {
      TITLE: "Better Workflows | เวิร์กโฟลว์ agent ที่พิสูจน์ได้",
      DESCRIPTION: "control plane แบบ open-source และ goal-first สำหรับเวิร์กโฟลว์ agent พร้อมหลักฐานที่เป็นปัจจุบัน จุดตรวจ review และ provider reconciliation",
      SKIP: "ข้ามไปยังเนื้อหาหลัก", MENU: "เมนู", LANGUAGE: "ภาษา",
      HERO_TITLE: "พางานของ agent", HERO_ACCENT: "ไปถึงจุดจบที่พิสูจน์ได้",
      HERO_LEAD: "Better Workflows ตรึง goal, scope และ authority แล้วผูกทุกการตัดสินใจกับหลักฐานที่เป็นปัจจุบันและตรวจซ้ำได้ รวมถึงผลลัพธ์ภายนอกที่ reconcile แล้ว",
      DOCS_CTA: "ดูเอกสาร", GITHUB_CTA: "เปิด GitHub",
      CONTROL_TITLE: "สี่ขอบเขตที่ชัดเจนจากเจตนาถึงการเสร็จสมบูรณ์",
      CONTROL_SUMMARY: "กำหนด contract ตรวจสอบ source และ evidence กระทบยอดผลกระทบภายนอก และประกาศว่าเสร็จสมบูรณ์เมื่อทราบ terminal state แล้วเท่านั้น",
      REPO_TITLE: "ซอร์สโค้ดอย่างเป็นทางการอยู่บน GitHub",
      REPO_BODY: "ตรวจสอบโค้ด เทมเพลต evidence contracts และการทดสอบได้ในรีพอซิทอรีสาธารณะ โดย README คือจุดเริ่มต้นอย่างเป็นทางการ",
      QUICK_START: "เริ่มต้นอย่างรวดเร็ว", DOCS_TITLE: "ไปต่อจากแผนผังสถาปัตยกรรมสู่กรณีใช้งานจริง",
      CLOSING_TITLE: "การรันคำสั่งไม่ใช่หลักฐานว่างานเสร็จ ผลลัพธ์ที่ตรวจสอบซ้ำได้ต่างหากคือหลักฐาน",
      THEME_LIGHT: "เปลี่ยนเป็นธีมสว่าง", THEME_DARK: "เปลี่ยนเป็นธีมมืด"
    }
  },
  {
    code: "tr", label: "Türkçe", messages: {
      TITLE: "Better Workflows | Kanıtlanabilir agent iş akışları",
      DESCRIPTION: "Güncel kanıt, inceleme kapıları, kaynak bağlama ve sağlayıcı uzlaştırması içeren açık kaynaklı, goal-first agent iş akışı kontrol düzlemi.",
      SKIP: "Ana içeriğe geç", MENU: "Menü", LANGUAGE: "Dil",
      HERO_TITLE: "Agent işini", HERO_ACCENT: "kanıtlanabilir bir sona taşıyın.",
      HERO_LEAD: "Better Workflows hedefi, kapsamı ve yetkiyi sabitler; her kararı güncel ve yeniden doğrulanabilir kanıta ve uzlaştırılmış dış sonuca bağlar.",
      DOCS_CTA: "Belgeleri inceleyin", GITHUB_CTA: "GitHub’ı açın",
      CONTROL_TITLE: "Niyetten tamamlanmaya dört açık sınır.",
      CONTROL_SUMMARY: "Sözleşmeyi tanımlayın, kaynağı ve kanıtı doğrulayın, dış etkileri uzlaştırın ve yalnızca son durum bilindiğinde tamamlandı deyin.",
      REPO_TITLE: "Resmî kaynak kod GitHub’da.",
      REPO_BODY: "Herkese açık repository içinde kodu, şablonları, evidence contract’ları ve testleri inceleyin. README resmî başlangıç noktasıdır.",
      QUICK_START: "Hızlı başlangıç", DOCS_TITLE: "Mimari haritadan pratik kullanım senaryolarına geçin.",
      CLOSING_TITLE: "Bir komutun çalışması tamamlanmayı kanıtlamaz; yeniden doğrulanabilir sonuç kanıtlar.",
      THEME_LIGHT: "Açık temaya geç", THEME_DARK: "Koyu temaya geç"
    }
  },
  {
    code: "uk", label: "Українська", messages: {
      TITLE: "Better Workflows | Доказові робочі процеси агентів",
      DESCRIPTION: "Площина керування з відкритим кодом і підходом goal-first для процесів агентів з актуальними доказами, шлюзами перевірки та узгодженням провайдера.",
      SKIP: "Перейти до основного вмісту", MENU: "Меню", LANGUAGE: "Мова",
      HERO_TITLE: "Доведіть роботу агентів", HERO_ACCENT: "до доказового завершення.",
      HERO_LEAD: "Better Workflows фіксує ціль, область і повноваження та пов’язує кожне рішення з актуальними, повторно перевірюваними доказами й узгодженим зовнішнім результатом.",
      DOCS_CTA: "Переглянути документацію", GITHUB_CTA: "Відкрити GitHub",
      CONTROL_TITLE: "Чотири чіткі межі від наміру до завершення.",
      CONTROL_SUMMARY: "Визначте контракт, перевірте джерело й докази, узгодьте зовнішні ефекти та оголошуйте завершення лише коли кінцевий стан відомий.",
      REPO_TITLE: "Офіційний вихідний код розміщено на GitHub.",
      REPO_BODY: "Перегляньте код, шаблони, контракти доказів і тести в публічному репозиторії. README — офіційна початкова точка.",
      QUICK_START: "Швидкий старт", DOCS_TITLE: "Від мапи архітектури — до практичних сценаріїв.",
      CLOSING_TITLE: "Виконана команда не доводить завершення; повторно перевірюваний результат доводить.",
      THEME_LIGHT: "Увімкнути світлу тему", THEME_DARK: "Увімкнути темну тему"
    }
  },
  {
    code: "vi", label: "Tiếng Việt", messages: {
      TITLE: "Better Workflows | Quy trình agent có thể chứng minh",
      DESCRIPTION: "Mặt phẳng điều khiển mã nguồn mở, goal-first cho quy trình agent với bằng chứng cập nhật, cổng review và đối soát provider.",
      SKIP: "Chuyển đến nội dung chính", MENU: "Trình đơn", LANGUAGE: "Ngôn ngữ",
      HERO_TITLE: "Đưa công việc của agent", HERO_ACCENT: "đến kết quả có thể chứng minh.",
      HERO_LEAD: "Better Workflows cố định goal, scope và authority, rồi gắn mỗi quyết định với bằng chứng cập nhật có thể kiểm tra lại và kết quả bên ngoài đã được đối soát.",
      DOCS_CTA: "Khám phá tài liệu", GITHUB_CTA: "Mở GitHub",
      CONTROL_TITLE: "Bốn ranh giới rõ ràng từ ý định đến hoàn tất.",
      CONTROL_SUMMARY: "Xác định contract, kiểm tra source và evidence, đối soát tác động bên ngoài, rồi chỉ tuyên bố hoàn tất khi terminal state đã rõ.",
      REPO_TITLE: "Mã nguồn chính thức nằm trên GitHub.",
      REPO_BODY: "Xem mã nguồn, mẫu, evidence contracts và các bài kiểm thử trong kho mã công khai. README là điểm bắt đầu chính thức.",
      QUICK_START: "Bắt đầu nhanh", DOCS_TITLE: "Đi từ bản đồ kiến trúc đến các tình huống sử dụng thực tế.",
      CLOSING_TITLE: "Việc một lệnh đã chạy không chứng minh công việc hoàn tất; kết quả có thể kiểm tra lại mới là bằng chứng.",
      THEME_LIGHT: "Chuyển sang giao diện sáng", THEME_DARK: "Chuyển sang giao diện tối"
    }
  },
  {
    code: "zh-Hans", label: "简体中文", messages: {
      TITLE: "Better Workflows｜让 agent 工作完成且可验证",
      DESCRIPTION: "开源、goal-first 的 agent 工作流控制面，以当前仍有效的证据、审查关卡、来源绑定与 provider 状态核对，确保结果可重新验证。",
      SKIP: "跳到主要内容", MENU: "菜单", LANGUAGE: "语言",
      HERO_TITLE: "让 agent 工作", HERO_ACCENT: "完成，并留下可验证的结果。",
      HERO_LEAD: "Better Workflows 固定 goal、scope 与 authority，把每个判断绑定到当前仍有效且可重新验证的证据，以及已核对的外部结果。",
      DOCS_CTA: "查看官方文档", GITHUB_CTA: "打开 GitHub",
      CONTROL_TITLE: "从意图到完成，明确划分四道边界。",
      CONTROL_SUMMARY: "先定义 contract，再验证 source 与 evidence、核对外部操作结果；只有 terminal state 已知时，才宣布完成。",
      REPO_TITLE: "官方源代码已公开在 GitHub。",
      REPO_BODY: "可在公开代码仓库查看代码、模板、evidence contracts 与测试；README 是官方入门入口。",
      QUICK_START: "快速开始", DOCS_TITLE: "从架构地图继续深入实际使用场景。",
      CLOSING_TITLE: "执行命令并不代表工作已经完成；可重新验证的结果才是证明。",
      THEME_LIGHT: "切换浅色模式", THEME_DARK: "切换深色模式"
    }
  },
  {
    code: "zh-Hant", label: "繁體中文", messages: {
      TITLE: "Better Workflows｜讓 agent 工作完成且可驗證",
      DESCRIPTION: "開源、goal-first 的 agent 工作流程控制面，以目前仍有效的證據、審查關卡、來源綁定與 provider 狀態核對，確保結果可重新驗證。",
      SKIP: "跳到主要內容", MENU: "選單", LANGUAGE: "語言",
      HERO_TITLE: "讓 agent 工作", HERO_ACCENT: "完成，並留下可驗證的結果。",
      HERO_LEAD: "Better Workflows 固定 goal、scope 與 authority，把每個判斷綁定到目前仍有效且可重新驗證的證據，以及已核對的外部結果。",
      DOCS_CTA: "查看官方文件", GITHUB_CTA: "開啟 GitHub",
      CONTROL_TITLE: "從意圖到完成，明確劃分四道邊界。",
      CONTROL_SUMMARY: "先定義 contract，再驗證 source 與 evidence、核對外部操作結果；只有 terminal state 已知時，才宣告完成。",
      REPO_TITLE: "官方原始碼已公開在 GitHub。",
      REPO_BODY: "可在公開程式碼儲存庫查看原始碼、範本、evidence contracts 與測試；README 是官方入門入口。",
      QUICK_START: "快速開始", DOCS_TITLE: "從架構地圖繼續深入實際使用情境。",
      CLOSING_TITLE: "命令成功執行不代表工作已經完成；可重新驗證的結果才是證明。",
      THEME_LIGHT: "切換淺色模式", THEME_DARK: "切換深色模式"
    }
  },
  {
    code: "zh-Hant-HK", label: "繁體中文（香港）", messages: {
      TITLE: "Better Workflows｜讓 agent 工作完成並可驗證",
      DESCRIPTION: "開源、goal-first 的 agent 工作流程控制面，以目前仍然有效的證據、審查關卡、來源綁定及 provider 狀態核對，確保結果可以再次驗證。",
      SKIP: "跳到主要內容", MENU: "選單", LANGUAGE: "語言",
      HERO_TITLE: "讓 agent 工作", HERO_ACCENT: "完成，並留下可以再次驗證的結果。",
      HERO_LEAD: "Better Workflows 會固定 goal、scope 及 authority，將每個判斷綁定到目前仍然有效、可以再次驗證的證據，以及已核對的外部結果。",
      DOCS_CTA: "查看官方文件", GITHUB_CTA: "開啟 GitHub",
      CONTROL_TITLE: "由意圖到完成，清楚劃分四道邊界。",
      CONTROL_SUMMARY: "先定義 contract，再驗證 source 及 evidence、核對外部操作結果；只有在 terminal state 已知時，才宣告完成。",
      REPO_TITLE: "官方源碼已在 GitHub 公開。",
      REPO_BODY: "可在公開程式碼儲存庫查看源碼、範本、evidence contracts 及測試；README 是官方入門起點。",
      QUICK_START: "快速開始", DOCS_TITLE: "由架構地圖繼續深入實際使用情境。",
      CLOSING_TITLE: "指令成功執行不代表工作已經完成；可以再次驗證的結果才是證明。",
      THEME_LIGHT: "切換淺色模式", THEME_DARK: "切換深色模式"
    }
  },
  {
    code: "zh-Hant-TW", label: "繁體中文（台灣）", messages: {
      TITLE: "Better Workflows｜讓 agent 工作完成且可驗證",
      DESCRIPTION: "開源、goal-first 的 agent 工作流程控制面，以目前仍有效的證據、審查關卡、來源綁定與 provider 狀態核對，確保結果可重新驗證。",
      SKIP: "跳到主要內容", MENU: "選單", LANGUAGE: "語言",
      HERO_TITLE: "讓 agent 工作", HERO_ACCENT: "完成，並留下可驗證的結果。",
      HERO_LEAD: "Better Workflows 固定 goal、scope 與 authority，把每個判斷綁定到目前仍有效且可重新驗證的證據，以及已核對的外部結果。",
      DOCS_CTA: "查看官方文件", GITHUB_CTA: "開啟 GitHub",
      CONTROL_TITLE: "從意圖到完成，明確劃分四道邊界。",
      CONTROL_SUMMARY: "先定義 contract，再驗證 source 與 evidence、核對外部操作結果；只有 terminal state 已知時，才宣告完成。",
      REPO_TITLE: "官方原始碼已公開在 GitHub。",
      REPO_BODY: "可在公開程式碼儲存庫查看程式碼、範本、evidence contracts 與測試；README 是官方入門入口。",
      QUICK_START: "快速開始", DOCS_TITLE: "從架構地圖繼續深入實際使用情境。",
      CLOSING_TITLE: "命令成功執行不代表工作已經完成；可重新驗證的結果才是證明。",
      THEME_LIGHT: "切換淺色模式", THEME_DARK: "切換深色模式"
    }
  }
];

if (locales.length !== CONNECTORS_LOCALES.length || new Set(locales.map(({ code }) => code)).size !== CONNECTORS_LOCALES.length || CONNECTORS_LOCALES.some((code) => !locales.some((locale) => locale.code === code))) {
  throw new Error("Locale catalog must match the independent Connectors iOS inventory");
}
const localeOrder = new Map(CONNECTORS_LOCALES.map((code, index) => [code, index]));
locales.sort((left, right) => localeOrder.get(left.code) - localeOrder.get(right.code));

const sponsorCopy = {
  ar: ["ادعم عبر Ko-fi", "ساعد Better Workflows على الاستمرار.", "يساعد الدعم لمرة واحدة في صيانة الشيفرة المفتوحة والوثائق وإعداد 41 إصدارًا موطّنًا واستضافة الموقع. ولا يمنح عضوية أو أولوية في خارطة الطريق أو الدعم."],
  ca: ["Dona suport a Ko-fi", "Ajuda a mantenir Better Workflows.", "Una aportació puntual ajuda a mantenir el codi obert, la documentació, les 41 versions localitzades i l’allotjament web. No compra cap membresia ni prioritat de full de ruta o suport."],
  cs: ["Podpořit přes Ko-fi", "Pomozte udržovat Better Workflows.", "Jednorázová podpora pomáhá udržovat open-source kód, dokumentaci, 41 lokalizovaných verzí a provoz webu. Nezakládá členství ani prioritu v plánu či podpoře."],
  da: ["Støt via Ko-fi", "Hjælp med at holde Better Workflows i gang.", "Et engangsbidrag støtter vedligeholdelse af open source-kode, dokumentation, 41 lokaliserede versioner og webhosting. Det giver ikke medlemskab eller prioritet i roadmap eller support."],
  de: ["Über Ko-fi unterstützen", "Hilf mit, Better Workflows nachhaltig zu pflegen.", "Eine einmalige Unterstützung hilft bei Open-Source-Code, Dokumentation, 41 lokalisierten Versionen und Webhosting. Sie begründet keine Mitgliedschaft oder Priorität bei Roadmap und Support."],
  el: ["Υποστήριξη μέσω Ko-fi", "Βοηθήστε να διατηρείται το Better Workflows.", "Μια εφάπαξ συνεισφορά στηρίζει τον ανοιχτό κώδικα, την τεκμηρίωση, τις 41 τοπικοποιημένες εκδόσεις και τη φιλοξενία. Δεν παρέχει ιδιότητα μέλους ούτε προτεραιότητα στον οδικό χάρτη ή στην υποστήριξη."],
  en: ["Support on Ko-fi", "Help maintain Better Workflows.", "A one-time contribution supports open-source maintenance, documentation, 41 localized editions, and website hosting. It does not buy membership, roadmap priority, or support priority."],
  es: ["Apoyar en Ko-fi", "Ayuda a mantener Better Workflows.", "Una aportación única apoya el mantenimiento del código abierto, la documentación, las 41 versiones localizadas y el alojamiento web. No da derecho a ser miembro ni prioridad en la hoja de ruta o en la asistencia."],
  "es-MX": ["Apoyar en Ko-fi", "Ayuda a mantener Better Workflows.", "Una aportación por única ocasión ayuda a mantener el código abierto, la documentación, las 41 versiones localizadas y el sitio web. No otorga membresía ni prioridad en la hoja de ruta ni en el soporte."],
  fi: ["Tue Ko-fi-palvelussa", "Auta Better Workflowsin ylläpidossa.", "Kertaluonteinen tuki auttaa avoimen lähdekoodin, dokumentaation, 41 lokalisoidun version ja verkkosivun ylläpidossa. Se ei anna jäsenyyttä eikä etusijaa kehityksessä tai tuessa."],
  fil: ["Sumuporta sa Ko-fi", "Tulungang mapanatili ang Better Workflows.", "Ang minsanang suporta ay tumutulong sa pagpapanatili ng bukas na source code, dokumentasyon, 41 bersyong naisalokal, at pagho-host ng website. Hindi ito nagbibigay ng pagiging miyembro o priyoridad sa plano ng pagpapaunlad o suporta."],
  fr: ["Soutenir sur Ko-fi", "Aidez à maintenir Better Workflows.", "Un soutien ponctuel finance la maintenance open source, la documentation, les 41 versions localisées et l’hébergement du site. Il ne donne droit ni à une adhésion, ni à une priorité sur la feuille de route ou pour l’assistance."],
  he: ["תמיכה דרך Ko-fi", "עזרו לתחזק את Better Workflows לאורך זמן.", "תמיכה חד-פעמית מסייעת בתחזוקת הקוד הפתוח, התיעוד, 41 גרסאות מותאמות לאזור ואחסון האתר. היא אינה מקנה חברות או קדימות במפת הדרכים או בתמיכה."],
  hi: ["Ko-fi पर सहयोग करें", "Better Workflows के रखरखाव में मदद करें।", "एक बार का सहयोग मुक्त-स्रोत रखरखाव, दस्तावेज़, 41 स्थानीयकृत संस्करणों और वेबसाइट संचालन में मदद करता है। इससे सदस्यता, विकास योजना या सहायता में प्राथमिकता नहीं मिलती।"],
  hr: ["Podrži putem Ko-fi", "Pomozite održavati Better Workflows.", "Jednokratna podrška pomaže održavanju otvorenog koda, dokumentacije, 41 lokaliziranog izdanja i web-hostinga. Ne donosi članstvo ni prioritet za plan razvoja ili podršku."],
  hu: ["Támogatás Ko-fi-n", "Segíts a Better Workflows fenntartásában.", "Az egyszeri támogatás a nyílt forráskód, a dokumentáció, 41 lokalizált változat és a webtárhely fenntartását segíti. Nem jár tagsággal, ütemtervi vagy támogatási elsőbbséggel."],
  id: ["Dukung di Ko-fi", "Bantu menjaga Better Workflows tetap terawat.", "Dukungan satu kali membantu pemeliharaan open source, dokumentasi, 41 versi terlokalisasi, dan hosting situs. Dukungan ini tidak memberikan keanggotaan atau prioritas dalam peta jalan maupun bantuan."],
  it: ["Sostieni su Ko-fi", "Aiuta a mantenere Better Workflows.", "Un contributo una tantum sostiene manutenzione open source, documentazione, 41 versioni localizzate e hosting del sito. Non dà diritto ad alcuna iscrizione né a priorità sulla roadmap o nell’assistenza."],
  ja: ["Ko-fi で支援", "Better Workflows の継続的なメンテナンスを支えてください。", "一度限りの支援は、オープンソースの保守、ドキュメント、41 ロケール向けのローカライズ版、Web サイト運営に役立ちます。会員資格、ロードマップ上の優先権、サポート上の優先権は付与されません。"],
  km: ["គាំទ្រតាម Ko-fi", "ជួយរក្សា Better Workflows ឱ្យបន្តថែទាំ។", "ការគាំទ្រម្តងជួយថែទាំកូដប្រភពបើកចំហ ឯកសារ កំណែដែលបានធ្វើមូលដ្ឋានីយកម្មចំនួន 41 និងការបង្ហោះគេហទំព័រ។ វាមិនផ្តល់សមាជិកភាព ឬអាទិភាពក្នុងផែនការអភិវឌ្ឍន៍ និងការគាំទ្រទេ។"],
  ko: ["Ko-fi에서 후원", "Better Workflows의 꾸준한 유지 관리를 도와주세요.", "일회성 후원은 오픈 소스 유지 관리, 문서, 41개 로캘용 현지화 버전과 웹사이트 운영에 사용됩니다. 멤버십이나 로드맵·지원 우선권을 제공하지 않습니다."],
  lo: ["ສະໜັບສະໜູນຜ່ານ Ko-fi", "ຊ່ວຍໃຫ້ Better Workflows ໄດ້ຮັບການດູແລຕໍ່ໄປ.", "ການສະໜັບສະໜູນຄັ້ງດຽວຊ່ວຍບຳລຸງຊອບແວເປີດແຫຼ່ງ ເອກະສານ ສະບັບທີ່ປັບໃຫ້ເໝາະກັບທ້ອງຖິ່ນ 41 ສະບັບ ແລະການໂຮສເວັບໄຊ. ບໍ່ໄດ້ຮັບສະມາຊິກ ຫຼືສິດກ່ອນໃນແຜນພັດທະນາແລະການຊ່ວຍເຫຼືອ."],
  ms: ["Sokong di Ko-fi", "Bantu kekalkan Better Workflows.", "Sumbangan sekali sahaja membantu penyelenggaraan sumber terbuka, dokumentasi, 41 versi disetempatkan dan pengehosan laman. Sumbangan ini tidak memberikan keahlian atau keutamaan dalam pelan pembangunan mahupun sokongan."],
  my: ["Ko-fi မှ ပံ့ပိုးပါ", "Better Workflows ကို ဆက်လက်ထိန်းသိမ်းနိုင်ရန် ကူညီပါ။", "တစ်ကြိမ်တည်း ပံ့ပိုးမှုသည် အများသုံးမူရင်းကုဒ် ထိန်းသိမ်းမှု၊ စာရွက်စာတမ်း၊ ဒေသအလိုက် ပြင်ဆင်ထားသော မူကွဲ ၄၁ ခုနှင့် ဝဘ်ဆိုက် လက်ခံတင်ဆက်မှုကို ကူညီသည်။ အဖွဲ့ဝင်ခွင့် သို့မဟုတ် ဖွံ့ဖြိုးရေးအစီအစဉ်နှင့် အကူအညီတွင် ဦးစားပေးမှု မရပါ။"],
  nb: ["Støtt på Ko-fi", "Hjelp oss å vedlikeholde Better Workflows.", "Et engangsbidrag støtter vedlikehold av åpen kildekode, dokumentasjon, 41 lokaliserte versjoner og webhosting. Det gir ikke medlemskap eller prioritet i veikart eller brukerstøtte."],
  nl: ["Steun via Ko-fi", "Help Better Workflows onderhouden.", "Een eenmalige bijdrage ondersteunt open-sourceonderhoud, documentatie, 41 gelokaliseerde versies en websitehosting. Deze bijdrage geeft geen recht op lidmaatschap of voorrang op de roadmap of bij ondersteuning."],
  pl: ["Wesprzyj przez Ko-fi", "Pomóż utrzymywać Better Workflows.", "Jednorazowe wsparcie pomaga utrzymywać otwarty kod, dokumentację, 41 zlokalizowanych wersji i hosting strony. Nie zapewnia członkostwa ani pierwszeństwa w planie rozwoju czy w pomocy technicznej."],
  pt: ["Apoiar no Ko-fi", "Ajude a manter o Better Workflows.", "Um apoio pontual contribui para o código aberto, documentação, 41 versões localizadas e alojamento do site. Não dá direito a adesão nem a prioridade no plano de desenvolvimento ou no apoio."],
  "pt-BR": ["Apoiar no Ko-fi", "Ajude a manter o Better Workflows.", "Uma contribuição única apoia a manutenção do código aberto, a documentação, 41 versões localizadas e a hospedagem do site. Não dá direito a associação nem prioridade no plano de desenvolvimento ou no suporte."],
  ro: ["Susține pe Ko-fi", "Ajută la întreținerea Better Workflows.", "O contribuție unică susține codul open source, documentația, 41 de versiuni localizate și găzduirea site-ului. Nu oferă calitatea de membru și nici prioritate în planul de dezvoltare sau la asistență."],
  ru: ["Поддержать на Ko-fi", "Помогите поддерживать Better Workflows.", "Разовая поддержка помогает развивать открытый код, документацию, 41 локализованную версию и хостинг сайта. Она не дает статуса участника или приоритета в плане развития и технической поддержке."],
  sk: ["Podporiť cez Ko-fi", "Pomôžte udržiavať Better Workflows.", "Jednorazová podpora pomáha udržiavať otvorený kód, dokumentáciu, 41 lokalizovaných verzií a webhosting. Neprináša členstvo ani prioritu v pláne či podpore."],
  sv: ["Stöd via Ko-fi", "Hjälp till att underhålla Better Workflows.", "Ett engångsbidrag stöder underhåll av öppen källkod, dokumentation, 41 lokaliserade versioner och webbhosting. Det ger inget medlemskap eller prioritet i roadmap eller support."],
  th: ["สนับสนุนผ่าน Ko-fi", "ช่วยให้ Better Workflows ได้รับการดูแลต่อเนื่อง", "การสนับสนุนครั้งเดียวช่วยดูแลโอเพนซอร์ส เอกสาร เวอร์ชันที่ปรับให้เข้ากับท้องถิ่น 41 เวอร์ชัน และเว็บโฮสติ้ง โดยไม่ให้สถานะสมาชิกหรือสิทธิ์ลำดับความสำคัญในแผนพัฒนาและการสนับสนุน"],
  tr: ["Ko-fi üzerinden destekle", "Better Workflows’un bakımına yardımcı olun.", "Tek seferlik destek; açık kaynak bakımı, belgeler, 41 yerelleştirilmiş sürüm ve site barındırmasına katkı sağlar. Üyelik hakkı veya yol haritasında ya da destekte öncelik sağlamaz."],
  uk: ["Підтримати на Ko-fi", "Допоможіть підтримувати Better Workflows.", "Одноразова підтримка допомагає підтримувати відкритий код, документацію, 41 локалізовану версію та хостинг сайту. Вона не надає статусу учасника чи пріоритету в плані розвитку або підтримці."],
  vi: ["Ủng hộ qua Ko-fi", "Hãy giúp duy trì Better Workflows.", "Khoản ủng hộ một lần hỗ trợ bảo trì mã nguồn mở, tài liệu, 41 phiên bản bản địa hóa và lưu trữ website. Khoản này không mang lại tư cách thành viên hay quyền ưu tiên trong lộ trình hoặc hỗ trợ."],
  "zh-Hans": ["通过 Ko-fi 单次赞助", "帮助我们持续维护 Better Workflows。", "单次赞助将用于开源维护、文档、41 个本地化版本与网站托管；不包含会员资格，也不提供开发规划或技术支持优先权。"],
  "zh-Hant": ["透過 Ko-fi 單次贊助", "協助持續維護 Better Workflows。", "單次贊助將用於開源維護、文件、41 個本地化版本與網站託管；不包含會員資格，也不提供開發規劃或技術支援優先權。"],
  "zh-Hant-HK": ["透過 Ko-fi 一次性贊助", "協助持續維護 Better Workflows。", "一次性贊助會用於開源維護、文件、41 個本地化版本及網站託管；不包括會員資格，亦不會提供開發規劃或技術支援優先權。"],
  "zh-Hant-TW": ["透過 Ko-fi 單次贊助", "一起支持 Better Workflows 持續維護。", "單次贊助將用於開源維護、文件、41 個在地化版本與網站託管；不包含會員資格，也不提供開發規劃或技術支援優先權。"]
};

export const SPONSOR_ONE_TIME_MARKERS = {
  ar: "لمرة واحدة", ca: "puntual", cs: "Jednorázová", da: "engangsbidrag", de: "einmalige", el: "εφάπαξ", en: "one-time", es: "única", "es-MX": "única", fi: "Kertaluonteinen", fil: "minsanan", fr: "ponctuel", he: "חד-פעמית", hi: "एक बार", hr: "Jednokratna", hu: "egyszeri", id: "satu kali", it: "una tantum", ja: "一度限り", km: "ម្តង", ko: "일회성", lo: "ຄັ້ງດຽວ", ms: "sekali", my: "တစ်ကြိမ်တည်း", nb: "engangsbidrag", nl: "eenmalige", pl: "Jednorazowe", pt: "pontual", "pt-BR": "única", ro: "unică", ru: "Разовая", sk: "Jednorazová", sv: "engångsbidrag", th: "ครั้งเดียว", tr: "Tek seferlik", uk: "Одноразова", vi: "một lần", "zh-Hans": "单次赞助", "zh-Hant": "單次贊助", "zh-Hant-HK": "一次性贊助", "zh-Hant-TW": "單次贊助"
};

export const SPONSOR_LOCALE_MARKERS = {
  ar: "41 إصدارًا موطّنًا", ca: "41 versions localitzades", cs: "41 lokalizovaných verzí", da: "41 lokaliserede versioner", de: "41 lokalisierten Versionen", el: "41 τοπικοποιημένες εκδόσεις", en: "41 localized editions", es: "41 versiones localizadas", "es-MX": "41 versiones localizadas", fi: "41 lokalisoidun version", fil: "41 bersyong naisalokal", fr: "41 versions localisées", he: "41 גרסאות מותאמות לאזור", hi: "41 स्थानीयकृत संस्करण", hr: "41 lokaliziranog izdanja", hu: "41 lokalizált változat", id: "41 versi terlokalisasi", it: "41 versioni localizzate", ja: "41 ロケール向けのローカライズ版", km: "កំណែដែលបានធ្វើមូលដ្ឋានីយកម្មចំនួន 41", ko: "41개 로캘용 현지화 버전", lo: "ສະບັບທີ່ປັບໃຫ້ເໝາະກັບທ້ອງຖິ່ນ 41 ສະບັບ", ms: "41 versi disetempatkan", my: "ဒေသအလိုက် ပြင်ဆင်ထားသော မူကွဲ ၄၁ ခု", nb: "41 lokaliserte versjoner", nl: "41 gelokaliseerde versies", pl: "41 zlokalizowanych wersji", pt: "41 versões localizadas", "pt-BR": "41 versões localizadas", ro: "41 de versiuni localizate", ru: "41 локализованную версию", sk: "41 lokalizovaných verzií", sv: "41 lokaliserade versioner", th: "เวอร์ชันที่ปรับให้เข้ากับท้องถิ่น 41 เวอร์ชัน", tr: "41 yerelleştirilmiş sürüm", uk: "41 локалізовану версію", vi: "41 phiên bản bản địa hóa", "zh-Hans": "41 个本地化版本", "zh-Hant": "41 個本地化版本", "zh-Hant-HK": "41 個本地化版本", "zh-Hant-TW": "41 個在地化版本"
};

for (const locale of locales) {
  const copy = sponsorCopy[locale.code];
  if (!copy) throw new Error(`Missing sponsor copy: ${locale.code}`);
  if (!copy[2].includes(SPONSOR_ONE_TIME_MARKERS[locale.code])) throw new Error(`Sponsor copy is not explicitly one-time: ${locale.code}`);
  if (!copy[2].includes(SPONSOR_LOCALE_MARKERS[locale.code])) throw new Error(`Sponsor copy does not describe locale editions accurately: ${locale.code}`);
  Object.assign(locale.messages, { SPONSOR_CTA: copy[0], SPONSOR_TITLE: copy[1], SPONSOR_BODY: copy[2] });
}
