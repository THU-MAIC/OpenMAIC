# Điểm quyết định tại Cổng Phạm vi — kê và đếm ngưỡng

Máy kê từ vật cuối S1: entry sổ quyết định chờ seal, dòng `[GIẢ ĐỊNH]` trong
Coverage, finding gap-probe đẩy sang người. Không kê từng tiêu chí — tiêu chí là
bằng chứng của quyết định, không phải quyết định.

| Điểm | Đếm | Hình |
|---|---|---|
| Lối danh tính: mã nhận / đăng nhập thật / một danh tính chung | 3 nhánh rẽ | H1 |
| Luồng mã nhận từ máy A sang máy B | 5 bước nối tiếp | H2 |
| Bỏ danh sách máy đã liên kết và nút gỡ | dưới ngưỡng: 1 nhánh | — |
| Bỏ đưa khoá API lên ngăn máy chủ | dưới ngưỡng: 1 nhánh | — |
| Bỏ design-pass | dưới ngưỡng: 1 nhánh | — |
| [GIẢ ĐỊNH] hạn mã 10 phút | dưới ngưỡng: 1 giá trị | — |
| [GIẢ ĐỊNH] deployment hiện là một người | dưới ngưỡng: 1 giá trị | — |

## Đề bài H1 — ba lối danh tính

- Loại: sơ đồ cây quyết định, ba nhánh từ một câu hỏi gốc.
- Nút: «Máy B phải rơi vào đúng ngăn của máy A — bằng cách nào?» → ba nhánh: «Mã nhận một lần» (đã chọn) · «Đăng nhập thật» (loại) · «Một danh tính chung cho cả deployment» (loại).
- Nhãn bằng chữ cho người: nhánh chọn ghi «giữ được chạy-local, rẻ; đổi lại mã là vé mang được». Nhánh đăng nhập ghi «đúng chuẩn production; đổi lại bắt người tự dựng phải cấu hình đăng nhập». Nhánh chung ghi «rẻ nhất; đâm vào ngưỡng CHẾT: lựa chọn hai người trộn nhau».
- Tiêu chí liên quan: AC-7, AC-11.

## Đề bài H2 — luồng mã nhận

- Loại: sơ đồ luồng ngang, hai làn (máy A, máy B), một khối máy chủ ở giữa.
- Nút: ① máy A xin mã → ② máy chủ trả mã một lần hạn 10 phút → ③ người đọc mã sang máy B → ④ máy B đổi mã, máy chủ cấp lại danh tính chủ sở hữu → ⑤ hai máy đọc chung ngăn account.
- Nhãn bằng chữ: ghi rõ phạm vi theo-máy KHÔNG đi qua đường này.
- Ca hỏng vẽ thành nhánh phụ từ ④: mã sai / hết hạn / đã dùng → cùng một câu từ chối.
- Tiêu chí liên quan: AC-3, AC-4, AC-5, AC-7, AC-8, AC-14.
