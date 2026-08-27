<div align="center">

# Better Workflows

Mặt phẳng điều khiển mã nguồn mở, goal-first cho quy trình agent với bằng chứng cập nhật, cổng review và đối soát provider.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · **Tiếng Việt** · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Khám phá tài liệu](https://betterworkflows.dev/vi/docs/) · [Mở GitHub](https://github.com/stephen-taipei/better-workflows) · [Ủng hộ qua Ko-fi](https://ko-fi.com/betterworkflows)

</div>

## Đưa công việc của agent<br>đến kết quả có thể chứng minh.

Better Workflows cố định goal, scope và authority, rồi gắn mỗi quyết định với bằng chứng cập nhật có thể kiểm tra lại và kết quả bên ngoài đã được đối soát.

## Bốn ranh giới rõ ràng từ ý định đến hoàn tất.

Xác định contract, kiểm tra source và evidence, đối soát tác động bên ngoài, rồi chỉ tuyên bố hoàn tất khi terminal state đã rõ.

- **01 · `TaskContract`** — Better Workflows cố định goal, scope và authority, rồi gắn mỗi quyết định với bằng chứng cập nhật có thể kiểm tra lại và kết quả bên ngoài đã được đối soát.
- **02 · `evidence`** — Mặt phẳng điều khiển mã nguồn mở, goal-first cho quy trình agent với bằng chứng cập nhật, cổng review và đối soát provider.
- **03 · `reconciliation`** — Xác định contract, kiểm tra source và evidence, đối soát tác động bên ngoài, rồi chỉ tuyên bố hoàn tất khi terminal state đã rõ.
- **04 · `terminal state`** — Việc một lệnh đã chạy không chứng minh công việc hoàn tất; kết quả có thể kiểm tra lại mới là bằng chứng.

## Bắt đầu nhanh

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## Đi từ bản đồ kiến trúc đến các tình huống sử dụng thực tế.

- [Bốn ranh giới rõ ràng từ ý định đến hoàn tất.](https://betterworkflows.dev/vi/docs/)
- [Bắt đầu nhanh](https://betterworkflows.dev/vi/docs/quick/)
- [Đi từ bản đồ kiến trúc đến các tình huống sử dụng thực tế.](https://betterworkflows.dev/vi/docs/use-cases/)
- [Bắt đầu nhanh — Đi từ bản đồ kiến trúc đến các tình huống sử dụng thực tế.](https://betterworkflows.dev/vi/docs/use-cases/quick/)
- [Evidence Cinema](https://betterworkflows.dev/vi/docs/evidence-cinema/)


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
- [Mở GitHub](https://github.com/stephen-taipei/better-workflows)

## Hãy giúp duy trì Better Workflows.

Khoản ủng hộ một lần hỗ trợ bảo trì mã nguồn mở, tài liệu, 41 phiên bản bản địa hóa và lưu trữ website. Khoản này không mang lại tư cách thành viên hay quyền ưu tiên trong lộ trình hoặc hỗ trợ.

[Ủng hộ qua Ko-fi](https://ko-fi.com/betterworkflows)

---

Việc một lệnh đã chạy không chứng minh công việc hoàn tất; kết quả có thể kiểm tra lại mới là bằng chứng.
