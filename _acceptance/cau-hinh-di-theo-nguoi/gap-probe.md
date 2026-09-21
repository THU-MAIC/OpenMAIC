---
slug: cau-hinh-di-theo-nguoi
at: 2026-09-20T09:50:00Z
verdict: findings
p0: 2
p1: 3
p2: 0
---

## Findings

| Sev | Artifact | Thiếu gì | Kịch bản fail | Thước đo | Xử lý |
|---|---|---|---|---|---|
| P0 | evals | Không chốt danh sách khoá phạm vi account; E1/E2 chỉ chạm một khoá | Bên nối đồng bộ vài khoá, bỏ sót giọng gán cho nhân vật và hồ sơ. E1/E2 vẫn xanh. Máy thứ hai thiếu từ hai mục trở lên — đúng ngưỡng CHẾT — mà không phép đo nào đỏ | Số assert bằng số kho khai phạm vi account, danh sách rút từ chính khai báo | fixed: AC-2 đòi TOÀN tập rút từ khai báo; E2 thành ma trận toàn phần, hai chiều đỏ; Notes chốt cách rút danh sách |
| P0 | contract | Ca «máy B đã có dữ liệu» chỉ có AC-12 (judgment, chấm chữ trong lời hỏi); không AC nào đo KẾT QUẢ sau khi đồng ý thay | Cookie đổi đúng nhưng trạng thái trong bộ nhớ còn cũ. Màn hiện «đã dùng chung», khung chụp xanh, người tạo khóa ngay sau đó vẫn ra giọng cũ — trượt ngưỡng SỐNG | AC cross-layer đo ở lớp hiệu ứng: so bằng giá trị, không so câu thông báo | fixed: thêm AC-14 + E15 (backend-effect), chiều đỏ là bỏ bước nạp lại sau đổi mã |
| P1 | evals | E13 phủ 6/9 dòng bảng trạng thái, trong khi AC-13 nêu đích danh ca lỗi và ca hết hạn | Mã hết hạn mà màn vẫn hiện mã; người đọc mã chết sang máy kia. E13 vẫn xanh vì sáu khung đã khai đều có. Lỗ này làm mỏng chính vật bù cho quyết định bỏ design-pass | Số khung bằng số dòng bảng trạng thái, danh sách rút từ chính bảng | fixed: E13 lên 9 khung, expected buộc số khung = số dòng, chiều đỏ khi có dòng không có khung; AC-13 viết lại theo «mọi dòng» |
| P1 | contract | Trục C khai máy chủ lỗi nhưng chỉ có AC-10 cho chiều ĐỌC; chiều GHI hỏng có dòng trong bảng Xử lý lỗi mà không AC nào chạm | Ghi hỏng lúc mạng chập, app coi như đã lưu, không báo gì. Mọi eval xanh. Máy thứ hai thấy trống — mất im lặng nguy hơn trống trơn | AC cho ghi hỏng, đo ở lớp hiệu ứng; chiều đỏ là cho bên ghi nuốt lỗi | fixed: thêm AC-15 + E16 (backend-effect) |
| P1 | contract | AC-3/E3 đo hạn mã bằng chính con số cấu hình tự khai — phép đo tự soi; con số còn treo ở mục giả định | Bên dựng khai hạn 24 giờ cho tiện; E3 vẫn xanh. Mà sổ quyết định dựa vào «hạn ngắn» để bỏ đường thu hồi — một mã lọt ra sống trọn ngày | Ghi con số vào contract, đo hai vế quanh mốc, thêm assert cận trên | fixed: AC-3 chốt mốc 10 phút + cấm cấu hình khai dài hơn; E3 lên ba vế, chiều đỏ là nới hạn lên 24 giờ |

Một lượt, không quét lại (phần code còn ba vòng ở bước nghiệm thu máy).
