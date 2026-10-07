<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# การมีส่วนร่วม

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · **ไทย** · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

ขอบคุณที่ช่วยปรับปรุง Better Workflows

[README](../../../README.md) · **การมีส่วนร่วม** · [หลักปฏิบัติของชุมชน](conduct.md) · [ความปลอดภัย](security.md) · [การกำกับดูแล](governance.md) · [การสนับสนุน](support.md)

[ภาพรวมที่ปรับให้เหมาะกับท้องถิ่น 41 ฉบับและช่องทางเข้าสู่เว็บไซต์อย่างเป็นทางการ](../../../docs/LANGUAGES.md) นโยบายการมีส่วนร่วมฉบับกำหนดข้อบังคับนี้ยังคงยึดฉบับภาษาอังกฤษเป็นหลักอ้างอิงที่มีผลบังคับใช้

## ก่อนเริ่มต้น

- ใช้ issue หรือ discussion ก่อนสำหรับ public contract ใหม่\, การเปลี่ยนแปลงพฤติกรรม สาธารณะของ Auto\, ขอบเขตความปลอดภัย หรือการเปลี่ยนแปลงสถาปัตยกรรมขนาดใหญ่
- ให้หนึ่ง pull request มุ่งเน้นไปที่ผลลัพธ์เดียว
- ห้ามคอมมิตข้อมูลรับรอง\, พรอมต์ส่วนตัว\, ประวัติการสนทนาดิบ\, คีย์การลงนาม ของโฮสต์\, ใบเสร็จผู้ให้บริการ หรือการรับรองที่ลงนามแล้วโดยเด็ดขาด
- รายงานช่องโหว่ความปลอดภัยแบบส่วนตัวตามที่ระบุไว้ใน [SECURITY\.md](security.md)

## การตั้งค่าสำหรับการพัฒนา

ข้อกำหนด\:

- Node\.js 24 หรือใหม่กว่า\;
- ไม่มีการพึ่งพาไลบรารีของบุคคลที่สามในขณะรัน\;
- สาขาที่สะอาดโดยอิงจากสาขาเป้าหมายปัจจุบัน

รันชุดตรวจสอบพื้นฐานภายในเครื่องให้ครบทั้งหมด\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## กฎการเปลี่ยนแปลง

1. คงไว้ซึ่งการแก้ไขที่ Root เป็นเจ้าของและขอบเขตผลข้างเคียงแบบ fail\-closed
2. เมื่อพฤติกรรมสาธารณะของ Auto เปลี่ยนแปลง ให้อัปเดตเทมเพลตและ skill\, แคตตาล็อก entrypoint\, CLI\, การทดสอบ และเอกสารทั้งหมดที่ได้รับผลกระทบไปพร้อมกัน
3. ปฏิเสธตัวเลือก CLI ที่ไม่รู้จักและฟิลด์สกีมาที่ไม่รู้จัก
4. เก็บสถานะรันไทม์ส่วนตัวไว้นอกรีโพซิทอรี
5. เพิ่ม negative test สำหรับ safety gate ใหม่ทุกตัว
6. ห้ามแก้ไขเวอร์ชัน plugin\-cache ที่มีอยู่ซึ่งเป็น immutable โดยบันเดิลที่มีการเปลี่ยนแปลง จะต้องใช้เวอร์ชันบิลด์ใหม่และการยืนยันไดเจสต์ของซอร์ส\/แคชที่ตรงกันทุกประการ

สำหรับการจัดระเบียบเฉพาะ README ให้หน้าแรกระดับรากอ่านกวาดตาได้ง่าย และย้ายข้อกำหนดสัญญาโดยละเอียด ไปไว้ในไฟล์ที่ตรงกันภายใต้ [`docs/guide/`](../../../docs/guide/)

## รายการตรวจสอบคำขอรวมการเปลี่ยนแปลง

- [ ] ระบุขอบเขตและสิ่งที่ไม่ใช่เป้าหมายไว้อย่างชัดเจน
- [ ] มีเอกสารอธิบายพฤติกรรมและขอบเขตความปลอดภัย
- [ ] การทดสอบเฉพาะจุดครอบคลุมทั้งเส้นทางสำเร็จและล้มเหลว
- [ ] ชุดการทดสอบทั้งหมดและ `sbw eval` ผ่าน
- [ ] `git diff --check` ผ่าน
- [ ] การเปลี่ยนแปลงเวอร์ชัน\/แคชเป็นไปตามกฎการเผยแพร่แบบแก้ไขเปลี่ยนแปลงไม่ได้เมื่อกฎนั้นใช้บังคับ
- [ ] ไม่มีข้อมูลลับ สถานะส่วนตัว หรือหลักฐานตอบรับจากภายนอกรวมอยู่

ควรใช้คอมมิตขนาดเล็กที่ตรวจทานได้ง่าย ห้ามรวมการเก็บกวาดที่ไม่เกี่ยวข้องเข้ากับ การเปลี่ยนแปลงพฤติกรรม
