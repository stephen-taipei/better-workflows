<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# เริ่มต้นใช้งาน

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · **ไทย** · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 ครอบคลุม Codex\, Gemini CLI และ Qwen Code บน macOS × Node 22\/24 การประเมินคุณสมบัติของ Claude Code\, Linux และ Windows ถูกเลื่อนออกไปเป็น V5\.1 ส่วน GA ต้องใช้เวลา canary ตามธรรมชาติอย่างน้อย 30 วัน การเริ่มต้นที่มีสิทธิ์ติดต่อกัน 20 ครั้ง และที่เก็บข้อมูลที่แตกต่างกันสามแห่ง

| [ภาพรวม](../../../README.md) | [รายละเอียด](../../../docs/details/en.md) | **เริ่มต้นอย่างรวดเร็ว** | [เวิร์กโฟลว์](workflows.md) | [สถาปัตยกรรม](architecture.md) | [ความปลอดภัย](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[ภาพรวมที่ปรับให้เหมาะกับท้องถิ่น 41 ฉบับและช่องทางเข้าสู่เว็บไซต์อย่างเป็นทางการ](../../../docs/LANGUAGES.md)\. คำสั่งและตัวระบุยังคงใช้รูปแบบมาตรฐานภาษาอังกฤษ

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) เปิดให้ใช้งานแบบสาธารณะแล้ว ขอบเขตการเปิดตัวนี้ครอบคลุมเฉพาะ Auto เท่านั้น ร่วมกับ Codex\, Gemini CLI และ Qwen Code บน macOS Node 22\/24 ส่วนการรับรองสำหรับ Linux และ Windows จะถูกเลื่อนไปเป็น V5\.1 เช่นเดียวกับการรับรอง Claude Code ทั้งนี้ GA `5.0.0` จะยังคงรอดำเนินการจนกว่าจะบันทึก canary ได้อย่างน้อย 30 วันตามธรรมชาติ\, การเริ่มต้นที่มีคุณสมบัติติดต่อกัน 20 ครั้ง และมีรีโพซิทอรีที่แตกต่างกันสามแห่ง

## ข้อกำหนด

- Node\.js 22\.14 หรือใหม่กว่าสำหรับตัวช่วย `sbw` ที่มาพร้อมกัน
- รีโพซิทอรีในเครื่องที่เชื่อถือได้ Better Workflows ไม่ได้อ้างว่ามีการทำแซนด์บ็อกซ์สำหรับ โค้ดรีโพซิทอรีที่เป็นอันตราย

ไดเรกทอรีรากสำหรับเก็บสถานะใน v4 ไม่ผูกกับแพลตฟอร์มใดแพลตฟอร์มหนึ่ง\: หากตั้งค่า `SBW_STATE_ROOT` ไว้จะใช้ค่านั้นก่อน ตามด้วย `XDG_STATE_HOME/better-workflows` มิฉะนั้นจะใช้ `~/.better-workflows` ตำแหน่งเริ่มต้นไม่ได้อยู่ภายใต้ `CODEX_HOME` อีกต่อไป หากต้องการใช้สถานะ v3 ของ Codex ที่มีอยู่ต่อโดยไม่ย้ายสถานะ ให้กำหนด `SBW_STATE_ROOT` อย่างชัดเจนไปยังไดเรกทอรี `<CODEX_HOME>/sbw` นั้นให้ตรงทุกประการก่อนเรียกใช้ `sbw`

V5\.0 GA \(`5.0.0`\) ยังคงรอดำเนินการ คำสั่งการติดตั้งด้านล่างนี้มีเป้าหมายสำหรับ V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) ที่เปิดให้ใช้งานแบบสาธารณะแล้ว

## ติดตั้ง

### Codex — แพลตฟอร์มอ้างอิงที่แนะนำ

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

หลังติดตั้ง ให้เปิดงาน Codex ใหม่เพื่อรีเฟรชแค็ตตาล็อกทักษะ

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI คัดลอกส่วนขยาย ให้เริ่มเซสชันใหม่หลังติดตั้ง และใช้ `gemini extensions update better-workflows` เพื่ออัปเดตในภายหลัง

บริบทของส่วนขยายระบุตำแหน่งส่วนเชื่อมต่อจากพาธซอร์สที่ตัวส่วนขยายนั้นถูกโหลด ไม่ใช่จากไดเรกทอรีทำงานของโปรเจกต์ สำหรับการติดตั้งมาตรฐานในขอบเขตผู้ใช้ การตรวจสอบด้วยตนเองที่เทียบเท่ากันคือ\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

สำหรับส่วนขยายที่เชื่อมโยงไว้หรืออยู่ในขอบเขตพื้นที่ทำงาน ให้ใช้ไดเรกทอรีรากของส่วนขยายที่ตรงกับที่แพลตฟอร์มแสดงทุกประการ อย่าใช้สำเนา checkout ที่มีชื่อคล้ายกันแทน

### Qwen Code

ตรึงรุ่นเผยแพร่ก่อนติดตั้งสำเนาส่วนขยายภายในเครื่อง\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code คัดลอกส่วนขยายเช่นกัน จึงต้องเริ่มเซสชันใหม่หลังติดตั้ง และใช้ `qwen extensions update better-workflows` สำหรับการอัปเดตในภายหลัง

สำหรับการติดตั้งมาตรฐานในขอบเขตผู้ใช้ การตรวจสอบส่วนเชื่อมต่อด้วยตนเองที่เทียบเท่ากันคือ\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

กฎการใช้ไดเรกทอรีรากให้ตรงทุกประการนี้ใช้กับการติดตั้งที่เชื่อมโยงไว้หรืออยู่ในขอบเขตพื้นที่ทำงานด้วย

## ใช้งาน Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

ตัวเลือกเริ่มงานทุกตัวจะรักษา Goal ที่ร้องขอไว้ ต้องแก้ไขหรือล้าง Goal ที่กำลังทำงานแต่ไม่เกี่ยวข้องอย่างชัดเจน โดยจะไม่มีการแทนที่อย่างเงียบ ๆ

## ดูตัวอย่างเส้นทาง

สแนปช็อตความสามารถเป็นแบบอ่านอย่างเดียว และไม่กระตุ้นการเข้าสู่ระบบผู้ให้บริการหรือการตรวจสอบเชิงความหมายของโมเดล\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

เพื่อให้ตรวจทานการส่งต่องานได้ ให้บันทึกแล้วใช้บันทึกส่วนตัวที่ตรวจสอบยืนยันได้หนึ่งรายการ ซึ่งใช้ได้เพียงครั้งเดียว\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

บันทึกที่ตรวจสอบยืนยันได้จะหมดอายุหลัง 24 ชั่วโมง และระบบจะปฏิเสธการใช้งานเมื่อมีการใช้ซ้ำ หรือเมื่อพื้นที่ทำงาน ขอบเขต Profiles แค็ตตาล็อก ความสามารถ หรือชุดปลั๊กอินเปลี่ยนไปจากค่าที่ผูกไว้

## ตรวจสอบการติดตั้ง

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## ก่อนแก้ไขที่เก็บโค้ด

Auto เริ่มด้วยการตรวจสอบพื้นที่ทำงานล่วงหน้าแบบอ่านอย่างเดียว\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

งานที่ไม่เกี่ยวกับ Git และงานแบบอ่านอย่างเดียวจะไม่สร้าง worktree งาน Git ที่มีการเปลี่ยนแปลงต้องสร้างหรือนำ `TaskWorkspaceLeaseV1` ที่งานนั้นเป็นเจ้าของกลับมาใช้ หากไดเรกทอรีทำงานของซอร์สมีการเปลี่ยนแปลงที่ยังไม่ได้ commit กระบวนการจะหยุดก่อนการ stash คัดลอก commit หรือสร้าง worktree ใด ๆ HEAD ที่แยกออกจากสาขาหรือการไม่มีเป้าหมายจำเป็นต้องระบุเป้าหมายการรวมอย่างชัดเจน เป้าหมายที่ได้รับการป้องกันหรืออยู่บนรีโมตจะถูกยกระดับไปใช้กระบวนการส่งมอบผ่าน PR ภายใต้การกำกับดูแล

หาก Codex หรือแพลตฟอร์มอื่นสร้าง worktree ที่สะอาดสำหรับงานปัจจุบันไว้แล้ว ให้ลงทะเบียนก่อนแก้ไข แทนการสร้าง worktree ซ้อนกัน\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

การลงทะเบียนต้องใช้สาขางาน `codex/*` ที่แยกต่างหากและอยู่ที่รีวิชันฐานเดิมซึ่งไม่เปลี่ยนแปลง ใช้ไดเรกทอรีร่วมของ Git เดียวกัน และมี checkout ซอร์สที่สะอาด Better Workflows ใช้ worktree นั้น แต่จะเก็บสาขาและพาธที่แพลตฟอร์มเป็นเจ้าของไว้ระหว่างการทำความสะอาด สำหรับเป้าหมายที่ได้รับการป้องกัน ให้เรียกใช้เวิร์กโฟลว์หลักฐานก่อน จากนั้นใช้ `workspace reconcile --run-id <run-id>` เพื่อผูกบันทึกที่ตรวจสอบยืนยันได้ของการรวม PR และการซิงก์รีโมตจากเวิร์กโฟลว์นั้นให้ตรงกับรายการจริงทุกประการ

ถัดไป\: [เลือกเวิร์กโฟลว์ที่เหมาะสม](workflows.md) หรือเรียกดู [ข้อมูลอ้างอิง CLI](cli-reference.md)
