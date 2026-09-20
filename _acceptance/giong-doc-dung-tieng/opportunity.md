---
schema_version: 1
slug: giong-doc-dung-tieng
feature: Giọng đọc phải nói được thứ tiếng của khóa học
owner: Manh Phan
stage: discovery
decision:
decided_by:
decided_at:
prototype:
  base_commit:
  disposition:
---

## Vấn đề & ai gặp

Người dạy một khóa không phải tiếng Anh chọn một giọng đọc, bấm tạo khóa, rồi
nghe narration đọc sai tiếng — hoặc một giọng tiếng Anh cố đọc chữ Việt, hoặc
im lặng. Sản phẩm không bao giờ nói trước cho họ biết giọng vừa chọn không đọc
được thứ tiếng họ đang dạy; họ chỉ phát hiện sau khi cả khóa đã dựng xong.

Đây là vết thương lặp lại, không phải một ca lẻ. Ba lần vá ở ba nhà cung cấp
khác nhau, cùng một gốc:

- 20/09/2026 — ElevenLabs không dùng được cho tiếng Việt: model mặc định không
  có tiếng Việt, người dùng không đổi được model, danh sách giọng là sáu giọng
  tiếng Anh. Người dạy không nhận được cảnh báo nào; giọng toàn cục âm thầm ở
  lại một preset tiếng Anh (commit `fe992625`).
- Azure phải suy locale SSML từ giọng đã chọn (#1566).
- Giọng đọc sẵn của trình duyệt phải tự đoán ra tiếng Việt (#1487).

Gốc chung, đọc được trong code: mỗi giọng preset đều khai trường `language`,
nhưng không chỗ nào đối chiếu nó với tiếng của khóa học. Trường đó hiện chỉ có
đúng một người đọc, là Azure, và đọc để dựng locale SSML chứ không để cảnh báo
(`lib/audio/tts-providers.ts:827`). Sâu hơn: tiếng của khóa học không tồn tại
dưới dạng dữ liệu — nó chỉ là một câu chỉ thị bằng tiếng tự nhiên nhét trong
prompt (`lib/pbl/v2/agents/planner.ts:133`), nên bên chọn giọng không có gì để
so.

## Giả định chốt sinh tử

| # | Giả định | Nếu sai thì | Phép thử rẻ nhất | Trạng thái |
|---|---|---|---|---|
| 1 | Biết được tiếng của khóa dưới dạng dữ liệu máy đọc | Không có gì để đối chiếu; phải đoán từ nội dung hoặc bắt người dạy tự khai | Đọc 10 outline thật, xem chỉ thị ngôn ngữ có ổn định và rút ra được không | Chưa thử |
| 2 | Mỗi giọng khai đúng thứ tiếng nó nói được | Cảnh báo báo sai, người dạy tắt cảnh báo và mất luôn tác dụng | Nhập 20 giọng từ tài khoản ElevenLabs, đếm bao nhiêu giọng có khai tiếng | **Đã thử 20/09 — SAI.** Giọng nhập từ tài khoản vào hệ thống với thứ tiếng ghi cứng là `auto`, không giọng nào khai tiếng thật (`lib/audio/voice-resolver.ts:219`). Muốn cảnh báo thì phải lấy tiếng từ nơi khác. |
| 3 | Người dạy muốn được cảnh báo, không muốn máy tự đổi giọng giúp | Nên tự chọn giọng hợp tiếng rồi báo sau, thay vì chặn lại hỏi | Hỏi 3 người dạy đang dùng thật | Chưa thử |

## Ngưỡng chết / ngưỡng UAT

- Câu hỏi phép đo trả lời: Người dạy một khóa không phải tiếng Anh có nghe được narration đúng tiếng của khóa ngay ở lần tạo đầu tiên, mà không phải mở Cài đặt sửa gì không?
- Kết quả nào là SỐNG: [đề xuất] 4/5 người dạy thử tạo một khóa bằng tiếng mẹ đẻ của họ nghe đúng tiếng đó ở lần chạy đầu, và không ai phải vào Cài đặt trước khi tạo
- Kết quả nào là CHẾT: [đề xuất] từ 2/5 trở lên vẫn ra narration sai tiếng mà không nhận được cảnh báo nào trước lúc tạo
- Timebox: [đề xuất] 3 ngày dựng, 1 tuần chờ tín hiệu

## Kết quả prototype

Chưa dựng.

## Nguồn ngoài & phạm vi kế thừa

Không có vật liệu ngoài repo. Mọi bằng chứng ở trên rút từ chính lịch sử và mã
nguồn của kho này.

| Món vật liệu | Nguồn (đường dẫn/tên gói) | Phân loại | Kế thừa? | Người ký |
|---|---|---|---|---|
| (không có) | — | — | — | — |

## Cổng Đáng

- **decision = …** Căn cứ: …
- **disposition = …** Căn cứ: …
- **Ngưỡng UAT chốt cùng lúc ký:** …

## Thước đo thành công → ứng viên criterion

- Tỷ lệ khóa không-tiếng-Anh có narration đúng tiếng ở lần dựng đầu
- Số lần người dạy phải quay lại Cài đặt đổi giọng sau khi đã dựng xong một khóa

## Out of scope từ khám phá

- Chất lượng phát âm hay ngữ điệu của giọng — vòng này hỏi giọng có nói ĐÚNG TIẾNG không, không hỏi nói có HAY không.
- Thêm nhà cung cấp giọng đọc mới — vấn đề nằm ở chỗ không đối chiếu, không nằm ở thiếu giọng.
- Nhận giọng nói vào (ASR) — cùng chữ "tiếng" nhưng là bề mặt khác, vòng khác.
