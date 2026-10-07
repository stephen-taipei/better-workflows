<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Chính sách bảo mật

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · **Tiếng Việt** · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Đóng góp](contributing.md) · [Quy tắc ứng xử](conduct.md) · **Bảo mật** · [Quản trị](governance.md) · [Hỗ trợ](support.md)

[Tổng quan với 41 bản địa hóa và các điểm truy cập web chính thức](../../../docs/LANGUAGES.md)\. Bản tiếng Anh của chính sách bảo mật mang tính quy phạm này vẫn là bản chuẩn có thẩm quyền\.

Nếu nguồn bằng chứng duy nhất được đề xuất chứa lịch sử riêng tư hoặc tài liệu vận hành nhạy cảm mà không thể loại bỏ thông tin nhạy cảm\, không thu thập hoặc truyền nguồn đó\. Chỉ ghi lại lý do `REJECTED_WITH_EVIDENCE` đã được che hoặc loại bỏ thông tin nhạy cảm\.

## Các phiên bản được hỗ trợ

| Phiên bản | Hỗ trợ |
| --- | --- |
| Bản phát hành mới nhất đã công bố và bản dựng Codex bất biến | Được hỗ trợ |
| Các phiên bản bộ nhớ đệm bất biến cũ hơn | Dùng làm đích khôi phục\; các bản sửa lỗi không được áp dụng ngược cho phiên bản cũ trừ khi có thông báo rõ ràng |
| Các bản phân nhánh chưa phát hành hoặc nội dung bộ nhớ đệm đã bị sửa đổi | Không được hỗ trợ |

## Báo cáo lỗ hổng

Vui lòng sử dụng [tính năng báo cáo lỗ hổng riêng tư của GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. Không mở vấn đề công khai cho một lỗ hổng nghi ngờ\.

Cung cấp\:

- phiên bản và bản dựng phần bổ trợ bị ảnh hưởng\;
- môi trường và phiên bản Node\.js\;
- các bước tái hiện tối thiểu\;
- ranh giới bảo mật dự kiến và quan sát được\;
- tác động và mọi biện pháp khắc phục tạm thời đã biết\;
- thông tin cho biết báo cáo có chứa tài liệu mật hay không\.

Không đưa vào thông tin xác thực đang có hiệu lực\, khóa ký\, mã thông báo của nhà cung cấp\, lời nhắc riêng tư ở dạng thô hoặc dữ liệu cá nhân của bên thứ ba\.

## Phản hồi

Người bảo trì sẽ xác nhận đã nhận một báo cáo có thể sử dụng\, xác minh phạm vi của báo cáo và phối hợp khắc phục cũng như công bố\. Không cam kết SLA cố định về thời gian phản hồi\. Các kết quả chưa xác định hoặc chưa được đối soát vẫn bị chặn\, từ chối tiếp tục khi chưa được xác minh\.

## Ranh giới bảo mật

Better Workflows giả định kho mã cục bộ\, máy thực thi và chuỗi công cụ thực thi đều đáng tin cậy\. Mô hình quyền của Node là một lớp phòng thủ bổ sung\, không phải hộp cát của hệ điều hành để cô lập mã độc\. Xem [hướng dẫn bảo mật](security-guide.md) đầy đủ\.
