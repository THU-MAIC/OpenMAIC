// nguong-o-co-hoi.cjs — LUẬT DUY NHẤT trả lời «ô ngưỡng của hồ sơ cơ hội đang ở đâu».
//
// Vì sao một chỗ: bộ quét, thẻ quyết định và ca đo đều phải phân loại cùng một ô. Vòng 1
// của hồ sơ ra-co-ten viết luật này BA LẦN (start-scan · gate-card · ca đo) và bản thứ ba
// đã lệch ngay khi ra đời: nó chỉ đòi «mọi bullet ĐANG CÓ đều đã điền», không đòi ĐỦ nhãn
// của khuôn — nên một ô thiếu hẳn hai bullet bị hai bên kết luận trái nhau. Cùng doctrine
// với lib/workspace-record.cjs: ai thêm bên đọc thứ ba thì GỌI hàm này, đừng chép luật.
//
// Hàm THUẦN: nhận nội dung đã đọc, không tự đọc file — bên gọi quyết định đọc ở đâu.
'use strict';
const { section } = require('./md-section.cjs');

const UAT_THRESHOLD_HEADING = 'Ngưỡng chết / ngưỡng UAT';
const PLACEHOLDER_RE = /^(…|\.\.\.)?$/;
const bulletOf = l => { const m = l.match(/^\s*[-*]\s+([^:]+):(.*)$/); return m ? { label: m[1].trim(), value: m[2].trim() } : null; };
// «Chưa điền» nhận diện RỘNG hơn bulletOf: dấu đầu dòng TUỲ CHỌN. Ô cơ hội viết tay có dòng
// ngưỡng không gạch đầu dòng; đòi gạch thì placeholder lọt thành «đã khai» — thẻ Cổng Phạm vi
// mất cờ vàng và đòi thêm `## Đường đo` cho ô chưa có thước nào, trong khi thresholdState (đi
// qua bulletOf) vẫn gọi «chưa chốt»: hai bộ đọc nói hai chuyện về CÙNG hồ sơ, đúng lớp lỗi
// mà lib này sinh ra để giết (S4-r8). bulletOf giữ CHẶT — nhãn của nó round-trip với khuôn.
const CHUA_DIEN_RE = /^[-*]?\s*[^:]*:\s*(…|\.\.\.)?\s*$/;
const chuaDien = l => CHUA_DIEN_RE.test(String(l).trim());

// Rút chuỗi máy-đọc từ khối marker của khuôn. FAIL-CLOSED: khuôn mất khối thì NÉM, không
// trả null. Một răng chặn tắt im lặng vì thiếu khuôn là chiều hỏng tệ nhất cho một cổng.
function prefixFromTemplate(tplText, marker) {
  const m = String(tplText).match(new RegExp(`<<<${marker} -->\\n([\\s\\S]*?)<!-- ${marker}>>>`));
  if (!m) throw new Error(`khuôn ô cơ hội không có khối ${marker} — không phân loại ngưỡng được`);
  return m[1].trim();
}
const prefixes = tplText => ({
  deXuat: prefixFromTemplate(tplText, 'OPP-DE-XUAT-PREFIX'),
  khongDo: prefixFromTemplate(tplText, 'OPP-KHONG-DO-DUOC-PREFIX'),
});

// Dòng «không đo được» = bắt đầu ĐÚNG tiền tố, ký tự kế là khoảng trắng hoặc hết dòng.
// Nhận cả dạng bullet `- `/`* ` trước tiền tố: section Ngưỡng toàn bullet nên đó là dạng
// tự nhiên nhất — bản cũ xếp nó im lặng thành «chưa chốt» (S4-r6 [5], phân loại sai câm).
// «Không đo được:» (hai chấm) KHÔNG phải lối ra — lối ra có tên thì tên phải khớp.
const isKhongDoLine = (line, khongDo) => {
  const t = String(line).trim().replace(/^[-*]\s+/, '');
  return t.startsWith(khongDo) && (t.length === khongDo.length || /\s/.test(t[khongDo.length]));
};

// Nhãn bullet CHUẨN = nhãn trong khuôn (không phải nhãn có mặt trong hồ sơ).
const thresholdLabels = tplText => section(tplText, UAT_THRESHOLD_HEADING).map(bulletOf).filter(Boolean).map(b => b.label);

// BỐN trạng thái. Thứ tự hỏi: lối ra có tên trước, rồi mới xét bullet — ô đã khai «không
// đo được» thì bullet còn lại không có nghĩa.
function thresholdState(oppText, tplText) {
  const { deXuat, khongDo } = prefixes(tplText);
  const lines = section(oppText, UAT_THRESHOLD_HEADING);
  if (lines.some(l => isKhongDoLine(l, khongDo))) return 'khong-do-duoc';
  const got = new Map();
  for (const l of lines) { const b = bulletOf(l); if (b) got.set(b.label, b.value); }
  const labels = thresholdLabels(tplText);
  // Thông điệp giữ NGUYÊN VĂN bản cũ của start-scan — có ca ghim nó (VC1 chiều đỏ b).
  if (!labels.length) throw new Error(`khuôn không có section Ngưỡng «${UAT_THRESHOLD_HEADING}» (hoặc section không có bullet)`);
  if (!labels.every(lb => got.has(lb) && !PLACEHOLDER_RE.test(got.get(lb)))) return 'chua-chot';
  return [...got.values()].some(v => v.startsWith(deXuat)) ? 'de-xuat' : 'chot';
}

// Timebox: CHỈ nhận hai dạng ngày. Hạn viết «muộn nhất <ngày>» BAO GỒM ngày đó, nên quá
// hạn tính từ 00:00 hôm SAU — cắm cờ đúng ngày hạn là giục người sớm một ngày.
function timeboxDate(oppText) {
  for (const l of section(oppText, UAT_THRESHOLD_HEADING)) {
    const b = bulletOf(l); if (!b || b.label !== 'Timebox') continue;
    const iso = b.value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
    const vn = b.value.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
    if (vn) return Date.UTC(+vn[3], +vn[2] - 1, +vn[1]);
  }
  return null;
}
const quaTimebox = (oppText, now = Date.now()) => { const d = timeboxDate(oppText); return d != null && d + 86400000 <= now; };

// Mặt có NGƯỜI DÙNG CUỐI — vị từ của răng chống lách «không đo được». Sống ở đây vì hai
// bộ đọc (bộ quét + thẻ) cùng hỏi; hai bản regex rời là đúng lớp lib này sinh ra để giết.
const SURFACE_NGUOI_DUNG = /\b(ui|mobile)\b/i; // giữ tên xuất khẩu cho bên đọc cũ
// Mặt người nhìn (ui + alias web/web-ui) RÚT từ lib/lop-nhin-thay.cjs — một nguồn cho bốn bộ đọc
// (hồ sơ lop-bang-chung-nhin-thay, D4); mobile vẫn là người dùng cuối nhưng đi làn test.
// Đường đọc-cũ: bản vendored/bản sao chỉ chép từng file lib (repo tiêu thụ trước 2.10, fixture
// chép tay) không có lop-nhin-thay.cjs → quay về regex cũ (ui|mobile, KHÔNG alias web) thay vì
// ném lỗi làm bộ quét/bản đồ chết (đọc-cũ: bản sao/vendored chép từng file vẫn chạy).
let LNT = null;
try { LNT = require('./lop-nhin-thay.cjs'); } catch (_) { LNT = null; }
const coNguoiDungCuoi = surfaces => LNT
  ? (LNT.laMatNguoiNhin(surfaces) || LNT.tokensOf(surfaces).includes('mobile'))
  : SURFACE_NGUOI_DUNG.test(String(surfaces || ''));

module.exports = { UAT_THRESHOLD_HEADING, SURFACE_NGUOI_DUNG, coNguoiDungCuoi, thresholdState, thresholdLabels, prefixes, prefixFromTemplate, isKhongDoLine, timeboxDate, quaTimebox, bulletOf, chuaDien, PLACEHOLDER_RE };
