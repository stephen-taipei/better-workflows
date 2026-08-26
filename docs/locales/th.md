<div align="center">

# Better Workflows

control plane แบบ open-source และ goal-first สำหรับเวิร์กโฟลว์ agent พร้อมหลักฐานที่เป็นปัจจุบัน จุดตรวจ review และ provider reconciliation

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · **ไทย** · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[ดูเอกสาร](https://betterworkflows.dev/th/docs/) · [เปิด GitHub](https://github.com/stephen-taipei/better-workflows) · [สนับสนุนผ่าน Ko-fi](https://ko-fi.com/betterworkflows)

</div>

## พางานของ agent<br>ไปถึงจุดจบที่พิสูจน์ได้

Better Workflows ตรึง goal, scope และ authority แล้วผูกทุกการตัดสินใจกับหลักฐานที่เป็นปัจจุบันและตรวจซ้ำได้ รวมถึงผลลัพธ์ภายนอกที่ reconcile แล้ว

## สี่ขอบเขตที่ชัดเจนจากเจตนาถึงการเสร็จสมบูรณ์

กำหนด contract ตรวจสอบ source และ evidence กระทบยอดผลกระทบภายนอก และประกาศว่าเสร็จสมบูรณ์เมื่อทราบ terminal state แล้วเท่านั้น

- **01 · `TaskContract`** — Better Workflows ตรึง goal, scope และ authority แล้วผูกทุกการตัดสินใจกับหลักฐานที่เป็นปัจจุบันและตรวจซ้ำได้ รวมถึงผลลัพธ์ภายนอกที่ reconcile แล้ว
- **02 · `evidence`** — control plane แบบ open-source และ goal-first สำหรับเวิร์กโฟลว์ agent พร้อมหลักฐานที่เป็นปัจจุบัน จุดตรวจ review และ provider reconciliation
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
- [Evidence Cinema](https://betterworkflows.dev/th/docs/evidence-cinema/)


- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### `GUIDES · en`

- [`getting-started`](../guide/getting-started.md) · `en`
- [`workflows`](../guide/workflows.md) · `en`
- [`architecture`](../guide/architecture.md) · `en`
- [`security`](../guide/security.md) · `en`
- [`cli-reference`](../guide/cli-reference.md) · `en`
- [`readme-quality`](../guide/readme-quality.md) · `en`

### `POLICIES · en`

- [`CODE_OF_CONDUCT`](../../CODE_OF_CONDUCT.md) · `en`
- [`CONTRIBUTING`](../../CONTRIBUTING.md) · `en`
- [`GOVERNANCE`](../../GOVERNANCE.md) · `en`
- [`SECURITY`](../../SECURITY.md) · `en`
- [`SUPPORT`](../../SUPPORT.md) · `en`
- [`THIRD_PARTY_NOTICES`](../../THIRD_PARTY_NOTICES.md) · `en`
- [`ANSIBLE`](../../deploy/ansible/README.md) · `en`

### `RUNTIME SOURCE · en`

- [`plugins/better-workflows/skills/`](../../plugins/better-workflows/skills/)
- [`evidence-cinema/imagegen-manifest`](../html/evidence-cinema/assets/imagegen-manifest.md)
- [`use-cases/color-system`](../html/use-cases/assets/color-system.md)
- [`use-cases/imagegen-manifest`](../html/use-cases/assets/imagegen-manifest.md)
- [เปิด GitHub](https://github.com/stephen-taipei/better-workflows)

## ช่วยให้ Better Workflows ได้รับการดูแลต่อเนื่อง

การสนับสนุนครั้งเดียวช่วยดูแลโอเพนซอร์ส เอกสาร เวอร์ชันที่ปรับให้เข้ากับท้องถิ่น 41 เวอร์ชัน และเว็บโฮสติ้ง โดยไม่ให้สถานะสมาชิกหรือสิทธิ์ลำดับความสำคัญในแผนพัฒนาและการสนับสนุน

[สนับสนุนผ่าน Ko-fi](https://ko-fi.com/betterworkflows)

---

การรันคำสั่งไม่ใช่หลักฐานว่างานเสร็จ ผลลัพธ์ที่ตรวจสอบซ้ำได้ต่างหากคือหลักฐาน
