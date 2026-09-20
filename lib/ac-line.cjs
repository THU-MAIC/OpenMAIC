/**
 * ac-line.cjs — MỘT nơi duy nhất quyết định "thế nào là một dòng criterion".
 *
 * Tách khỏi scripts/gate-card.js vì hai bản regex inline trôi độc lập (dòng 175
 * + 260 của bản cũ) chính là điều kiện đủ để lớp lỗi "card đọc thiếu criterion
 * mà không kêu" tái sinh. Ai cần bóc dòng criterion thì require file này —
 * không copy khuôn.
 */
// Blind-spot detector. AC_LINE below can only ever recognise the variants we have
// ALREADY seen; the next house style drifts in silently and the card renders short.
// So count lines that LOOK like an AC bullet and compare against what actually
// parsed (scope rule spelled out below the two regexes).
//   n === 0 && m > 0  → BLANK  (card shows nothing; obvious once seen)
//   0 < n < m         → SHORT  (card looks normal while hiding criteria — the case
//                               that survived a real signature: 2 of 8 on radar-d3)
// SHORT is the dangerous one, so it gets its own arm rather than riding on BLANK.
// SUSPECT must be strictly LOOSER than AC_LINE or it detects nothing new — the bullet
// marker is optional because real contracts declare criteria as bold headings too
// (`**AC-1 — Strip shows …**`, 13 of them in video-compose-progress-ux).
// NỚI (hồ sơ cong-nguoi-doc-du-nguon): 38 hợp đồng trên 11 kho khai tiêu chí bằng
// TIÊU ĐỀ `### AC-n`; với chúng khuôn cũ cho m = 0, nên nhánh `n===0 && m>0` không
// bao giờ đúng và bộ dò IM ở 34 trong 38 — đúng chỗ nó sinh ra để kêu.
const AC_SUSPECT = /^\s*(?:#{2,6}\s+)?(?:[-*]\s+)?\*{0,2}\s*AC-\d+\b/;
// …but an id followed by a separator opens a CROSS-REFERENCE, not a declaration
// (`**AC-5, AC-9, AC-10 chưa có gì**` in a Notes paragraph). Counting those cries wolf
// on a healthy contract, which the contract's own control case forbids.
// TIỀN TỐ PHẢI CÂN VỚI AC_SUSPECT. Bản trước nới SUSPECT sang tiêu đề mà bỏ quên
// XREF sinh đôi, nên một tham chiếu chéo viết dạng tiêu đề vừa được đếm là nghi
// ngờ vừa không bóc được → m > n → cờ SHORT nổ oan trên hợp đồng lành, khoá luôn
// dòng một-chạm. Hai khuôn này đọc CÙNG một hình dạng dòng, nên tiền tố của chúng
// là MỘT thứ: sửa một cái mà quên cái kia là dựng lại đúng lớp lỗi ấy.
const AC_XREF = /^\s*(?:#{2,6}\s+)?(?:[-*]\s+)?\*{0,2}\s*AC-\d+\s*[,;/]/;
// Scope: inside the criteria section when there IS one, whole file when there is not.
// Whole-file everywhere over-counts — a Known-limits note like `- **AC-4** — …:` is
// declaration-shaped but is not a declaration (measured: s4-scope-triage line 88 raised
// a false 15/16). Whole-file only when section() came back empty keeps the case this
// detector exists for: a wrong heading leaves no section to scope to.
// Luật ranh giới KHÔNG sống ở đây — nó ở bảng marker của lib/md-section.cjs. Bản
// duyệt riêng trước đây của file này là đúng thứ `findings-section-boundary` vừa
// gỡ khỏi gate-card.js ("xoá bản sao section()"); giữ nó lại là dựng lại y hệt
// điều kiện sinh lỗi mà cả hai feature đang đi đóng.
const { sectionLines, dongKhoi } = require('./md-section.cjs');
function acBlindSpot(contractText, parsedIds) {
  const scan = criteriaLines(contractText);
  const suspect = [];
  for (const { no, l } of scan) { if (AC_SUSPECT.test(l) && !AC_XREF.test(l)) suspect.push(no); }
  const m = suspect.length, n = parsedIds.length;
  if (m === 0 || n >= m) return null;
  const headingM = contractText.match(/^#{2,6}\s+.*criteri\w*.*$/im);
  return { kind: n === 0 ? 'blank' : 'short', suspect: m, parsed: n, lines: suspect, heading: headingM ? headingM[0].trim() : null };
}
function blindSpotText(b) {
  if (!b) return '';
  const where = b.heading ? `section "${b.heading}"` : 'không thấy heading criterion nào trong file';
  return b.kind === 'blank'
    ? `KHÔNG đọc được criterion nào, dù file có ${b.suspect} dòng trông như criterion (dòng ${b.lines.join(', ')}). Đã tìm ở ${where}. Card này KHÔNG phản ánh hợp đồng — sửa contract rồi render lại, đừng duyệt.`
    : `Đọc THIẾU ${b.suspect - b.parsed}/${b.suspect} dòng trông như criterion (tổng ở dòng ${b.lines.join(', ')}), chỉ bóc được ${b.parsed}. Đã tìm ở ${where}. Card này đang hiện một phần hợp đồng — sửa contract rồi render lại, đừng duyệt.`;
}
// AC bullet. The template form is `- AC-1: Given …, When …, Then …`, but real
// contracts accumulated three house variants the strict form silently dropped:
// `**` emphasis around the id, a parenthetical label between id and colon, and
// `.` used instead of `:`. Measured on a 170-contract repo, the strict form saw
// 838 of 1156 real AC lines — 28% invisible, with 43 contracts rendering 0 AC
// and (worse) 11 rendering a TRUNCATED list. A card that drops criteria without
// saying so is the exact false-green this tool exists to stop, so parse WIDE and
// let parseAC() below be the single place that decides what an AC line is.
// The id must still open the bullet — prose merely MENTIONING "AC-13" never matches.
// Emphasis may close on EITHER side of the label — `**AC-10** (judgment) …` and
// `**AC-1 (nhãn):** …` both occur in real contracts, so allow `*` at both spots.
const AC_LINE = /^\s*[-*]\s*\*{0,2}\s*(AC-\d+)\b\*{0,2}\s*(\([^)]*\))?\s*[:.]?\s*\*{0,2}\s*(.+)$/;
// judgment is read from the LABEL loosely (`(chi phí có trần — judgment)`) but from
// the BODY only via the exact `(judgment)` tag — a Then-clause discussing judgment
// must not silently reclassify a machine-checkable criterion as human-only.
// A `(judgment)` inside a code span is the criterion QUOTING the tag, not carrying
// it — same rule lib/context-glossary.js applies for W6 ("code spans are not the
// author speaking"). Without this, a contract that documents the tag demotes its own
// machine-checkable criteria to human-only, which on T3 sends them to a human verdict
// the evals already proved. Measured over 178 contracts: 157 AC lines carry the tag,
// only 4 have it solely inside backticks, and the 2 in consumer repos keep judgment
// via their label — so this narrows nothing that was genuinely tagged.
const uncoded = s => String(s).replace(/`[^`]*`/g, '');
// strip the tag only where it is the author speaking — a quoted `(judgment)` inside a
// code span is documentation and must survive verbatim into the rendered gwt.
const stripTag = s => String(s).split(/(`[^`]*`)/).map(p => p.startsWith('`') ? p : p.replace(/\(judgment\)/ig, '')).join('');
function parseAC(line) {
  // A cross-reference opens with an id then a separator (`**AC-5, AC-9, AC-10 chưa
  // có gì**`). AC_LINE is permissive enough to swallow one, which then lands on the
  // card as a criterion whose text is a Notes sentence — and, when the id repeats,
  // silently overwrites the real criterion's wording. Measured: 1 such line across
  // 178 contracts, and it is prose. Same rule the blind-spot scan uses.
  if (AC_XREF.test(line)) return null;
  const m = line.match(AC_LINE); if (!m) return null;
  const [, id, label = '', body] = m;
  const judgment = /judgment/i.test(uncoded(label)) || /\(judgment\)/i.test(uncoded(body));
  // crossLayer đọc theo ĐÚNG luật của judgment ngay trên — nhãn lỏng, thân bài
  // chỉ nhận tag đúng chữ, và cả hai đi qua uncoded() vì code span KHÔNG phải
  // tác giả đang nói. Trước đây Dấu này không sống ở đây: mỗi consumer tự dò
  // bằng `/\(cross-layer\)/i` trần trên `gwt`, nên một criterion TRÍCH DẪN Dấu
  // (hồ sơ giải thích Dấu cho người mới) bị chấm như criterion MANG Dấu — ở
  // eval-coverage-lint là W4 bắn giả, ở pre-merge-check là VIOLATION GIẢ CHẶN
  // MERGE. Hồ sơ ngược #36. Đối xứng vỡ đúng chỗ này là lý do lỗi tồn tại:
  // judgment theo luật "một nguồn", crossLayer thì không.
  // Đo trước khi đổi (556 criterion, kit + một repo tiêu thụ, 07/08/2026):
  // 7 criterion mang Dấu trước, 7 sau — KHÔNG criterion nào đổi trạng thái.
  // Tức bán kính bằng 0 trên dữ liệu hiện có; nó chặn ca sai TƯƠNG LAI, và
  // đó là lý do phải có fixture tổng hợp chứ không chờ hồ sơ thật lộ ra.
  const crossLayer = /cross-layer/i.test(uncoded(label)) || /\(cross-layer\)/i.test(uncoded(body));
  const gwt = stripTag((label ? label + ' ' : '') + body).trim();
  // A criterion with no words is not a criterion. `- **AC-1**` backtracks into a match
  // whose whole body is a leftover `*`, which would put a bullet character on the card
  // as if it were a requirement — and, worse, count toward `parsed` so the blind-spot
  // scan sees nothing wrong. Returning null makes such a line SUSPECT-but-unparsed,
  // which is exactly what it is.
  if (!/[\p{L}\p{N}]/u.test(gwt)) return null;
  return { id, gwt, judgment, crossLayer };
}

// Tên mục tiêu chí trôi qua ba cách viết trên 11 kho đo được. So khớp của
// sectionLines KHÔNG phân biệt hoa thường, nên `Acceptance criteria` trùng
// `Acceptance Criteria` và mục thứ ba chỉ là trang trí — bỏ, kẻo dạy sai người
// sau rằng danh sách này phân biệt hoa thường (lượt chấm 4).
const CRITERIA_HEADINGS = ['Criteria', 'Acceptance Criteria'];
// CHỈ acBlindSpot gọi hàm này, và quét cả tệp ở đây là ĐÚNG: nó chỉ làm số NGHI
// NGỜ to lên, tức làm cờ dễ kêu hơn — sai về phía an toàn. Bộ BÓC tiêu chí gọi
// criteriaLinesScoped; đừng đấu lại hai đường này vào nhau, lượt chấm 4 và 5 đều
// chết vì đúng chỗ đó.
function criteriaLines(contractText) {
  const trongMuc = criteriaLinesScoped(contractText);
  if (trongMuc.length) return trongMuc;
  return String(contractText == null ? '' : contractText).split('\n').map((l, i) => ({ no: i + 1, l }));
}
// HAI phạm vi quét, CỐ Ý khác nhau — đây là chỗ lượt chấm 4 và 5 cùng chết.
//
//   criteriaLinesScoped  → bộ BÓC tiêu chí. Không có mục thì trả RỖNG.
//   criteriaLines        → bộ ĐẾM nghi ngờ của acBlindSpot. Không có mục thì quét cả tệp.
//
// Vì sao không dùng chung: quét cả tệp để ĐẾM là vô hại, nó chỉ làm cờ kêu to hơn.
// Quét cả tệp để BÓC thì máy bịa tiêu chí — đo được trên cây trước bản này: một
// hợp đồng không có mục tiêu chí, có `- AC-4:` và `- AC-9:` nằm trong mục «Known
// limits», cho ra thẻ Cổng Phạm vi liệt AC-1, AC-4, AC-9 như tiêu chí phải làm,
// cờ điểm-mù IM (vì hai bên cùng đếm một tập dòng nên n luôn ≥ m), và dòng một-chạm
// mở sẵn chữ «duyệt». Người bấm duyệt một danh sách máy tự nghĩ ra.
//
// Bán kính của nhát cắt, đo trên 1 243 hợp đồng thật của 22 kho: 139 hồ sơ với
// 1 110 tiêu chí đi qua nhánh CÓ MỤC và giữ nguyên; 81 hồ sơ với 380 tiêu chí đi
// qua nhánh quét-cả-tệp và bị trả về hành vi cũ — trong đó 78 hồ sơ vốn ĐÃ có cờ
// đỏ ở cây gốc, nên nhát cắt không sinh tiếng ồn mới, nó chỉ thôi bịa.
// Hợp đồng muốn được đọc thì khai một mục tiêu chí; cờ `blank` nói đúng câu đó.
function criteriaLinesScoped(contractText) {
  for (const h of CRITERIA_HEADINGS) {
    const ls = sectionLines(contractText, h);
    if (ls.length) return ls;
  }
  return [];
}
// Tiêu chí khai bằng TIÊU ĐỀ: `### AC-n — nhãn`, thân là các dòng tới tiêu đề kế.
const AC_HEAD = /^#{2,6}\s+\*{0,2}\s*(AC-\d+)\b\*{0,2}\s*(.*)$/;
// parseACBlock — lối vào MỚI, đọc theo KHỐI. parseAC(line) giữ nguyên chữ ký nên
// ba bên gọi cũ và lớp vendored ở 9 kho không phải đổi cùng lượt.
// Dạng tiêu đề dựng lại thành một dòng gạch-đầu-dòng rồi cho parseAC chấm: hai
// dạng khai KHÔNG được có hai luật đọc tag, vì đó chính là lớp lỗi hồ sơ này đi
// đóng. Nhãn nối trước thân để `(judgment)` ở nhãn vẫn đọc theo luật nhãn-lỏng.
// TRẢ ĐỦ, KHÔNG GỘP id trùng: bên gọi tự gộp theo luật của mình, và thẻ Cổng
// Phạm vi dựa vào chính chỗ trùng đó để cảnh báo «trùng mã tiêu chí». Gộp ở đây
// là giết cảnh báo ấy một cách lặng lẽ — đo được: policy-graph-hub/registry-params
// khai AC-3, AC-7, AC-11, AC-16 mỗi mã hai lần.
function parseACBlock(contractText) {
  const out = [];
  let cur = null;
  const chot = () => {
    if (!cur) return;
    const than = cur.than.join(' ').replace(/\s+/g, ' ').trim();
    const nhan = cur.nhan.replace(/^[\s—–-]+/, '').trim();
    const a = parseAC(`- ${cur.id}${nhan ? ' ' + nhan : ''}: ${than}`);
    if (a) out.push(a);
    cur = null;
  };
  for (const { l } of criteriaLinesScoped(contractText)) {
    const h = l.match(AC_HEAD);
    if (h) { chot(); cur = { id: h[1], nhan: h[2] || '', than: [] }; continue; }
    // ĐÓNG KHỐI theo ĐÚNG luật của md-section: h2..h6 đóng, h1 là NỘI DUNG. Bản
    // trước tự viết `/^#{1,6}\s/` nên nó đóng ở cả h1, tức hai bộ duyệt bất đồng
    // về ranh giới — chính lớp lỗi hồ sơ này đi đóng (lượt chấm 7). Luật ở
    // md-section.cjs, không chép lại vào đây.
    if (dongKhoi(l)) { chot(); continue; }
    // Một dòng GẠCH ĐẦU DÒNG khai tiêu chí cũng ĐÓNG khối tiêu đề đang mở (lượt
    // chấm 3 bắt được). Bản trước nuốt nó vào thân của tiêu chí phía trên, nên
    // hợp đồng trộn hai cách khai mất tiêu chí ở giữa — đúng lớp «bên đọc hẹp
    // hơn bên viết» mà chính bộ bóc này sinh ra để đóng.
    const gach = parseAC(l);
    if (gach) { chot(); out.push(gach); continue; }
    if (cur) { cur.than.push(l); continue; }
  }
  chot();
  return out;
}

module.exports = { AC_LINE, AC_SUSPECT, AC_XREF, AC_HEAD, CRITERIA_HEADINGS, criteriaLines, criteriaLinesScoped, parseAC, parseACBlock, acBlindSpot, blindSpotText };
