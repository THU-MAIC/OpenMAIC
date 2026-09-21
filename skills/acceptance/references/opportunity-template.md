# Opportunity — khuôn D1b (điền xong mới tới red-team D2; Cổng 0 ký trên file này)

> Bản mẫu rút từ vòng V1 thật (trang-tu-van-v2, artifact-platform, 27-28/07/2026)
> — mọi section dưới đây đều đã được dùng thật ít nhất một lần trong vòng đó.
> Vị trí khi dùng: `_acceptance/<slug>/opportunity.md` của repo sản phẩm.
> Frontmatter là phần MÁY ĐỌC (card/funnel Cổng 0 sẽ đọc) — giữ nguyên tên key,
> chỉ thay giá trị. Xoá các dòng hướng dẫn `>` khi dùng thật.

**ĐỪNG chép hai dòng chú thích `<!-- … -->` và hàng rào ```` ```yaml ```` quanh
frontmatter.** Chúng ở đó để test rút được đúng khuôn máy-đọc (case P115 cho nó
đi vòng qua chính bộ đọc mà các cổng dùng); `opportunity.md` thật phải BẮT ĐẦU
ngay ở dòng `---`. Chép cả hàng rào thì dòng đầu file là ```` ```yaml ````, mọi
bên đọc coi đây là hồ sơ hỏng và slug rơi xuống mục "Hồ sơ hỏng".

<!-- <<<OPP-FRONTMATTER-TEMPLATE -->
```yaml
---
schema_version: 1
slug: {slug}
feature: {feature}
owner: {owner}
stage: {stage}              # discovery | decided | archived
decision: {decision}        # build | iterate | park | kill — người ký Cổng 0 điền
decided_by: {decided_by}
decided_at: {decided_at}    # ISO UTC
prototype:
  base_commit: {base_commit}    # điểm cắt nhánh proto khỏi nhánh chính — guard diffBase khi keep
  disposition: {disposition}    # keep | archive
---
```
<!-- OPP-FRONTMATTER-TEMPLATE>>> -->

## Vấn đề & ai gặp

> Ai đang đau, đau ở khâu nào của vòng, bằng chứng thực địa nào (ngày + nguồn).
> Nêu cả vật liệu nền (spec/PRD/gói thiết kế cũ) — nhưng vật liệu NGOÀI repo thì
> khai tiếp ở section "Nguồn ngoài & phạm vi kế thừa", không vào nguyên khối ở đây.

## Giả định chốt sinh tử

> Xếp hạng, re-rank sau red-team D2 (giữ vết re-rank). Trạng thái cập nhật khi
> có phép thử; ưu tiên phép thử KHÔNG cần dựng (D2.5) trước, rẻ → đắt.

| # | Giả định | Nếu sai thì | Phép thử rẻ nhất | Trạng thái |
|---|---|---|---|---|
| 1 | … | … | … | Chưa thử |

## Ngưỡng chết / ngưỡng UAT

> Mô hình đo-tại-UAT (quyết 28/07): ngưỡng KHAI tại Cổng 0, ĐO tại phiên UAT
> trên sản phẩm thật sau flag; prototype chỉ hội tụ ý định, không gánh phép đo.
> Nếu phép đo đổi giữa chừng: ghi `[SUPERSEDED <ngày> — <phép đo mới>]` tường
> minh và GIỮ bản gốc bên dưới làm sử liệu — không xoá ngưỡng đã khai.
> Hai đồng hồ của prototype: giờ-dựng (quá timebox = đang build sản phẩm) và
> giờ-chờ-tín-hiệu (số không về sau timebox tự nó là tín hiệu).

> Máy ĐƯỢC đề xuất ngưỡng khi kết buổi khai thác — mỗi bullet mang tiền tố `[đề xuất]`
> ngay sau dấu `:`; người ký Cổng Đáng gỡ tiền tố = chốt. Ý còn mờ thật thì giữ `…`.
> Vòng KHÔNG có người dùng cuối (việc nội bộ của bộ công cụ) → thay các bullet bằng MỘT
> dòng `Không đo được — <lý do>`, khai TẠI Cổng Đáng; viết trần hay dạng bullet
> (`- Không đo được — <lý do>`) đều được nhận — «Không đo được:» (hai chấm) thì KHÔNG.
> Khai sau khi đã làm xong là mọi kết
> quả tự biện minh — đó là đường lách, không phải lối ra.
> Hai tiền tố là CHUỖI MÁY ĐỌC, bản gốc ở mục «Ký hiệu máy đọc» cuối file.

- Câu hỏi phép đo trả lời: …
- Kết quả nào là SỐNG: …
- Kết quả nào là CHẾT: …
- Timebox: …

## Kết quả prototype

> Dựng trong/ngoài timebox · verify local · số so ngưỡng (hoặc lý do KHÔNG ĐO,
> ghi tường minh — không đo mà im lặng là gian).

## Nguồn ngoài & phạm vi kế thừa

> Lưới B1 (retro V1): vật liệu ngoài vào không phân loại là mắt xích đầu của
> chuỗi drift 7 bước. Liệt kê TỪNG món vật liệu ngoài repo (gói spec, prototype
> cũ, design system khác, code mẫu, tài liệu đối thủ…), phân loại từng món:
> - **triết-lý/logic** — engine, luật nghiệp vụ, ngưỡng, thuật toán: kế thừa được.
> - **ngôn-ngữ-thiết-kế/hình-thái** — layout, DNA thị giác, khuôn tương tác,
>   giọng component: mặc định **KHÔNG** kế thừa — chuẩn của repo tiêu thụ THẮNG.
>   Muốn kế thừa hình thái: khai đích danh vào bảng + người ký tại Cổng 0.
> Luật răng: không phân loại = chưa đủ điều kiện ký Cổng 0.

| Món vật liệu | Nguồn (đường dẫn/tên gói) | Phân loại | Kế thừa? | Người ký |
|---|---|---|---|---|
| … | … | triết-lý/logic hoặc ngôn-ngữ-thiết-kế/hình-thái | có/không | (chỉ bắt buộc khi kế thừa hình thái) |

## Cổng 0

> Hai câu hỏi, hai key frontmatter: số phận CƠ HỘI → `decision`
> (build/iterate/park/kill) · số phận CODE prototype → `prototype.disposition`
> (keep/archive). Ký = điền `decided_by`/`decided_at`.
> Ngưỡng UAT chốt CÙNG LÚC ký (chép từ section Ngưỡng, tinh chỉnh lần cuối).
> `disposition: keep` → BẮT BUỘC điền Bảng nợ kế thừa + 3 guard (diffBase =
> `prototype.base_commit` · baseline bắt buộc · branch cắt từ nhánh chính).

- **decision = …** Căn cứ: …
- **disposition = …** Căn cứ: …
- **Ngưỡng UAT chốt cùng lúc ký:** …

## Thước đo thành công → ứng viên criterion

> Đo-sau-ship. Mỗi thước phải truy được thành AC của contract ở S1 (DP-1 đo
> đúng tỷ lệ này); thước không truy được = thước trang trí.

- …

## Bảng nợ kế thừa (CHỈ khi disposition: keep)

| Path | Giữ / Dựng lại | Chạm t3_paths? | Ghi chú |
|---|---|---|---|

## Out of scope từ khám phá

> ≥2 bullet. Nhánh-đã-bác ghi kèm lý do 1 dòng — để khỏi bàn lại; những bullet
> này chép sang contract ở S1, mất bullet nào phải có giải trình.

- …
- …

## Ký hiệu máy đọc (đừng xoá, đừng chép vào hồ sơ thật)

> Hai chuỗi dưới đây là bản gốc DUY NHẤT; bộ quét, thẻ, `/approve` và phiên nghiệm thu rút
> từ đây lúc chạy. Đổi chuỗi ở một phía là phép đo round-trip đỏ. Mục này nằm NGOÀI mọi
> section dữ liệu của ô — đặt nó trong section Ngưỡng thì khuôn trắng trông như đã khai.

<!-- <<<OPP-DE-XUAT-PREFIX -->
[đề xuất]
<!-- OPP-DE-XUAT-PREFIX>>> -->

<!-- <<<OPP-KHONG-DO-DUOC-PREFIX -->
Không đo được —
<!-- OPP-KHONG-DO-DUOC-PREFIX>>> -->
