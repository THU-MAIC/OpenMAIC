# Lựa chọn của người đi theo người — thiết kế

> Hồ sơ: `_acceptance/cau-hinh-di-theo-nguoi/` · Cổng Đáng ký 2026-09-20, `decision: build`
> Hạng rủi ro: T3 (chạm `lib/persistence/**`, `packages/@openmaic/storage/**`)

## Vấn đề

Người dạy khai lựa chọn trên một máy — giọng đã nhập từ tài khoản nhà cung cấp,
mô hình tự thêm, giọng gán cho từng nhân vật dạy — rồi mở sản phẩm trên máy thứ
hai và thấy trống trơn. Khoá API thì đã đi theo deployment qua đường khai phía
máy chủ; thứ nằm lại là lựa chọn của người.

## Vì sao hôm nay nó nằm lại

Lớp lưu trữ khai hai phạm vi, `device` và `account`, và tự mô tả `account` là
"thứ mà máy thứ hai lẽ ra không phải nghe lại". Nhưng mọi chỗ dựng kho trong app
đều dựng bản chạy trên trình duyệt:

| Mảnh | Trạng thái |
|---|---|
| Hai phạm vi `device` \| `account` | đã có — `packages/@openmaic/storage/src/kv/types.ts:8` |
| Bản kho chạy qua mạng (`HttpKVStore`) | đã viết, **app chưa bao giờ dựng nó** |
| Ngăn `/kv/entries/*`, `/kv/keys` phía máy chủ | **chưa có** — handler chỉ phục vụ `/documents`, `/assets`, `/runtime` |
| Danh tính chủ sở hữu do máy chủ cấp | đã có — cookie `anonymous_id`, 30 ngày, `lib/server/agent-runtime/owner.ts` |
| Chỗ cắm cho đăng nhập | đã có — tham số `authenticatedOwnerId` của `resolveRequestOwnerId()` |
| Đường để máy thứ hai rơi vào cùng ngăn | **chưa có** |

Hai ô trống là toàn bộ việc của vòng này.

## Lối đã chốt: mã nhận

Máy A hiện một mã ngắn, **dùng một lần, hạn ngắn**. Máy B nhập mã; máy chủ đổi
mã lấy đúng danh tính chủ sở hữu của máy A và cấp lại cookie. Từ đó hai máy đọc
chung một ngăn `account`.

Không mật khẩu, không nhà cung cấp đăng nhập, không bảng người dùng. Bản chạy
local không bật lưu trữ phía máy chủ thì hành vi y như trước.

### Vì sao không phải đăng nhập thật

Đúng là thứ `lib/persistence/server-auth.ts` tự khai rằng production cần. Nhưng
nó thêm nhà cung cấp, bảng người dùng và phiên đăng nhập, và bắt người tự dựng
phải cấu hình đăng nhập để dùng thứ trước đây mở là chạy — mất đúng tính chất
local của kho. Lối mã nhận không chặn đường tới nó: cả hai cùng ghi vào tham số
`authenticatedOwnerId` đã có, nên sau này thay cách LẤY danh tính chứ không đụng
tầng lưu trữ.

### Vì sao không phải một danh tính chung cho cả deployment

Rẻ nhất, nhưng đâm thẳng vào ngưỡng CHẾT đã chốt ở Cổng Đáng: lựa chọn của hai
người trộn vào nhau trên cùng một deployment.

## Kiến trúc

```
  MÁY A (đã khai lựa chọn)                    MÁY B (máy mới)
         │                                          │
         │ ① xin mã                                 │ ③ nhập mã
         ▼                                          ▼
  ┌───────────────────────────────────────────────────────────┐
  │  POST /api/claim        ② mã một lần, hạn ngắn            │
  │  POST /api/claim/redeem ④ đổi mã → cấp lại cookie chủ SH  │
  └───────────────────────────┬───────────────────────────────┘
                              │ cùng một chủ sở hữu
                              ▼
  ┌───────────────────────────────────────────────────────────┐
  │  GET/PUT/DELETE /api/persistence/kv/entries/<key>         │
  │  GET            /api/persistence/kv/keys                  │
  │  ngăn chia theo chủ sở hữu — CHỈ phạm vi account          │
  └───────────────────────────┬───────────────────────────────┘
                              ▼
                     bảng kv trong PostgreSQL

  Phạm vi device KHÔNG đi qua đây. Khoá người học ở lại máy —
  một khoá đồng bộ sẽ trộn dữ liệu chạy của hai người vào một ngăn.
```

### Các mảnh

**1. Ngăn KV phía máy chủ** (`packages/@openmaic/storage`) — thêm bộ xử lý cho
`/kv/entries/*` và `/kv/keys` vào handler đã có, cùng một bản lưu PostgreSQL.
Chỉ nhận phạm vi `account`; yêu cầu mang phạm vi `device` bị từ chối tại cổng
vào, không im lặng bỏ qua.

**2. Nối app vào kho chạy qua mạng** (`lib/store/kv-persist.ts`) — khi lưu trữ
phía máy chủ đang bật, dựng `HttpKVStore` với `deviceStore` là bản trình duyệt;
tắt thì giữ nguyên bản trình duyệt như hôm nay. Máy trạng thái sẵn có của file
này đã bắt buộc "đọc lỗi không bao giờ là trống" — giữ nguyên, không nới.

**3. Mã nhận** (`lib/persistence/claim-code.ts` + `app/api/claim/**`) — mã sinh
bằng nguồn ngẫu nhiên mã hoá, lưu bản băm, hạn ngắn, dùng một lần, và có chặn dò
theo cùng nếp đã dùng cho `/api/access-code/verify`.

**4. Màn Cài đặt** — một mục mới trong thanh điều hướng trái đã có.

## Xử lý lỗi

| Tình huống | Sản phẩm làm gì |
|---|---|
| Máy chủ không trả lời khi đọc | Giữ nguyên lựa chọn đang có, báo trạng thái; **không** coi là trống và **không** ghi đè |
| Máy chủ không trả lời khi ghi | Không đánh dấu đã ghi; thử khôi phục một lần theo máy trạng thái sẵn có |
| Mã sai / hết hạn / đã dùng | Một thông điệp, không phân biệt ba ca (không rò rỉ mã nào có thật) |
| Nhập mã dồn dập | Chặn theo nhịp, cùng nếp `/api/access-code/verify` |
| Máy B đã có lựa chọn riêng trước khi nhận | Nói rõ trước khi nhận: lựa chọn trên máy này sẽ bị thay bằng lựa chọn của ngăn kia |

## Kiểm thử

Bộ kiểm chạy mỗi vòng: `pnpm test` và bộ kiểm của gói lưu trữ. Mỗi phép đo mới
sinh kèm cặp hai chiều trên cùng một dữ liệu dựng sẵn — vật lành thì xanh, phá
vật thật trong bản sao thì đỏ kèm thông điệp ghim.

<!-- <<<UX-SPEC-TEMPLATE -->
## Đặc tả UX

### 1. Luồng

- Suôn sẻ: Cài đặt → mục «Máy của tôi» → nút «Lấy mã» → mã + đồng hồ đếm ngược hiện ra (điểm ra: người đọc mã sang máy kia) · trên máy mới: Cài đặt → mục «Máy của tôi» → ô nhập mã → nhận → lựa chọn hiện ra (điểm ra: quay lại việc đang làm)
- Biên: lưu trữ phía máy chủ chưa bật → mục này hiện lời giải thích + đường dẫn tài liệu, không hiện nút; máy mới chưa có lựa chọn nào → nhận xong là có ngay, không cảnh báo ghi đè
- Lỗi & quay lại: mã sai/hết hạn/đã dùng → một dải lỗi nội tuyến trên ô nhập, ô giữ nguyên nội dung để sửa; máy chủ im → trạng thái lỗi kèm nút thử lại, lựa chọn đang dùng không đổi

### 2. Kiểm kê màn

| Màn | MỘT việc của màn | Vào từ / ra tới |
|---|---|---|
| Cài đặt › Máy của tôi | Cho máy khác dùng chung lựa chọn của tôi | Từ thanh điều hướng trái của Cài đặt / ra lại màn đang làm |

### 3. Bảng trạng thái

<!-- <<<UX-STATE-TABLE -->
| Trạng thái | Màn | Hiển thị gì | Người làm gì tiếp |
|---|---|---|---|
| ST-maycuatoi-tat | Máy của tôi | «Lựa chọn đang lưu trên máy này. Bật lưu trữ phía máy chủ để mang sang máy khác.» + đường dẫn tài liệu | Đọc tài liệu, không có nút |
| ST-maycuatoi-san-sang | Máy của tôi | Nút «Lấy mã» + một câu nói mã dùng một lần và hết hạn nhanh | Bấm lấy mã, hoặc nhập mã từ máy khác |
| ST-maycuatoi-co-ma | Máy của tôi | Mã + đồng hồ đếm ngược + nút sao chép | Đọc mã sang máy kia, hoặc để hết hạn |
| ST-maycuatoi-ma-het-han | Máy của tôi | Mã mờ đi + «Mã đã hết hạn» + nút lấy mã mới | Lấy mã mới |
| ST-maycuatoi-dang-nhan | Máy của tôi | Ô nhập khoá lại + chỉ báo đang xử lý | Chờ |
| ST-maycuatoi-nhan-loi | Máy của tôi | Dải lỗi nội tuyến «Mã không dùng được» + ô giữ nguyên nội dung | Sửa mã, hoặc xin mã mới ở máy kia |
| ST-maycuatoi-se-ghi-de | Máy của tôi | Hỏi xác nhận: lựa chọn trên máy này sẽ bị thay | Đồng ý, hoặc hủy |
| ST-maycuatoi-xong | Máy của tôi | «Máy này đã dùng chung lựa chọn của anh» | Quay lại việc đang làm |
| ST-maycuatoi-may-chu-im | Máy của tôi | Trạng thái lỗi + nút thử lại; lựa chọn đang dùng KHÔNG đổi | Thử lại, hoặc bỏ qua |
<!-- UX-STATE-TABLE>>> -->

### 4. Hành vi

- Mã không phân biệt hoa thường, bỏ qua khoảng trắng và gạch nối khi người dán vào
- Đồng hồ đếm ngược chạy phía trình duyệt; hết giờ thì máy chủ vẫn là bên quyết, trình duyệt chỉ hiển thị
- Mọi chuỗi mới phải có mục trong cả 12 tệp ngôn ngữ của kho
- Ô nhập mã nhận phím Enter; sau khi nhận xong, tiêu điểm về đầu mục

### 5. Xuất xứ component

| Component | Nấc (dùng / ghép / mở rộng / tạo) | Vì sao (1 dòng) |
|---|---|---|
| `Input`, `Button`, `Alert` | dùng | Đã có trong bộ nền của kho |
| Thanh điều hướng Cài đặt | mở rộng | Thêm một mục vào danh sách mục đã có |
| Mục «Máy của tôi» | tạo | Chưa có màn nào làm việc này |
| Ô mã chia ký tự | KHÔNG tạo | Mẫu thị trường có, nhưng một ô nhập thường là đủ — không dựng thêm ở vòng này |

### 6. Khuôn IA đã chọn + căn cứ

Khuôn IA: danh-sách-chi-tiết (master-detail)
Căn cứ: tra mẫu thị trường (Mobbin, luồng liên kết thiết bị trên web) — Grok đặt «Add device» trong Cài đặt › Security theo lối danh sách trái + khung chi tiết, Paramount+ dành một khung riêng cho ô nhập mã với dải lỗi nội tuyến phía trên. Rút: mục mới nằm trong thanh điều hướng Cài đặt đã có, lỗi báo nội tuyến ngay trên ô nhập chứ không bằng hộp thoại. Khuôn này cũng chính là khuôn màn Cài đặt của kho đang chạy (`components/settings/index.tsx` — danh sách mục trái, khung chi tiết phải), nên không đưa lối trình bày lạ vào sản phẩm.
<!-- UX-SPEC-TEMPLATE>>> -->
