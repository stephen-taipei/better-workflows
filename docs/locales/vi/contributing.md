<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Đóng góp

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · **Tiếng Việt** · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Cảm ơn bạn đã giúp cải thiện Better Workflows\.

[README](../../../README.md) · **Đóng góp** · [Quy tắc ứng xử](conduct.md) · [Bảo mật](security.md) · [Quản trị](governance.md) · [Hỗ trợ](support.md)

[Tổng quan với 41 bản địa hóa và các điểm truy cập web chính thức](../../../docs/LANGUAGES.md)\. Bản tiếng Anh của chính sách đóng góp mang tính quy phạm này vẫn là bản chuẩn có thẩm quyền\.

## Trước khi bắt đầu

- Sử dụng issue hoặc discussion trước đối với contract công khai mới\, thay đổi đối với hành vi công khai của Auto\, ranh giới bảo mật\, hoặc thay đổi lớn về kiến trúc\.
- Giữ một pull request tập trung vào một kết quả duy nhất\.
- Không bao giờ commit thông tin xác thực\, prompt riêng tư\, lịch sử hội thoại thô\, khóa ký của máy chủ\, biên nhận của nhà cung cấp\, hoặc chứng thực đã ký\.
- Báo cáo lỗ hổng bảo mật một cách riêng tư như được mô tả trong [SECURITY\.md](security.md)\.

## Thiết lập môi trường phát triển

Yêu cầu\:

- Node\.js 24 trở lên\;
- không có phụ thuộc thời gian chạy của bên thứ ba\;
- một nhánh sạch dựa trên nhánh đích hiện tại\.

Chạy toàn bộ bộ kiểm tra cơ sở cục bộ\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Quy tắc thay đổi

1. Bảo toàn quyền thay đổi do Root sở hữu và các ranh giới tác dụng phụ fail\-closed\.
2. Khi hành vi công khai của Auto thay đổi\, hãy cập nhật đồng thời template và skill\, danh mục entrypoint\, CLI\, các bài kiểm tra và toàn bộ tài liệu bị ảnh hưởng\.
3. Từ chối các tùy chọn CLI không xác định và các trường schema không xác định\.
4. Giữ trạng thái runtime riêng tư bên ngoài kho lưu trữ\.
5. Thêm các bài kiểm tra phủ định cho mỗi safety gate mới\.
6. Không thay đổi phiên bản plugin\-cache bất biến hiện có\. Một gói bundle bị thay đổi yêu cầu phiên bản bản dựng mới và xác minh digest nguồn\/cache chính xác\.

Khi chỉ tổ chức lại README\, hãy giữ trang gốc dễ đọc lướt và đặt các hợp đồng chi tiết trong tệp tương ứng dưới [`docs/guide/`](../../../docs/guide/)\.

## Danh sách kiểm tra yêu cầu hợp nhất

- [ ] Phạm vi và các mục tiêu không thuộc phạm vi đã được nêu rõ\.
- [ ] Hành vi và ranh giới an toàn đã được lập thành tài liệu\.
- [ ] Các kiểm thử tập trung bao quát cả đường đi thành công và thất bại\.
- [ ] Toàn bộ bộ kiểm thử và `sbw eval` đều đạt\.
- [ ] `git diff --check` đạt\.
- [ ] Các thay đổi phiên bản\/bộ nhớ đệm tuân theo quy tắc công bố bất biến khi áp dụng\.
- [ ] Không chứa bí mật\, trạng thái riêng tư hoặc biên nhận bên ngoài\.

Ưu tiên các bản ghi thay đổi nhỏ\, dễ xem xét\. Không kết hợp việc dọn dẹp không liên quan với một thay đổi hành vi\.
