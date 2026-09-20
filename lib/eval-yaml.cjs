'use strict';
/* eval-yaml.cjs — parser DÒNG cho evals.yaml, dùng chung bởi gate-card.js, evidence-core.cjs (luật làn re-pin, vendor sang consumer theo INIT-CI-COPY-LIST — đuôi .cjs để sống trong repo type:module) và
 * eval-coverage-lint.js. Cố ý KHÔNG dùng thư viện YAML (mirror độ khoan dung
 * của hooks), nhưng PHẢI hiểu block scalar: khuôn eval-gen viết `expected: >`
 * nên regex một-dòng chỉ bắt được ">" — NEG_RE test trên ">" luôn false, và
 * covGaps (thẻ Cổng 1) lẫn W1/W3 (lint) bắn cảnh báo giả cho mọi AC khớp
 * THRESHOLD_RE dù expected đầy ca âm. Hai bản sao của cùng parser đã trôi
 * cùng nhau; sửa một chỗ tại đây, không mọc bản thứ ba.
 *
 * Hai luật:
 *   1. giá trị block (`key: >` / `key: |`, kèm chomping/indent indicator) =
 *      các dòng thụt sâu hơn key, join '\n', trim từng dòng;
 *   2. dòng THÂN block không bao giờ được quét key — một dòng "criterion: ..."
 *      hay "- id: ..." nằm trong thân expected không được cướp state của eval.
 */

// >, |, >-, |+, >2 … cộng comment đuôi tuỳ chọn — đúng cú pháp header block YAML.
const BLOCK_RE = /^[>|][+-]?\d*\s*(?:#.*)?$/;

/**
 * @param {string} text nội dung evals.yaml
 * @param {string[]} fields các key cần lấy ngoài id (vd ['criterion','expected'])
 * @param {(s:string)=>string} [normalize] chuẩn hoá giá trị MỘT-DÒNG (quote /
 *   comment đuôi — mỗi caller giữ tolerance sẵn có của nó); thân block giữ
 *   nguyên vì comment trong thân là DATA, không phải comment.
 * @returns {Array<{id:string}>} mỗi phần tử có thêm mọi key trong `fields` ('' nếu vắng)
 */
function parseEvals(text, fields, normalize) {
  const norm = normalize || (s => String(s).trim());
  const evals = [];
  let cur = null;
  let blk = null; // block scalar đang mở: { key: string|null, indent, lines }
  const closeBlk = () => { if (blk && cur && blk.key) cur[blk.key] = blk.lines.join('\n').trim(); blk = null; };
  for (const raw of String(text == null ? '' : text).split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    if (blk) {
      if (!line.trim()) { blk.lines.push(''); continue; }
      const ind = line.search(/\S/);
      if (ind > blk.indent) { blk.lines.push(line.trim()); continue; }
      closeBlk(); // dedent → dòng này là dòng thường, rơi tiếp xuống dưới
    }
    const idM = line.match(/^\s*-\s+id:\s*(.+)$/);
    if (idM) { if (cur) evals.push(cur); cur = { id: idM[1].trim() }; for (const f of fields) cur[f] = ''; continue; }
    if (!cur) continue;
    const km = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!km) continue;
    const val = km[3].trim();
    const wanted = fields.indexOf(km[2]) >= 0;
    // key: > mở block cho MỌI key (kể cả không lấy, vd cmd: |) — thân phải bị
    // nuốt để không bị quét nhầm thành key của eval.
    if (BLOCK_RE.test(val)) { blk = { key: wanted ? km[2] : null, indent: km[1].length, lines: [] }; continue; }
    if (wanted) cur[km[2]] = norm(val);
  }
  closeBlk();
  if (cur) evals.push(cur);
  return evals;
}


// Cắt chú thích YAML — MỘT nguồn cho mọi bộ đọc dòng (surfaces, field của eval,
// frontmatter). Luật: `#` mở chú thích khi nó đứng ĐẦU chuỗi hoặc có khoảng
// trắng đứng trước; `x#y` là DỮ LIỆU, không phải chú thích. Trước hồ sơ
// gom-duc-ket-2-10-0 mỗi bộ đọc tự viết một regex (`[ \t]+#` ở lib/lint,
// `\s*#` ở thẻ) nên cùng một dòng `surfaces:` cho hai câu trả lời khác nhau.
const stripComment = s => String(s == null ? '' : s).replace(/(^|\s)#.*$/, '').trim();


// Kỳ vọng mã thoát của một eval máy — MỘT nguồn cho mọi bộ đọc (s4-args, làn
// ghim lại, checkRepinEvals, evaluateEvidence). Vắng trường VÀ khai 0 tường
// minh cho CÙNG kết quả: «đã khai» không phải một trạng thái riêng, chỉ giá
// trị khác 0 mới là một giới hạn.
//
// EXPECTED_EXIT_BANNED phải BẰNG tập khoá của khối marker INFRA-EXIT-CODES
// trong feature-loop/workflows/acceptance-verify.js. Không require được sang
// đó: tệp này vendor sang repo tiêu thụ, tệp kia không. Ca EE8 giữ hai bên
// khớp, hai chiều. Vì sao cấm: normInfra đổi hai mã đó thành cannotRun TRƯỚC
// mọi phép so, nên khai chúng là hứa một điều máy không giữ được; và đúng hai
// mã đó là lãnh địa ô đã park `baseline-127-tin-hieu-phan-biet` (ADR 0016).
const EXPECTED_EXIT_BANNED = [97, 127];
const EXPECTED_EXIT_EXECUTORS = ['test', 'script'];

function expectedExits(text) {
  const byId = new Map();
  const errs = [];
  for (const e of parseEvals(text, ['executor', 'expected_exit'], stripComment)) {
    const id = e.id;
    const executor = String(e.executor || '').trim().toLowerCase();
    const raw = String(e.expected_exit == null ? '' : e.expected_exit).trim().replace(/^["']|["']$/g, '');
    // Khai 0 tường minh (kể cả "00") không phải một giới hạn — nó phải đi
    // ĐÚNG đường vắng trường ở MỌI executor, kể cả executor không hợp lệ.
    // Phép kiểm executor chỉ áp khi giá trị khai giải ra KHÁC 0.
    if (raw === '' || (/^\d+$/.test(raw) && Number(raw) === 0)) { byId.set(id, 0); continue; }
    if (!EXPECTED_EXIT_EXECUTORS.includes(executor)) {
      errs.push(`eval ${id}: expected_exit khai trên executor "${executor}" — chỉ ${EXPECTED_EXIT_EXECUTORS.join('/')} chạy lệnh nên mới có mã thoát`);
      byId.set(id, 0); continue;
    }
    if (!/^\d+$/.test(raw)) {
      errs.push(`eval ${id}: expected_exit "${raw}" không phải số nguyên 0–255`);
      byId.set(id, 0); continue;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      errs.push(`eval ${id}: expected_exit "${raw}" không phải số nguyên 0–255`);
      byId.set(id, 0); continue;
    }
    if (EXPECTED_EXIT_BANNED.includes(n)) {
      errs.push(`eval ${id}: expected_exit ${n} là mã hạ tầng (${EXPECTED_EXIT_BANNED.join(', ')}) — không khai được; hạ tầng hỏng đi đường cannotRun, không đi đường giới hạn đã khai`);
      byId.set(id, 0); continue;
    }
    byId.set(id, n);
  }
  return { byId, errs };
}

module.exports = { parseEvals, BLOCK_RE, stripComment, expectedExits, EXPECTED_EXIT_BANNED, EXPECTED_EXIT_EXECUTORS };
