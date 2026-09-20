---
schema_version: 1
feature: Lựa chọn của người đi theo người, không nằm lại trên máy
slug: cau-hinh-di-theo-nguoi
owner: phanlemanh@gmail.com
risk_tier: T3
surfaces: [api, ui]
status: approved
design_doc: _acceptance/cau-hinh-di-theo-nguoi/design.md
approved_by: Manh Phan
approved_at: 2026-09-20
---

# Acceptance Contract: cau-hinh-di-theo-nguoi

## Context

Người dạy khai lựa chọn trên một máy — giọng đã nhập từ tài khoản nhà cung cấp,
mô hình tự thêm, giọng gán cho từng nhân vật dạy — rồi mở sản phẩm trên máy thứ
hai và thấy trống trơn. Vòng này đưa các lựa chọn phạm vi `account` lên một ngăn
phía máy chủ chia theo chủ sở hữu, và thêm một **mã nhận** dùng một lần để máy
thứ hai rơi vào đúng ngăn của máy thứ nhất. Khoá API không thuộc vòng này: nó đã
đi theo deployment qua đường khai phía máy chủ.

Source input: `_acceptance/cau-hinh-di-theo-nguoi/opportunity.md` (Cổng Đáng ký 2026-09-20)

## Criteria

- AC-1: Given lưu trữ phía máy chủ đang bật, When người đổi một lựa chọn phạm vi `account`, Then giá trị mới nằm trong ngăn phía máy chủ và một yêu cầu đọc mới trả về đúng giá trị đó. (cross-layer)
- AC-2: Given máy A đã ghi lựa chọn và máy B là phiên mới của cùng một chủ sở hữu, When máy B nạp Cài đặt, Then máy B hiện đúng **toàn bộ** tập khoá phạm vi `account` mà máy A đã ghi — không phải một phần — và tập đó rút từ chính khai báo phạm vi của các kho, không chép tay. (cross-layer)
- AC-3: Given người ở máy A xin một mã nhận, When máy chủ trả mã, Then mã đó chỉ dùng được một lần, còn hiệu lực trước mốc **10 phút** và hết hiệu lực sau mốc đó; và cấu hình KHÔNG được khai hạn dài hơn 10 phút — khai dài hơn là một lỗi kêu to, không phải một lựa chọn.
- AC-4: Given một mã nhận đã được dùng, When có người nhập lại chính mã đó, Then yêu cầu bị từ chối và không danh tính nào thay đổi.
- AC-5: Given một mã nhận đã quá hạn, When có người nhập nó, Then yêu cầu bị từ chối với CÙNG một thông điệp như mã sai — sản phẩm không phân biệt ba ca sai/hết hạn/đã dùng.
- AC-6: Given có người nhập mã sai liên tiếp, When số lần vượt nhịp đã khai, Then các lần tiếp theo bị chặn thay vì được thử tiếp.
- AC-7: Given máy B nhập một mã nhận còn hiệu lực, When máy chủ đổi mã, Then máy B nhận đúng danh tính chủ sở hữu của máy A và từ đó đọc chung một ngăn `account`. (cross-layer)
- AC-8: Given một khoá thuộc phạm vi `device`, When có yêu cầu mang phạm vi `device` gửi tới ngăn phía máy chủ, Then ngăn từ chối yêu cầu đó — dữ liệu theo máy không bao giờ rời máy.
- AC-9: Given lưu trữ phía máy chủ KHÔNG bật, When người dùng sản phẩm như thường, Then mọi lựa chọn vẫn lưu và đọc được đúng như trước vòng này, và mục «Máy của tôi» nói rõ tính năng đang tắt.
- AC-10: Given máy chủ không trả lời khi đọc ngăn `account`, When app nạp lựa chọn, Then lựa chọn đang có không bị hiểu thành trống và không bị ghi đè bằng giá trị mặc định.
- AC-11: Given hai chủ sở hữu khác nhau trên cùng một deployment, When mỗi người đọc ngăn `account` của mình, Then không ai đọc được lựa chọn của người kia. (cross-layer)
- AC-12: Given máy B đã có lựa chọn riêng, When người nhập mã để nhận, Then sản phẩm hỏi xác nhận TRƯỚC khi thay, và lời hỏi nói đúng PHẠM VI bị thay — những lựa chọn máy kia có sẽ thay lựa chọn tương ứng ở máy này, còn thứ máy kia chưa từng đặt thì không hứa là sẽ thay. (judgment)
- AC-14: Given máy B đã có lựa chọn riêng và người đã đồng ý thay, When việc đổi mã xong, Then máy B đọc ra ĐÚNG các giá trị máy A đã ghi — so bằng chính giá trị, không so câu thông báo trên màn. (cross-layer)
- AC-15: Given máy chủ không nhận được lời ghi, When app ghi một lựa chọn phạm vi `account`, Then lựa chọn đó KHÔNG được đánh dấu là đã lưu, người thấy trạng thái lỗi, và lần đọc kế tiếp không trả về giá trị chưa tới máy chủ. (cross-layer)
- AC-16: Given máy kia chưa từng lưu một loại lựa chọn nào đó, When máy này nhận, Then loại lựa chọn ấy giữ nguyên giá trị của máy này, và sản phẩm không tuyên bố nó đã bị thay. (cross-layer)
- AC-13: Given mục «Máy của tôi» trên màn Cài đặt, When người đi qua luồng lấy mã rồi luồng nhập mã, Then **mọi** dòng trong bảng trạng thái của đặc tả UX đều có một khung chụp tương ứng — số khung bằng số dòng, dòng nào thiếu khung là đỏ.

## Coverage

Quét bằng `morphological-scan`, preset ma trận kiểm thử. Bốn trục, quét theo cặp
(không gian đầy đủ 96 ô, vượt ngưỡng liệt kê toàn phần).

- Trục A — giai đoạn vòng đời lựa chọn: ghi | mang | đọc | hết hiệu lực [thước CE: hợp đồng phạm vi KV của kho, `packages/@openmaic/storage/src/kv/types.ts`; luồng liên kết thiết bị của bốn sản phẩm có tên ở dưới]
- Trục B — phạm vi dữ liệu: theo-người (`account`) | theo-máy (`device`) [thước CE: `KVScope` khai đúng hai giá trị — `packages/@openmaic/storage/src/kv/types.ts:8`]
- Trục C — trạng thái nền: máy chủ bật | local thuần | máy chủ lỗi/mất mạng | hai phía đều đã có dữ liệu [thước CE: máy trạng thái của `lib/store/kv-persist.ts` đã khai «đọc lỗi không bao giờ là trống»]
- Trục D — ai đang gõ: chủ sở hữu | người thứ hai trên cùng deployment | kẻ dò mã [thước CE: ngưỡng CHẾT đã chốt ở Cổng Đáng; nhịp chặn sẵn có ở `app/api/access-code/verify`]

Chân ngành đối chiếu (bốn sản phẩm có tên, cùng loại «liên kết máy mới bằng mã một lần»):
[NGÀNH: Jellyfin Quick Connect] · [NGÀNH: Plex claim token] · [NGÀNH: Signal/WhatsApp linked devices] · [NGÀNH: Tailscale auth keys] · và mẫu web tra tại Mobbin (Grok «Add device», Paramount+ activation code).
Rút ra bốn điều kiện nền mà đề bài gốc không nêu: mã phải hết hạn · mã dùng một lần · chống dò · một thông điệp chung cho mọi ca hỏng. Cả bốn đã thành AC-3 đến AC-6.

Điểm cần anh gạch tại cổng:
- [MỞ LẠI 20/09] Vòng nghiệm thu thứ tư hỏi một câu hợp đồng chưa trả lời: khi máy kia CHƯA TỪNG đặt một loại lựa chọn, «thay» nghĩa là gì. Hai lối dẫn tới hai sản phẩm khác nhau — giữ nguyên thứ của máy này (đề xuất, đã viết thành AC-12 và AC-16 ở trên), hay coi trống cũng là một giá trị và xoá thứ của máy này. Máy khuyên lối thứ nhất, máy không chốt.
- [GIẢ ĐỊNH] Hạn của mã đã ghi thành 10 phút trong AC-3 để phép đo thôi tự soi chính cấu hình (ngành: Plex ~4 phút, Jellyfin vài phút). Con số vẫn là lựa chọn của anh — đổi nó là đổi AC-3.
- [GIẢ ĐỊNH] Deployment thật của anh hiện là một người dùng. Trục D vẫn giữ ca «người thứ hai» vì ngưỡng CHẾT đã khai đòi nó.

## Đường đo

- Thước: số mục lựa chọn phải khai lại khi mở trên máy thứ hai · số từ: đếm trực tiếp trong phiên nghiệm thu, không phải bộ đếm trong sản phẩm · bảo đảm bởi: AC-2
- Thước: thời gian từ lúc mở sản phẩm trên máy mới đến lúc tạo được khóa đầu tiên · số từ: bấm giờ trong phiên nghiệm thu · bảo đảm bởi: AC-2, AC-7
- Thước: bản local không bật gì vẫn chạy trọn vòng tạo khóa · số từ: quan sát trong phiên nghiệm thu · bảo đảm bởi: AC-9
- Thước: lựa chọn của hai người có trộn vào nhau không · số từ: quan sát trong phiên nghiệm thu · bảo đảm bởi: AC-11

## Out of scope

- Hệ tài khoản nhiều người dùng có vai trò và phân quyền — vòng này chỉ đưa lựa chọn đi theo người.
- Đăng nhập bằng mật khẩu hoặc nhà cung cấp OAuth — đã loại ở buổi thiết kế; nó làm hỏng tính chất chạy-local-không-cần-đăng-nhập.
- Một danh tính dùng chung cho cả deployment — đâm vào ngưỡng CHẾT đã chốt ở Cổng Đáng.
- Danh sách máy đã liên kết và nút gỡ liên kết — ngành có (Signal, WhatsApp, Grok), vòng này chưa làm; nó là đường thu hồi khi lộ mã.
- Đồng bộ khóa học đã tạo giữa các máy — khối dữ liệu khác, vòng khác.
- Gộp dữ liệu người học ẩn danh vào danh tính (`mergeLearner`) — đó là dữ liệu chạy của người học, không phải lựa chọn của người dạy.
- Đưa khoá API từ trình duyệt lên ngăn phía máy chủ — khoá đã có đường khai phía máy chủ; đẩy bí mật lên một ngăn nữa là thêm bề mặt rủi ro không cần.
- Mã QR thay cho gõ tay — tiện hơn, không đổi bản chất; để vòng sau.

## Notes

- Hạng T3: vòng chạm `lib/persistence/**`, `packages/@openmaic/storage/**`, và thêm đường API mới dưới `app/api/`.
- Ngăn phía máy chủ chỉ phục vụ phạm vi `account`. Phạm vi `device` bị từ chối tại cổng vào, không im lặng bỏ qua (AC-8).
- Tập khoá phạm vi `account` = đúng những kho khai `'account'` khi dựng lớp lưu bền (hôm nay: kho cấu hình và kho hồ sơ người dùng). Phép đo phải RÚT tập này từ chính khai báo đó; chép tay một danh sách là cách bỏ sót mà không ai đỏ.
- Mọi chuỗi mới phải có mục trong cả 12 tệp ngôn ngữ (`lib/i18n/locales/`).
- Mã nhận sinh bằng nguồn ngẫu nhiên mã hoá và lưu ở dạng băm; nhịp chặn đi theo nếp đã có ở `app/api/access-code/verify`.
- Lối mã nhận ghi vào tham số `authenticatedOwnerId` đã có sẵn của `resolveRequestOwnerId()`, nên một hệ đăng nhập thật sau này thay cách LẤY danh tính chứ không phải sửa tầng lưu trữ.
