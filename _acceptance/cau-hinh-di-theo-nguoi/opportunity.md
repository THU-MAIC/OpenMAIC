---
schema_version: 1
slug: cau-hinh-di-theo-nguoi
feature: Cấu hình đi theo người, không nằm lại trên máy
owner: Manh Phan
stage: decided
decision: build
decided_by: Manh Phan
decided_at: 2026-09-20T00:00:00Z
prototype:
  base_commit:
  disposition: archive
---

## Vấn đề & ai gặp

Người tự dựng OpenMAIC khai xong cả một bảng cấu hình — nhà cung cấp mô hình,
khoá API, mô hình đã chọn, giọng đọc, tìm kiếm web — rồi mở sản phẩm trên máy
thứ hai và thấy trống trơn. Phải khai lại từ đầu, từng mục một. Không có tài
khoản, nên không có chỗ nào để treo cấu hình đó ngoài chính cái máy vừa gõ.

Căng thẳng gốc: **lõi của kho thiết kế theo lối local, nhưng runtime đang chạy
trên Vercel.** Thiết kế local coi cái máy là nhà của trạng thái. Trên Vercel,
deployment mới là chung, còn cái máy chỉ là một cửa sổ ghé qua — nên chỗ cất
trạng thái không còn là nhà nữa.

Đọc được trong kho, không phải suy đoán:

- Kho tự khai điều này là thiếu sót, ngay trong file cấu hình: cấu hình nhà
  cung cấp là "giá trị phạm vi `account`… **thứ mà máy thứ hai lẽ ra không phải
  nghe lại**" (`lib/store/settings.ts`, đầu file).
- Lớp lưu trữ đã có đủ hai phạm vi `device` | `account`, và đã có sẵn một bản
  KV chạy qua HTTP (`HttpKVStore`, gói `@openmaic/storage`). Nhưng trong app,
  **mọi** chỗ đều dựng `BrowserKVStore` — tức localStorage. Phạm vi `account`
  hiện là lời hứa trong hợp đồng; thực tế nó nằm trên một máy.
- Danh tính hiện là khoá ẩn danh theo máy, và code tự khai sẵn đường di trú khi
  có đăng nhập: `mergeLearner(anonKey, accountKey)` — hàm đó đã viết và đã có
  kiểm thử trong gói lưu trữ, chỉ chưa có ai gọi (`lib/runtime/learner-key.ts`).
- Thứ đang đóng vai xác thực là một `ACCESS_CODE` dùng chung cho cả deployment.
  Module xác thực của tầng lưu trữ tự khai bằng chữ hoa rằng nó CHỈ DÀNH CHO
  PHÁT TRIỂN, không tách được người dùng, và production phải thay
  (`lib/persistence/server-auth.ts`).

Nói gọn: mọi chỗ cắm đã có sẵn và đã được ghi chú là chờ đăng nhập. Thiếu đúng
một thứ — một danh tính để treo phạm vi `account` lên.

## Giả định chốt sinh tử

| # | Giả định | Nếu sai thì | Phép thử rẻ nhất | Trạng thái |
|---|---|---|---|---|
| 1 | Cái đau là cấu hình không đi theo NGƯỜI, không phải riêng khoá API | Khai khoá phía máy chủ (`server-providers.yml` + biến môi trường) đã giải xong, không cần tài khoản nào cả | Khai khoá trên máy chủ của bản Vercel, mở máy thứ hai, liệt kê xem còn phải gõ lại những gì | **Đã thử 20/09 — đúng một nửa, xem dưới bảng** |
| 2 | Thêm danh tính mà KHÔNG làm hỏng đường chạy local một người | Người tự dựng phải dựng thêm một hệ đăng nhập để dùng thứ trước đây mở là chạy — mất đúng tính chất local của kho | Thử tắt danh tính trên một bản local, xem còn chạy trọn không | Chưa thử |
| 3 | Treo được phạm vi `account` lên danh tính có sẵn, không phải tự viết hệ đăng nhập | Vòng này phình thành làm hệ tài khoản — giá gấp nhiều lần, và là sản phẩm khác | Đọc chỗ cắm của `HttpKVStore` và `mergeLearner`, xem một nhà cung cấp đăng nhập sẵn có ghép vừa không | Chưa thử |

### Kết quả phép thử giả định 1 — 20/09/2026

Trả lời bằng cách đọc mã nguồn, không cần dựng máy thứ hai: deployment đã khai
khoá phía máy chủ thì máy mới nhận được gì, và còn phải gõ lại gì.

**Tự về từ máy chủ** (`/api/server-providers` trả về, lần chạy đầu tự chọn giúp):

- Nhà cung cấp, khoá API và địa chỉ gốc — đủ cả bảy nhóm: mô hình ngôn ngữ, giọng đọc, nhận giọng nói, PDF, ảnh, video, tìm kiếm web.
- Lần chạy đầu còn tự chọn nhà cung cấp và mô hình cho giọng đọc, nhận giọng nói, ảnh, video, PDF, và tự bật/tắt các tính năng đó theo những gì máy chủ có.

**Không có đường nào từ máy chủ — vẫn phải gõ lại trên từng máy:**

- Danh sách giọng đã nhập từ tài khoản nhà cung cấp (`customVoices` nằm trong khối cấu hình lưu ở trình duyệt).
- Mô hình do người tự thêm (`customModels`).
- Giọng gán riêng cho từng nhân vật dạy (`agentVoiceOverrides`).
- Mô hình hoặc giọng người tự chọn khác với lựa chọn tự động.
- Hồ sơ người dùng và bố cục màn hình.

**Kết luận:** giả định 1 sai ở vế khoá, đúng ở vế lựa chọn. Khoá API **đã** đi
theo deployment rồi — không cần tài khoản cho việc đó. Thứ nằm lại trên máy là
**lựa chọn của người**. Vòng này không chết, nhưng thu nhỏ: đề bài đúng là
«lựa chọn của người đi theo người», không phải «cấu hình đi theo người».

## Ngưỡng chết / ngưỡng UAT

- Câu hỏi phép đo trả lời: Người đã khai cấu hình trên một máy, mở sản phẩm trên máy thứ hai, có làm việc được ngay mà không phải khai lại gì không?
- Kết quả nào là SỐNG: mở trên máy thứ hai và tạo được một khóa học ngay bằng đúng giọng và mô hình đã chọn ở máy cũ, không mở Cài đặt lần nào
- Kết quả nào là CHẾT: vẫn phải khai lại từ hai mục lựa chọn trở lên, HOẶC lựa chọn của hai người trộn vào nhau trên cùng một deployment
- Timebox: 3 ngày dựng, 1 tuần chờ tín hiệu

## Kết quả prototype

Chưa dựng.

## Nguồn ngoài & phạm vi kế thừa

Không có vật liệu ngoài repo. Mọi bằng chứng ở trên rút từ chính mã nguồn và
chú thích của kho này.

| Món vật liệu | Nguồn (đường dẫn/tên gói) | Phân loại | Kế thừa? | Người ký |
|---|---|---|---|---|
| (không có) | — | — | — | — |

## Cổng Đáng

- **decision = build** Căn cứ: phép thử giả định 1 (20/09) thu nhỏ đề bài xuống còn «lựa chọn của người đi theo người» — khoá API đã có đường máy chủ. Mọi chỗ cắm cho phần còn lại đã nằm sẵn trong kho và đã được ghi chú là chờ đăng nhập, nên đây là nối một danh tính vào chỗ đã chừa, không phải dựng hệ mới.
- **disposition = archive** Căn cứ: chưa dựng prototype nào, không có mã nào để mang sang — không phải một đánh đổi, chỉ là ghi đúng thực tế.
- **Ngưỡng UAT chốt cùng lúc ký:** mở trên máy thứ hai và tạo được một khóa học ngay bằng đúng giọng và mô hình đã chọn ở máy cũ, không mở Cài đặt lần nào. CHẾT khi vẫn phải khai lại từ hai mục lựa chọn trở lên, hoặc lựa chọn của hai người trộn vào nhau trên cùng một deployment. Timebox 3 ngày dựng, 1 tuần chờ tín hiệu.

## Thước đo thành công → ứng viên criterion

- Số mục cấu hình phải khai lại khi mở trên máy thứ hai
- Thời gian từ lúc mở sản phẩm trên máy mới đến lúc tạo được khóa đầu tiên
- Bản local không đăng nhập vẫn chạy trọn vòng tạo khóa

## Out of scope từ khám phá

- Hệ tài khoản nhiều người dùng có vai trò và phân quyền — vòng này chỉ hỏi cấu hình có đi theo người không, không làm quản trị người dùng.
- Đồng bộ khóa học đã tạo giữa các máy — cùng họ với vấn đề này nhưng là khối dữ liệu khác, vòng khác.
- Thay `ACCESS_CODE` — cổng vào deployment là chuyện khác với danh tính người dùng; hai thứ sống cạnh nhau được.
