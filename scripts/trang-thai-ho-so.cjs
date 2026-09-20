// trang-thai-ho-so.cjs — MỘT bảng chữ cho mọi bộ đọc mặt người.
//
// Vì sao ở scripts/ chứ không lib/: `lib/**` là `risk_tiers.t3_paths` vì nó là
// LÕI CƯỠNG CHẾ — bug ở đó sinh màu xanh giả trên mọi repo tiêu thụ. Một bảng
// chữ hỏng chỉ cho CHỮ SAI trên thẻ, không cho MÀU XANH GIẢ. Đặt vào lib/ nâng
// hồ sơ này lên T3 = thêm một chốt kế hoạch + một chữ ký bắt buộc, cho đúng cái
// hồ sơ sinh ra để giảm số lượt gọi người (ledger d-20260823T012029Z-27499).
// Tiền lệ cùng lý do: scripts/khong-can-nguoi.mjs.
//
// KHÔNG trùng vai `MAP_LABELS` trong lib/workspace-record.cjs: bảng kia là
// trạng thái của FILE bản đồ, bảng này là trạng thái của HỒ SƠ — hai trục khác
// nhau, không có gì phải giữ đồng bộ.
//
// File này THUẦN DỮ LIỆU: không đọc file, không phán trạng thái. Bộ PHÂN Ô duy
// nhất là scripts/start-scan.mjs; ai cần trạng thái thì HỎI NÓ, đừng dựng lại —
// dựng lại là bản thứ ba của lớp lỗi lan-v-khong-phai-cho-ky đã trả giá.
'use strict';

const TRANG_THAI = {
  'y-can-nhac':               { nhan: 'đang cân nhắc',                      viecKe: 'người: điền ngưỡng thì mới có gì để ký' },
  'cho-cong-dang':            { nhan: 'chờ chữ ký — Cổng Đáng',             viecKe: 'người: quyết có làm việc này không' },
  'sap-mo-vong':              { nhan: 'sắp mở vòng',                        viecKe: 'máy: chốt thiết kế và bộ tiêu chí' },
  'xep-lai':                  { nhan: 'xếp lại sau',                        viecKe: 'không ai — đã quyết để lại' },
  'da-bac':                   { nhan: 'đã bác từ khám phá',                 viecKe: 'không ai — đã quyết không làm' },
  'cho-cong-pham-vi':         { nhan: 'chờ chữ ký — Cổng Phạm vi',          viecKe: 'người: duyệt bộ tiêu chí trước khi code' },
  'dang-lap-ke-hoach':        { nhan: 'đang lập kế hoạch',                  viecKe: 'máy: lập kế hoạch thi công' },
  'dang-viet-code':           { nhan: 'đang viết code',                     viecKe: 'máy: viết code theo kế hoạch' },
  'vat-da-o-nhanh-goc':       { nhan: 'vật đã nằm trong nhánh gốc — hồ sơ còn treo ở «đã duyệt»',
                                viecKe: 'người: chọn một lối — đóng theo quan sát (ghi quyết định, không chấm lại) hoặc chấm lại (đưa về «code xong», chạy nghiệm thu máy)' },
  'cho-nghiem-thu-may':       { nhan: 'code xong, chưa ai chấm',            viecKe: 'máy: chạy vòng nghiệm thu' },
  'dang-sua-theo-bang-chung': { nhan: 'đang sửa theo bằng chứng',           viecKe: 'máy: sửa rồi chấm vòng mới' },
  'nghiem-thu-bi-chan':       { nhan: 'nghiệm thu bị chặn',                 viecKe: 'máy: khắc phục nguyên nhân kẹt rồi chạy lại' },
  'cho-cong-bang-chung':      { nhan: 'chờ chữ ký — Cổng Bằng chứng',       viecKe: 'người: đọc bằng chứng rồi ký' },
  'may-di-tiep-veto-mo':      { nhan: 'máy đi tiếp — cửa veto còn mở',      viecKe: 'người: veto lúc nào cũng được, cửa không có hạn' },
  'may-di-tiep-xanh-sach':    { nhan: 'máy đi tiếp — bằng chứng xanh-sạch', viecKe: 'không ai — người đã duyệt hoặc miễn Cổng Phạm vi' },
  'da-giao':                  { nhan: 'đã giao',                            viecKe: 'không ai — vòng đã đóng' },
  'da-giao-may-thong-veto-mo':   { nhan: 'đã giao — máy thông, cửa veto còn mở',      viecKe: 'người: veto lúc nào cũng được, cửa không có hạn' },
  'da-giao-may-thong-xanh-sach': { nhan: 'đã giao — máy thông, bằng chứng xanh-sạch', viecKe: 'không ai — người đã duyệt hoặc miễn Cổng Phạm vi' },
  'da-giao-khong-do':            { nhan: 'đã giao — không đo, khai ở Cổng Đáng',      viecKe: 'không ai — vòng đóng theo lời khai, không có phiên nghiệm thu' },
  'da-dong-ho-so':               { nhan: 'đã đóng có hồ sơ',                          viecKe: 'không ai — đã quyết dừng, hồ sơ giữ lại' },
  'cho-cong-gia-tri':         { nhan: 'chờ chữ ký — Cổng Giá trị',          viecKe: 'người: xem số thật từ phiên nghiệm thu rồi quyết' },
  'da-nghiem-thu-release':    { nhan: 'đã nghiệm thu — giao rộng',          viecKe: 'không ai — vòng đã đóng' },
  'da-nghiem-thu-iterate':    { nhan: 'đã nghiệm thu — lặp thêm',           viecKe: 'người: mở vòng kế' },
  'da-nghiem-thu-kill':       { nhan: 'đã nghiệm thu — dừng',               viecKe: 'không ai — đã quyết dừng' },
  'ho-so-hong':               { nhan: 'hồ sơ đọc không được',               viecKe: 'người: sửa hồ sơ rồi quét lại' },
};

// Phép chiếu NHIỀU-VỀ-MỘT sang ô của bản đồ sản phẩm. Bản đồ cố ý KHÔNG mang vị
// từ (đã quyết; known-limit lan-v-khong-phai-cho-ky) — nó gom theo GIAI ĐOẠN.
// Chiếu ở đây là cách hai bên hết trôi mà bản đồ vẫn giữ nguyên vai cũ: đổi
// đường ĐI TỚI ô, không đổi TÊN ô.
const BUCKET_OF = {
  'y-can-nhac': 'can-nhac',                 'cho-cong-dang': 'can-nhac',
  'sap-mo-vong': 'sap-mo',                  'xep-lai': 'xep-lai',
  'da-bac': 'da-bac',                       'cho-cong-pham-vi': 'cho-duyet',
  'dang-lap-ke-hoach': 'dang-dung',         'dang-viet-code': 'dang-dung',
  'vat-da-o-nhanh-goc': 'dang-dung',
  'cho-nghiem-thu-may': 'dang-dung',        'dang-sua-theo-bang-chung': 'dang-dung',
  'nghiem-thu-bi-chan': 'dang-dung',        'cho-cong-bang-chung': 'dang-dung',
  'may-di-tiep-veto-mo': 'dang-dung',       'may-di-tiep-xanh-sach': 'dang-dung',
  'da-giao': 'da-ship',                     'cho-cong-gia-tri': 'cho-nghiem-thu',
  'da-giao-may-thong-veto-mo': 'da-ship',   'da-giao-may-thong-xanh-sach': 'da-ship',
  'da-giao-khong-do': 'da-ship',            'da-dong-ho-so': 'da-bac',
  'da-nghiem-thu-release': 'da-nghiem-thu', 'da-nghiem-thu-iterate': 'da-nghiem-thu',
  'da-nghiem-thu-kill': 'da-nghiem-thu',    'ho-so-hong': 'hong',
};

const STATE_KEYS = Object.keys(TRANG_THAI);

// Khoá lạ CHẾT TO: trả một mặc định câm ở đây nghĩa là một trạng thái mới lọt ra
// mặt người dưới TÊN CỦA TRẠNG THÁI KHÁC — đúng lớp lỗi bảng này sinh ra để chặn.
function chu(key) {
  const c = TRANG_THAI[key];
  if (!c) throw new Error(`trang-thai-ho-so: khoá không có trong bảng: ${key}`);
  return c;
}

module.exports = { TRANG_THAI, BUCKET_OF, STATE_KEYS, chu };
