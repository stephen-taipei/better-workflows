<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Bản thiết kế chất lượng README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · **Tiếng Việt** · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Tổng quan với 41 bản địa hóa và các điểm truy cập web chính thức](../../../docs/LANGUAGES.md)\. Bản tiếng Anh vẫn là bản chuẩn của bản thiết kế biên tập này\.

README của Better Workflows là trang đích\, không phải tài liệu tham chiếu được nén lại\. Nhiệm vụ của nó là giúp người đọc lần lượt trả lời năm câu hỏi\:

1. Đây là gì và có dành cho tôi không\?
2. Nó giải quyết vấn đề gì\?
3. Vì sao tôi nên tin vào các tuyên bố của nó\?
4. Đâu là con đường ngắn nhất để đạt được thành công đầu tiên\?
5. Tôi nên đi đâu tiếp theo\?

Bản thiết kế này xác định quy ước về cách dẫn dắt nội dung\, hình ảnh\, bản địa hóa và xác minh cho mọi README trong kho mã\. Nguồn mà máy có thể đọc là [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Bắt đầu từ quyết định của người đọc

GitHub hiển thị README trước phần lớn nội dung trong kho mã\. Vì vậy\, màn hình đầu tiên phải nêu rõ lời hứa của sản phẩm\, đối tượng hướng đến và hành động tiếp theo có phạm vi giới hạn\. Không được mở đầu bằng kiến trúc nội bộ\, bản tham chiếu lệnh đầy đủ hoặc chi tiết khôi phục bản phát hành\.

Hãy viết để phục vụ những việc người đọc cần làm sau đây\:

- **Khách truy cập mới\:** nhanh chóng xác định xem Better Workflows có giải quyết được vấn đề phù hợp hay không\.
- **Người dùng mới\:** cài đặt plugin và hoàn thành một tuyến tự động thành công\.
- **Người đánh giá\:** hiểu rõ ranh giới thẩm quyền và hành vi fail\-closed\.
- **Người vận hành quay lại\:** chuyển nhanh đến câu trả lời về quy trình\, bảo mật\, kiến trúc hoặc CLI\.
- **Người đóng góp hoặc biên dịch viên\:** tìm contract chuẩn tắc\, các lệnh phát triển\, hỗ trợ và quản trị\.

## Dẫn dắt nội dung theo quan hệ nhân quả

Năm README làm trang đích sử dụng cùng một trình tự ngữ nghĩa gồm tám phần\. Tiêu đề có thể diễn đạt tự nhiên theo từng ngôn ngữ\, nhưng hành trình của người đọc không thay đổi\.

| Phần | Câu hỏi của người đọc và vai trò trong mạch nội dung |
| --- | --- |
| Lời hứa và đối tượng | Better Workflows là gì\, vì sao nó tồn tại và dành cho ai\? |
| Từ vấn đề đến kết quả | Điều gì có thể xảy ra khi ý định\, thẩm quyền\, bằng chứng và kết quả từ nhà cung cấp bị đánh đồng\? |
| Cơ sở chứng minh và ranh giới | Những bảo đảm nào khiến kết quả được đề xuất trở nên đáng tin cậy\? |
| Thành công đầu tiên | Đâu là lộ trình hoàn chỉnh ngắn nhất từ cài đặt đến kết quả\? |
| Chọn hướng đi tiếp theo | Quy trình làm việc hoặc tài liệu nào phù hợp với mục tiêu của người đọc\? |
| Vòng đời | Một mục tiêu trở thành trạng thái hoàn tất đã được đối soát\, hoặc dừng lại an toàn\, như thế nào\? |
| Niềm tin và giới hạn | Hệ thống tuyệt đối không được suy diễn\, cấp phép hoặc tuyên bố điều gì\? |
| Tìm hiểu\, nhận hỗ trợ\, đóng góp | Tài liệu chuyên sâu\, hỗ trợ\, quản trị\, phát triển và giấy phép nằm ở đâu\? |

Thứ tự này tạo nên một mạch nội dung thiết thực\:

- **Bối cảnh\:** công việc được dẫn dắt bằng lời nhắc có thể thể hiện ý định mà không chứng minh được thẩm quyền hoặc trạng thái\.
- **Mâu thuẫn\:** các tác động phụ biến khoảng trống đó thành rủi ro bàn giao kết quả\.
- **Cách giải quyết\:** Better Workflows gắn kết mục tiêu\, phạm vi\, bằng chứng\, đánh giá\, hành động và việc đối soát với nhà cung cấp\.
- **Chứng minh\:** những bảo đảm và ranh giới rõ ràng cho thấy cách giải quyết hoạt động như thế nào\.
- **Hành động\:** người đọc đạt được thành công đầu tiên trước khi gặp các chi tiết triển khai chuyên sâu\.
- **Tiếp nối\:** các lộ trình dựa trên vai trò và kết quả đưa người đọc đến đúng bài hướng dẫn học\, hướng dẫn thao tác\, phần giải thích hoặc tài liệu tham chiếu\.

## Tách nội dung trang đích khỏi tài liệu chuyên sâu

Dùng README cho thông tin liên quan đến quyết định\. Dẫn đến nội dung chuyên sâu theo mục đích\:

- [Bắt đầu](getting-started.md) là bài hướng dẫn cho lần sử dụng đầu tiên\.
- [Quy trình làm việc](workflows.md) là hướng dẫn thao tác để lựa chọn kết quả\.
- [Kiến trúc](architecture.md) giải thích mặt phẳng điều khiển và những đánh đổi\.
- [Bảo mật](security-guide.md) giải thích thẩm quyền\, quyền riêng tư\, chứng thực và hành vi từ chối thực thi khi chưa xác minh được\.
- [Tham chiếu CLI](cli-reference.md) là tài liệu tham chiếu lệnh\.
- Các trang `docs/details/*.md` đã bản địa hóa giữ lại đầy đủ nội dung chi tiết được dịch\.

Không lặp lại nội dung khôi phục bộ nhớ đệm\, quyền sở hữu khóa\, toàn bộ ngữ nghĩa truyền tải của nhà cung cấp\, danh sách lệnh đầy đủ hoặc lịch sử thay đổi triển khai trên trang đích\. Một tuyên bố an toàn ngắn gọn được giữ ngay tại trang này\; phần chi tiết có thể kiểm toán của nó thuộc về hướng dẫn chuẩn\.

Cách phân chia này tuân theo sự phân biệt của Diátaxis giữa bài hướng dẫn học\, hướng dẫn thao tác\, phần giải thích và tài liệu tham chiếu\. Một trang không thể đồng thời tối ưu cho cả bốn nhu cầu này của người đọc\.

## Mỗi hình minh họa phải có lý do để xuất hiện

Chỉ dùng hình minh họa khi nó giúp người đọc hiểu các mối quan hệ\, hệ thống phân cấp hoặc chuyển đổi trạng thái dễ hơn đáng kể so với văn xuôi\.

Các trang đích cho phép hai hình minh họa\:

1. **Kiến trúc ranh giới thẩm quyền\:** trả lời những lớp nào định hình ý định\, dữ kiện hiện tại\, thẩm quyền của công cụ\, các lần thử lại có giới hạn và trạng thái chỉ đọc\.
2. **Vòng đời từ mục tiêu đến hoàn tất\:** trả lời bằng chứng được kiểm tra ở đâu\, tác động phụ được cho phép ở đâu và trạng thái chưa biết khiến tiến trình dừng lại ở đâu\.

Mỗi hình minh họa phải có\:

- văn bản thay thế ngắn gọn\, có ý nghĩa\;
- nội dung văn bản tương đương đặt liền kề\, giữ nguyên kết luận khi hình minh họa bị ẩn hoặc Mermaid không hiển thị được\;
- văn bản thực cho các nhãn thiết yếu bất cứ khi nào có thể\;
- một câu hỏi ổn định của người đọc làm cơ sở cho việc duy trì hình minh họa luôn cập nhật\.

Không thêm ảnh chụp màn hình để trang trí\, hình ảnh chứa quá nhiều chữ hoặc sơ đồ chỉ lặp lại một danh sách ngắn\. Giữ các bảng lựa chọn ở hai cột ngắn gọn để chúng vẫn dùng được trên màn hình hẹp\.

## Giữ nguyên ý nghĩa giữa các ngôn ngữ

Tiếng Anh là nguồn tham chiếu về ngữ nghĩa\, không phải mục tiêu về số dòng\. Tiếng Trung phồn thể\, tiếng Trung giản thể\, tiếng Nhật và tiếng Hàn cần tự nhiên đối với người bản ngữ\, đồng thời giữ nguyên cùng một quy ước\.

Các nội dung sau phải giữ tính tương đương\:

- tám phần ngữ nghĩa và thứ tự của chúng\;
- các lệnh để đạt thành công đầu tiên và mã định danh sản phẩm\;
- năm tuyên bố về thẩm quyền\, bằng chứng\, trạng thái chưa biết\, lời nhắc và quyền riêng tư\;
- các đích đến về quy trình làm việc\, bảo mật\, kiến trúc\, CLI\, hỗ trợ\, quản trị\, phát triển và giấy phép\;
- mục đích của hình minh họa\, các giai đoạn vòng đời và văn bản thay thế dự phòng\;
- nguồn phiên bản và chính sách huy hiệu\.

Tiêu đề\, cách ngắt câu\, dấu câu\, ví dụ và lời kêu gọi hành động có thể theo lối diễn đạt tự nhiên của ngôn ngữ\. Tuyệt đối không dịch các lệnh\, bộ chọn\, mã định danh bằng chứng hoặc ngữ nghĩa bảo mật\.

## Viết để dễ đọc lướt và dễ dịch

- Mở đầu bằng kết quả dành cho người đọc và đặt các thuật ngữ quan trọng ở đầu tiêu đề và đoạn văn\.
- Dùng thể chủ động và nêu rõ chủ thể chịu trách nhiệm cho hành động\.
- Hướng dẫn trực tiếp người đọc khi trình bày quy trình\.
- Giữ đoạn văn ngắn và giao cho mỗi đoạn một nhiệm vụ duy nhất\.
- Dùng danh sách đánh số cho trình tự và danh sách dấu đầu dòng cho các lựa chọn không theo trình tự\.
- Dùng liên kết có mô tả thay cho nhãn chung chung như “nhấp vào đây”\.
- Giữ hệ thống tiêu đề có phân cấp\, cụ thể và đồng dạng ở cùng một cấp\.
- Ưu tiên ngôn ngữ mang nghĩa trực tiếp\, không mơ hồ và giữ được ý nghĩa khi dịch\.
- Đặt điều kiện trước chỉ dẫn và kết quả mong đợi sau lệnh\.

## Xác minh ngữ nghĩa\, không phải phần trang trí

Các bài kiểm thử tài liệu phải kiểm tra nhiều hơn việc tiêu đề có khớp nhau hay không\. Chúng xác minh\:

- một H1 và cấu trúc phân cấp tiêu đề hợp lý\;
- các phần ngữ nghĩa có thứ tự và dấu chỉ định tuyên bố quan trọng\;
- các lệnh thành công ngay lần đầu chính xác và các mã định danh ổn định\;
- các liên kết tương đối và đích đến chi tiết theo từng ngôn ngữ\;
- huy hiệu phiên bản tương đồng với siêu dữ liệu runtime\;
- văn bản alt có ý nghĩa cho hình ảnh và phương án trực quan dự phòng liền kề\;
- một vòng đời Mermaid duy nhất kèm nội dung văn bản tương đương đầy đủ\;
- bảng hai cột và giới hạn độ dài đoạn văn\;
- không đưa chi tiết triển khai chuyên sâu được chỉ định vào các trang đích\;

## Cơ sở nghiên cứu

- [GitHub\: Giới thiệu về tệp README của kho mã](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) xác định mục đích của README đối với lần truy cập đầu tiên và khuyến nghị chuyển tài liệu dài sang nơi khác\.
- [Diátaxis](https://diataxis.fr/start-here/) phân biệt nhu cầu về bài hướng dẫn học\, hướng dẫn thao tác\, phần giải thích và tài liệu tham chiếu\.
- [Microsoft\: Nội dung dễ đọc lướt](https://learn.microsoft.com/en-us/style-guide/scannable-content/) nhấn mạnh cấu trúc đặt nội dung quan trọng trước\, đoạn văn ngắn và các điểm bắt đầu đọc nhất quán về mặt thị giác\.
- [Phong cách tài liệu dành cho nhà phát triển của Google](https://developers.google.com/style/highlights) khuyến nghị dùng thể chủ động\, hướng dẫn trực tiếp\, tiêu đề có tính mô tả\, khả năng tiếp cận và cách viết dành cho độc giả toàn cầu\.
- [GitHub\: Tạo sơ đồ](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) trình bày khả năng hỗ trợ Mermaid trong Markdown\.
- [W3C WAI\: Hướng dẫn về hình ảnh](https://www.w3.org/WAI/tutorials/images/) yêu cầu văn bản thay thế và nội dung tương đương đầy đủ cho hình minh họa mang thông tin và hình minh họa phức tạp\.
