<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Bắt đầu

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · **Tiếng Việt** · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 áp dụng cho Codex\, Gemini CLI và Qwen Code trên macOS × Node 22\/24\. Việc kiểm định cho Claude Code\, Linux và Windows được dời sang V5\.1\. Bản GA yêu cầu ít nhất 30 ngày canary tự nhiên\, 20 lần khởi động đủ điều kiện liên tiếp và ba kho lưu trữ riêng biệt\.

| [Tổng quan](../../../README.md) | [Chi tiết](../../../docs/details/en.md) | **Bắt đầu nhanh** | [Quy trình làm việc](workflows.md) | [Kiến trúc](architecture.md) | [Bảo mật](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Tổng quan với 41 bản địa hóa và các điểm truy cập web chính thức](../../../docs/LANGUAGES.md)\. Các lệnh và định danh vẫn giữ nguyên dạng chuẩn bằng tiếng Anh\.

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) hiện đã được công khai\. Phạm vi phát hành này chỉ bao gồm Auto\, cùng với Codex\, Gemini CLI và Qwen Code trên macOS Node 22\/24\. Việc kiểm định cho Linux và Windows được hoãn lại đến V5\.1\, tương tự với việc kiểm định Claude Code\. GA `5.0.0` vẫn ở trạng thái chờ cho đến khi ghi nhận ít nhất 30 ngày canary tự nhiên\, 20 lần khởi động đủ điều kiện liên tiếp và ba kho lưu trữ riêng biệt\.

## Yêu cầu

- Node\.js 22\.14 trở lên cho tiện ích `sbw` đi kèm\.
- Một kho lưu trữ cục bộ đáng tin cậy\. Better Workflows không tuyên bố cô lập mã độc hại trong kho lưu trữ bằng sandbox\.

Thư mục gốc lưu trạng thái của v4 không phụ thuộc nền tảng\: ưu tiên `SBW_STATE_ROOT` nếu được đặt\, tiếp theo là `XDG_STATE_HOME/better-workflows`\, nếu không thì dùng `~/.better-workflows`\. Vị trí mặc định không còn nằm dưới `CODEX_HOME`\. Để tiếp tục dùng trạng thái Codex v3 hiện có mà không di chuyển nó\, hãy đặt rõ `SBW_STATE_ROOT` thành đúng thư mục `<CODEX_HOME>/sbw` đó trước khi gọi `sbw`\.

V5\.0 GA \(`5.0.0`\) vẫn đang chờ xử lý\. Các lệnh cài đặt bên dưới nhắm đến bản V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) hiện đã được công khai\.

## Cài đặt

### Codex — nền tảng tham chiếu được khuyến nghị

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

Mở một tác vụ Codex mới sau khi cài đặt để làm mới danh mục kỹ năng\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI sao chép tiện ích mở rộng\. Khởi động lại phiên sau khi cài đặt\; dùng `gemini extensions update better-workflows` để cập nhật về sau\.

Ngữ cảnh của tiện ích mở rộng xác định vị trí cầu nối từ chính đường dẫn nguồn đã được tải của nó\, không phải từ thư mục làm việc của dự án\. Với cách cài đặt tiêu chuẩn trong phạm vi người dùng\, thao tác kiểm tra thủ công tương đương là\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Với tiện ích mở rộng được liên kết hoặc được cài trong phạm vi không gian làm việc\, hãy dùng đúng thư mục gốc của tiện ích mà nền tảng hiển thị\. Không thay bằng một bản checkout có tên tương tự\.

### Qwen Code

Ghim bản phát hành trước khi cài đặt bản sao cục bộ của tiện ích mở rộng\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code cũng sao chép tiện ích mở rộng\, vì vậy hãy khởi động lại phiên sau khi cài đặt và dùng `qwen extensions update better-workflows` cho các lần cập nhật sau\.

Với cách cài đặt tiêu chuẩn trong phạm vi người dùng\, thao tác kiểm tra cầu nối thủ công tương đương là\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Quy tắc dùng đúng thư mục gốc này cũng áp dụng cho các bản cài đặt được liên kết hoặc nằm trong phạm vi không gian làm việc\.

## Sử dụng Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Mỗi mục khởi chạy đều giữ nguyên Goal được yêu cầu\. Một Goal đang hoạt động nhưng không liên quan phải được chỉnh sửa hoặc xóa một cách rõ ràng\; nó không bao giờ bị âm thầm thay thế\.

## Xem trước lộ trình

Ảnh chụp trạng thái năng lực ở chế độ chỉ đọc và không kích hoạt đăng nhập vào nhà cung cấp hay thăm dò ngữ nghĩa mô hình\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Để có thể rà soát việc bàn giao\, hãy ghi lại rồi sử dụng một bản ghi riêng tư có thể xác minh\, chỉ dùng một lần\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Các bản ghi có thể xác minh hết hạn sau 24 giờ\; hệ thống từ chối sử dụng khi bản ghi bị dùng lại hoặc khi không gian làm việc\, phạm vi\, Profiles\, danh mục\, năng lực hay gói plugin lệch khỏi trạng thái đã ràng buộc\.

## Xác minh việc cài đặt

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Trước khi thay đổi kho mã

Auto bắt đầu bằng bước kiểm tra trước đối với không gian làm việc ở chế độ chỉ đọc\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Các tác vụ không dùng Git và tác vụ chỉ đọc không tạo worktree\. Tác vụ Git có thay đổi phải tạo hoặc tái sử dụng một `TaskWorkspaceLeaseV1` thuộc sở hữu của tác vụ đó\. Nếu thư mục làm việc của mã nguồn có thay đổi chưa được commit\, quy trình dừng trước mọi thao tác stash\, sao chép\, commit hoặc tạo worktree\. HEAD ở trạng thái tách rời hoặc thiếu đích đều đòi hỏi phải chỉ định rõ đích tích hợp\. Các đích được bảo vệ hoặc ở xa được chuyển lên quy trình bàn giao qua PR có cơ chế quản trị\.

Nếu Codex hoặc một nền tảng khác đã tạo worktree sạch cho tác vụ hiện tại\, hãy đăng ký nó trước khi chỉnh sửa thay vì tạo worktree lồng nhau\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Việc đăng ký yêu cầu một nhánh tác vụ `codex/*` riêng biệt tại bản sửa đổi cơ sở không đổi\, cùng thư mục dùng chung của Git và một bản checkout nguồn sạch\. Better Workflows sử dụng worktree nhưng giữ nguyên nhánh và đường dẫn thuộc sở hữu của nền tảng khi dọn dẹp\. Với đích được bảo vệ\, hãy chạy quy trình bằng chứng trước\, sau đó dùng `workspace reconcile --run-id <run-id>` để ràng buộc đúng các bản ghi có thể xác minh về việc hợp nhất PR và đồng bộ từ xa của quy trình đó\.

Tiếp theo\: [chọn quy trình làm việc phù hợp](workflows.md) hoặc duyệt xem [tài liệu tham khảo CLI](cli-reference.md)\.
