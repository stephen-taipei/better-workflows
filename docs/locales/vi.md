<div align="center">

# Better Workflows

Better Workflows V5.0 RC1 hiện đã được công khai: một quy trình Auto mã nguồn mở, miễn phí cho QA kỹ thuật AI và bàn giao, với bằng chứng hiện thời, review gates và đối soát nhà cung cấp.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · **Tiếng Việt** · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Khám phá tài liệu](https://betterworkflows.dev/vi/docs/) · [Mở GitHub](https://github.com/stephen-taipei/better-workflows) · [Ủng hộ bằng USDT (TRC20)](https://betterworkflows.dev/#sponsor)

</div>

V5.0 RC1 áp dụng cho Codex, Gemini CLI và Qwen Code trên macOS × Node 22/24. Việc kiểm định cho Claude Code, Linux và Windows được dời sang V5.1. Bản GA yêu cầu ít nhất 30 ngày canary tự nhiên, 20 lần khởi động đủ điều kiện liên tiếp và ba kho lưu trữ riêng biệt.

## Đưa công việc của agent<br>đến kết quả có thể chứng minh.

V5.0 RC1 hiện đã được công khai. Auto kiểm tra mục tiêu, phạm vi, kho lưu trữ và rủi ro, sau đó chọn các bước kiểm tra có mục tiêu hoặc một evidence workflow. Thay đổi Git sử dụng worktree do tác vụ sở hữu; việc bàn giao yêu cầu có sự ủy quyền và kết quả bên ngoài đã được xác minh.

## Bốn ranh giới rõ ràng từ ý định đến hoàn tất.

Xác định contract, kiểm tra source và evidence, đối soát tác động bên ngoài, rồi chỉ tuyên bố hoàn tất khi terminal state đã rõ.

- **01 · `TaskContract`** — V5.0 RC1 hiện đã được công khai. Auto kiểm tra mục tiêu, phạm vi, kho lưu trữ và rủi ro, sau đó chọn các bước kiểm tra có mục tiêu hoặc một evidence workflow. Thay đổi Git sử dụng worktree do tác vụ sở hữu; việc bàn giao yêu cầu có sự ủy quyền và kết quả bên ngoài đã được xác minh.
- **02 · `evidence`** — Better Workflows V5.0 RC1 hiện đã được công khai: một quy trình Auto mã nguồn mở, miễn phí cho QA kỹ thuật AI và bàn giao, với bằng chứng hiện thời, review gates và đối soát nhà cung cấp.
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
- [Rạp chiếu bằng chứng](https://betterworkflows.dev/vi/docs/evidence-cinema/)

### Khám phá tài liệu · `vi`

Trang tham khảo này đã có phần tổng quan bằng ngôn ngữ của bạn; nội dung tương tác chưa được dịch đầy đủ.

- **01 · Bốn ranh giới rõ ràng từ ý định đến hoàn tất.** — Xác định contract, kiểm tra source và evidence, đối soát tác động bên ngoài, rồi chỉ tuyên bố hoàn tất khi terminal state đã rõ.
- **02 · Đi từ bản đồ kiến trúc đến các tình huống sử dụng thực tế.** — V5.0 RC1 hiện đã được công khai. Auto kiểm tra mục tiêu, phạm vi, kho lưu trữ và rủi ro, sau đó chọn các bước kiểm tra có mục tiêu hoặc một evidence workflow. Thay đổi Git sử dụng worktree do tác vụ sở hữu; việc bàn giao yêu cầu có sự ủy quyền và kết quả bên ngoài đã được xác minh.
- **03 · Bắt đầu nhanh** — Better Workflows V5.0 RC1 hiện đã được công khai: một quy trình Auto mã nguồn mở, miễn phí cho QA kỹ thuật AI và bàn giao, với bằng chứng hiện thời, review gates và đối soát nhà cung cấp.

- [`Bốn ranh giới rõ ràng từ ý định đến hoàn tất.`](https://betterworkflows.dev/docs/reference/vi/index.html) · `vi`
- [`Bắt đầu nhanh`](https://betterworkflows.dev/docs/reference/vi/preview.html) · `vi`
- [`Đi từ bản đồ kiến trúc đến các tình huống sử dụng thực tế.`](https://betterworkflows.dev/docs/reference/vi/use-cases/index.html) · `vi`
- [`Bắt đầu nhanh — Đi từ bản đồ kiến trúc đến các tình huống sử dụng thực tế.`](https://betterworkflows.dev/docs/reference/vi/use-cases/preview.html) · `vi`
- [`Rạp chiếu bằng chứng`](https://betterworkflows.dev/docs/reference/vi/evidence-cinema/index.html) · `vi`

- [Khám phá tài liệu · `vi`](../details/vi.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### Khám phá tài liệu · `en`



### Khám phá tài liệu · `vi`

- [Chính sách bảo mật](vi/security.md) · `vi`
- [Đóng góp](vi/contributing.md) · `vi`
- [Quản trị](vi/governance.md) · `vi`
- [Quy tắc ứng xử](vi/conduct.md) · `vi`
- [Thông báo về bên thứ ba](vi/notices.md) · `vi`
- [Bản thiết kế chất lượng README](vi/readme-quality.md) · `vi`
- [Hệ màu biên tập](vi/color-system.md) · `vi`
- [Kiến trúc](vi/architecture.md) · `vi`
- [Bảo mật](vi/security-guide.md) · `vi`
- [Tài liệu tham chiếu CLI](vi/cli-reference.md) · `vi`
- [Bắt đầu](vi/getting-started.md) · `vi`
- [Quy trình làm việc](vi/workflows.md) · `vi`
- [Hỗ trợ](vi/support.md) · `vi`

## Hãy giúp duy trì Better Workflows.

Khoản ủng hộ một lần hỗ trợ bảo trì mã nguồn mở, tài liệu, bản địa hóa 41 ngôn ngữ và lưu trữ website. Khoản này không mua tư cách thành viên hay ưu tiên roadmap hoặc hỗ trợ.

[Ủng hộ bằng USDT (TRC20)](https://betterworkflows.dev/#sponsor)

---

Việc một lệnh đã chạy không chứng minh công việc hoàn tất; kết quả có thể kiểm tra lại mới là bằng chứng.
