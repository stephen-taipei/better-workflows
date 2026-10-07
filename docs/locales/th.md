<div align="center">

# Better Workflows

Better Workflows V5.0 RC1 เปิดให้ใช้งานแบบสาธารณะแล้ว: เวิร์กโฟลว์ Auto แบบโอเพนซอร์สและใช้งานได้ฟรีสำหรับ QA วิศวกรรม AI และการส่งมอบ พร้อมหลักฐานปัจจุบัน, review gates และการกระทบยอดผู้ให้บริการ

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · **ไทย** · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[ดูเอกสาร](https://betterworkflows.dev/th/docs/) · [เปิด GitHub](https://github.com/stephen-taipei/better-workflows) · [สนับสนุนด้วย USDT (TRC20)](https://betterworkflows.dev/#sponsor)

</div>

V5.0 RC1 ครอบคลุม Codex, Gemini CLI และ Qwen Code บน macOS × Node 22/24 การประเมินคุณสมบัติของ Claude Code, Linux และ Windows ถูกเลื่อนออกไปเป็น V5.1 ส่วน GA ต้องใช้เวลา canary ตามธรรมชาติอย่างน้อย 30 วัน การเริ่มต้นที่มีสิทธิ์ติดต่อกัน 20 ครั้ง และที่เก็บข้อมูลที่แตกต่างกันสามแห่ง

## พางานของ agent<br>ไปถึงจุดจบที่พิสูจน์ได้

V5.0 RC1 เปิดให้ใช้งานแบบสาธารณะแล้ว Auto จะตรวจสอบเป้าหมาย ขอบเขต รีโพซิทอรี และความเสี่ยง จากนั้นจะเลือกการตรวจสอบแบบกำหนดเป้าหมายหรือเวิร์กโฟลว์หลักฐาน การเปลี่ยนแปลง Git จะใช้ worktree ที่เป็นของทาสก์ และการส่งมอบต้องได้รับการอนุญาตพร้อมผลลัพธ์ภายนอกที่ผ่านการยืนยันแล้ว

## สี่ขอบเขตที่ชัดเจนจากเจตนาถึงการเสร็จสมบูรณ์

กำหนด contract ตรวจสอบ source และ evidence กระทบยอดผลกระทบภายนอก และประกาศว่าเสร็จสมบูรณ์เมื่อทราบ terminal state แล้วเท่านั้น

- **01 · `TaskContract`** — V5.0 RC1 เปิดให้ใช้งานแบบสาธารณะแล้ว Auto จะตรวจสอบเป้าหมาย ขอบเขต รีโพซิทอรี และความเสี่ยง จากนั้นจะเลือกการตรวจสอบแบบกำหนดเป้าหมายหรือเวิร์กโฟลว์หลักฐาน การเปลี่ยนแปลง Git จะใช้ worktree ที่เป็นของทาสก์ และการส่งมอบต้องได้รับการอนุญาตพร้อมผลลัพธ์ภายนอกที่ผ่านการยืนยันแล้ว
- **02 · `evidence`** — Better Workflows V5.0 RC1 เปิดให้ใช้งานแบบสาธารณะแล้ว: เวิร์กโฟลว์ Auto แบบโอเพนซอร์สและใช้งานได้ฟรีสำหรับ QA วิศวกรรม AI และการส่งมอบ พร้อมหลักฐานปัจจุบัน, review gates และการกระทบยอดผู้ให้บริการ
- **03 · `reconciliation`** — กำหนด contract ตรวจสอบ source และ evidence กระทบยอดผลกระทบภายนอก และประกาศว่าเสร็จสมบูรณ์เมื่อทราบ terminal state แล้วเท่านั้น
- **04 · `terminal state`** — การรันคำสั่งไม่ใช่หลักฐานว่างานเสร็จ ผลลัพธ์ที่ตรวจสอบซ้ำได้ต่างหากคือหลักฐาน

## เริ่มต้นอย่างรวดเร็ว

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## ไปต่อจากแผนผังสถาปัตยกรรมสู่กรณีใช้งานจริง

- [สี่ขอบเขตที่ชัดเจนจากเจตนาถึงการเสร็จสมบูรณ์](https://betterworkflows.dev/th/docs/)
- [เริ่มต้นอย่างรวดเร็ว](https://betterworkflows.dev/th/docs/quick/)
- [ไปต่อจากแผนผังสถาปัตยกรรมสู่กรณีใช้งานจริง](https://betterworkflows.dev/th/docs/use-cases/)
- [เริ่มต้นอย่างรวดเร็ว — ไปต่อจากแผนผังสถาปัตยกรรมสู่กรณีใช้งานจริง](https://betterworkflows.dev/th/docs/use-cases/quick/)
- [โรงภาพยนตร์หลักฐาน](https://betterworkflows.dev/th/docs/evidence-cinema/)

### ดูเอกสาร · `th`

หน้าข้อมูลอ้างอิงนี้มีภาพรวมที่แปลแล้ว แต่เนื้อหาแบบโต้ตอบยังแปลไม่ครบ

- **01 · สี่ขอบเขตที่ชัดเจนจากเจตนาถึงการเสร็จสมบูรณ์** — กำหนด contract ตรวจสอบ source และ evidence กระทบยอดผลกระทบภายนอก และประกาศว่าเสร็จสมบูรณ์เมื่อทราบ terminal state แล้วเท่านั้น
- **02 · ไปต่อจากแผนผังสถาปัตยกรรมสู่กรณีใช้งานจริง** — V5.0 RC1 เปิดให้ใช้งานแบบสาธารณะแล้ว Auto จะตรวจสอบเป้าหมาย ขอบเขต รีโพซิทอรี และความเสี่ยง จากนั้นจะเลือกการตรวจสอบแบบกำหนดเป้าหมายหรือเวิร์กโฟลว์หลักฐาน การเปลี่ยนแปลง Git จะใช้ worktree ที่เป็นของทาสก์ และการส่งมอบต้องได้รับการอนุญาตพร้อมผลลัพธ์ภายนอกที่ผ่านการยืนยันแล้ว
- **03 · เริ่มต้นอย่างรวดเร็ว** — Better Workflows V5.0 RC1 เปิดให้ใช้งานแบบสาธารณะแล้ว: เวิร์กโฟลว์ Auto แบบโอเพนซอร์สและใช้งานได้ฟรีสำหรับ QA วิศวกรรม AI และการส่งมอบ พร้อมหลักฐานปัจจุบัน, review gates และการกระทบยอดผู้ให้บริการ

- [`สี่ขอบเขตที่ชัดเจนจากเจตนาถึงการเสร็จสมบูรณ์`](https://betterworkflows.dev/docs/reference/th/index.html) · `th`
- [`เริ่มต้นอย่างรวดเร็ว`](https://betterworkflows.dev/docs/reference/th/preview.html) · `th`
- [`ไปต่อจากแผนผังสถาปัตยกรรมสู่กรณีใช้งานจริง`](https://betterworkflows.dev/docs/reference/th/use-cases/index.html) · `th`
- [`เริ่มต้นอย่างรวดเร็ว — ไปต่อจากแผนผังสถาปัตยกรรมสู่กรณีใช้งานจริง`](https://betterworkflows.dev/docs/reference/th/use-cases/preview.html) · `th`
- [`โรงภาพยนตร์หลักฐาน`](https://betterworkflows.dev/docs/reference/th/evidence-cinema/index.html) · `th`

- [ดูเอกสาร · `th`](../details/th.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### ดูเอกสาร · `en`



### ดูเอกสาร · `th`

- [นโยบายความปลอดภัย](th/security.md) · `th`
- [การมีส่วนร่วม](th/contributing.md) · `th`
- [การกำกับดูแล](th/governance.md) · `th`
- [จรรยาบรรณชุมชน](th/conduct.md) · `th`
- [ประกาศเกี่ยวกับบุคคลที่สาม](th/notices.md) · `th`
- [พิมพ์เขียวด้านคุณภาพ README](th/readme-quality.md) · `th`
- [ระบบสีสำหรับงานบรรณาธิการ](th/color-system.md) · `th`
- [สถาปัตยกรรม](th/architecture.md) · `th`
- [ความปลอดภัย](th/security-guide.md) · `th`
- [ข้อมูลอ้างอิง CLI](th/cli-reference.md) · `th`
- [เริ่มต้นใช้งาน](th/getting-started.md) · `th`
- [เวิร์กโฟลว์](th/workflows.md) · `th`
- [การสนับสนุน](th/support.md) · `th`

## ช่วยให้ Better Workflows ได้รับการดูแลต่อเนื่อง

การสนับสนุนครั้งเดียวช่วยดูแลโอเพนซอร์ส เอกสาร การแปล 41 ภาษา และเว็บโฮสติ้ง โดยไม่ให้สมาชิกหรือสิทธิ์ลำดับความสำคัญใน roadmap และ support

[สนับสนุนด้วย USDT (TRC20)](https://betterworkflows.dev/#sponsor)

---

การรันคำสั่งไม่ใช่หลักฐานว่างานเสร็จ ผลลัพธ์ที่ตรวจสอบซ้ำได้ต่างหากคือหลักฐาน
