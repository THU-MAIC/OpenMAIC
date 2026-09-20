'use strict';
/**
 * evidence-core.cjs — the SINGLE SOURCE OF TRUTH for the acceptance gate's
 * evidence validation (L1 SHAPE, L1 CONSISTENCY, L2 SUBSTANCE, L2 OBSERVED, L3 JUDGMENT).
 *
 * Two callers share this so they cannot drift:
 *   - hooks/acceptance-evidence-gate.js — PreToolUse, validates at WRITE time.
 *   - scripts/recheck-evidence.cjs       — CI, re-validates the COMMITTED report
 *     (the backstop for a report hand-edited after the write-time hook ran, or
 *     written under ACCEPTANCE_GATE_BYPASS).
 *
 * Pure-ish: no stdin/stdout/exit. `evaluateEvidence` reads the sibling
 * contract.md (for the T3 rule) when a fileDir is given; everything else is a
 * function of the payload + caller-supplied config text.
 */

const fs = require('fs');
const path = require('path');

const PASS_FAMILY = /^(PASS|PASSED|ACCEPTED|APPROVED|GO|SUCCESS)$/i;

// ─── Config lookup ─────────────────────────────────────────────────────────

function findAcceptanceConfig(fileDir) {
  // evidence-report.md lives at _acceptance/<slug>/ → config is ../config.yaml.
  // Walk up defensively in case of nesting.
  let cur = fileDir;
  for (let i = 0; i < 10 && cur && cur !== path.dirname(cur); i++) {
    const base = path.basename(cur) === '_acceptance'
      ? cur
      : path.join(cur, '_acceptance');
    const candidate = path.join(base, 'config.yaml');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {}
    cur = path.dirname(cur);
  }
  return null;
}

// Vị trí dấu nháy ĐÓNG của vỏ mở ở ký tự 0, hoặc -1 khi không có vỏ đóng hợp
// lệ. Vỏ kép: `\` escape ký tự kế. Vỏ đơn: `''` là một dấu nháy literal, không
// phải vỏ đóng.
function closingQuoteIndex(s) {
  const q = s[0];
  if (q !== '"' && q !== "'") return -1;
  for (let i = 1; i < s.length; i += 1) {
    if (q === '"') {
      if (s[i] === '\\') { i += 1; continue; }
      if (s[i] === '"') return i;
    } else {
      if (s[i] !== "'") continue;
      if (s[i + 1] === "'") { i += 1; continue; }  // '' = nháy literal
      return i;
    }
  }
  return -1;
}

// Cắt chú thích YAML trên MỘT scalar, CÓ NHẬN BIẾT VỎ NHÁY.
//
// Vì sao không dùng thẳng `replace(/\s+#.*$/, '')`: phép đó không biết gì về
// vỏ, nên một scalar HỢP LỆ mang ` #` bên trong vỏ bị xén giữa chừng; mảnh còn
// lại KHÔNG CÂN, `unquoteScalar` (đúng theo thiết kế) trả nguyên văn kèm dấu
// nháy MỞ, và `bash -c '"echo a'` thoát 2 — tái tạo đúng chuỗi xanh-giả bốn
// bước mà hồ sơ release-2-11-0 tồn tại để đóng, chỉ đổi nguồn gây
// nháy-không-cân từ NGƯỜI VIẾT sang CHÍNH BỘ GIẢI. S4 lượt 1 của hồ sơ đó bắt
// được; ca BG7 giữ chỗ này.
function stripYamlComment(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const end = closingQuoteIndex(s);
  if (end >= 0) {
    const sau = s.slice(end + 1);
    if (/^\s*(#.*)?$/.test(sau)) return s.slice(0, end + 1);   // vỏ trọn vẹn, phần sau chỉ là chú thích
  }
  // `(^|\s)` chứ không `\s+`: `s` đã `trim()`, nên giá trị CHỈ LÀ chú thích
  // (`khoa:   # TODO`) mở đầu bằng `#` và không có khoảng trắng nào đứng trước.
  // Bản `\s+` trả nguyên chuỗi chú thích — truthy, qua lưới `if (!val) die`, và
  // `bash -c '# TODO'` thoát 0 → PASS mà không chạy gì (lượt chấm 4 bắt). Cùng
  // biểu thức với `stripComment` của lib/eval-yaml.cjs.
  return s.replace(/(^|\s)#.*$/, '').trim();
}

// Tách một list inline `a, b` theo dấu phẩy Ở NGOÀI vỏ nháy. `split(',')` trần
// xẻ ngay giữa vỏ, cho ra hai mảnh không cân — cùng lớp lỗi với stripYamlComment.
function splitTopLevel(s) {
  const out = []; let cur = ''; let q = null; let dauMuc = true;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (q) {
      cur += ch;
      if (q === '"' && ch === '\\') { if (i + 1 < s.length) { cur += s[i + 1]; i += 1; } continue; }
      if (ch === q) { if (q === "'" && s[i + 1] === "'") { cur += s[i + 1]; i += 1; continue; } q = null; }
      continue;
    }
    // Cùng luật với closingBracketIndex: nháy chỉ mở vỏ khi đứng ĐẦU một mục.
    if (dauMuc && (ch === '"' || ch === "'")) { q = ch; cur += ch; dauMuc = false; continue; }
    if (ch === ',') { out.push(cur); cur = ''; dauMuc = true; continue; }
    cur += ch;
    if (!/\s/.test(ch)) dauMuc = false;
  }
  out.push(cur);
  return out;
}

// Bóc vỏ nháy của MỘT scalar YAML một dòng — nguồn DUY NHẤT cho mọi đường đọc
// giá trị sẽ được THI HÀNH hoặc dùng làm chỉ thị/đường dẫn (resolveConfigKey ·
// resolveConfigList · bốn chỗ trong feature-loop/scripts/s4-args.mjs).
//
// Vì sao không dùng `replace(/^["']|["']$/g, '')`: đó là phép thay thế CÓ NEO
// dạng lựa-chọn, gỡ nháy đầu và nháy cuối ĐỘC LẬP nhau, nên
//   (a) một chuỗi chỉ TÌNH CỜ kết thúc bằng nháy mất luôn ký tự đó, và
//   (b) vì nó chỉ cắt vỏ, nó không biết gì về escape BÊN TRONG vỏ.
// Cả hai đo được trên main d1d36479 (hồ sơ release-2-11-0): `pytest -q -k 'a or
// b'` giải ra thiếu dấu đóng → `bash -c` thoát 2 → luật kỳ-vọng-mã-thoát (ship
// 10/09, cấm [97,127] chứ KHÔNG cấm 2) đọc mã 2 của SHELL thành «giới hạn đã
// khai» của CÔNG CỤ → PASS. Xanh giả bốn bước, tái phát qua ba mốc liên tiếp.
// (Chuỗi tên trường viết dạng gạch nối có chủ ý: ca tĩnh SA-EE4 canh cho dạng
// snake_case của nó KHÔNG rò vào bất kỳ bộ đọc nào khác, kể cả trong chú thích.)
// `frontmatterField` cuối tệp này đã học đúng bài học ấy ở S4-r5 và tự vá; kit
// giải lớp MỘT LẦN rồi không lan sang bộ đọc kế bên — đó là lý do lần này đi
// bằng một hàm dùng chung thay vì lại sửa một chỗ.
//
// Hai biểu thức đòi nháy trong thân HỢP LỆ theo YAML (vỏ kép: nháy trong phải
// escape · vỏ đơn: nháy trong phải nhân đôi), nên `"a" && echo "b"` — nháy hai
// đầu mà KHÔNG phải một cặp vỏ — giữ NGUYÊN VĂN thay vì bị xẻ. Không đoán thay
// người viết là hành vi đúng cho một chuỗi sắp được thi hành.
// Giới hạn đã khai: nháy đơn nhân đôi KHÔNG được un-double (`'it''s'` →
// `it''s`, YAML nói `it's`) — chưa có ca thật nào trong 8 kho đo được.
function unquoteScalar(raw) {
  const s = String(raw == null ? '' : raw);
  if (/^"(?:[^"\\]|\\.)*"$/.test(s)) return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (/^'(?:[^']|'')*'$/.test(s)) return s.slice(1, -1);
  return s;
}

// Vị trí `]` ĐÓNG của một flow-sequence mở ở ký tự 0, bỏ qua mọi `]` nằm TRONG
// vỏ nháy. -1 khi không đóng.
function closingBracketIndex(s) {
  if (s[0] !== '[') return -1;
  let q = null; let dauMuc = true;   // ngay sau `[` hoặc `,` (bỏ khoảng trắng)
  for (let i = 1; i < s.length; i += 1) {
    const ch = s[i];
    if (q) {
      if (q === '"' && ch === '\\') { i += 1; continue; }
      if (ch === q) { if (q === "'" && s[i + 1] === "'") { i += 1; continue; } q = null; }
      continue;
    }
    // YAML: dấu nháy chỉ là CHỈ DẤU khi đứng ĐẦU một node. `[plain, ends']` là
    // hợp lệ và nghĩa là ['plain', "ends'"] — coi dấu `'` giữa chừng là mở vỏ
    // sẽ nuốt luôn `]` và cả biểu thức hoá vô nghĩa (bắt được ở ca BG4).
    if (dauMuc && (ch === '"' || ch === "'")) { q = ch; dauMuc = false; continue; }
    if (ch === ']') return i;
    if (ch === ',') { dauMuc = true; continue; }
    if (!/\s/.test(ch)) dauMuc = false;
  }
  return -1;
}

// ─── MỘT CỔNG DUY NHẤT cho mọi giá trị YAML một dòng ──────────────────────
//
// `parseFlowValue` là bộ tách token duy nhất; MỌI bộ đọc của kit tiêu thụ nó
// thay vì tự viết một biểu thức nhận-biết-vỏ. Vì sao khuôn này chứ không phải
// vá từng chỗ: hồ sơ release-2-11-0 vá HAI lượt và cả hai lượt lại sinh lỗi
// CÙNG LỚP — lượt 1 «cắt chú thích/tách phẩy chạy TRƯỚC bộ bóc nháy», lượt 2
// «bộ cắt chú thích không nhận ra flow-sequence nên rơi về mệnh đề trần». Mỗi
// lần nhận-biết-vỏ được gắn vào MỘT bước phẫu-thuật-chuỗi thì bước kế bên
// trong cùng ống dẫn lại thiếu, và hệ quả luôn giống nhau: mảnh không cân,
// dấu nháy MỞ lọt vào chuỗi giao cho `bash -c`, shell thoát 2, và luật mã
// thoát đã khai đọc số 2 đó thành «giới hạn của công cụ» → PASS. STOP-PATCHING
// nổ ở lượt 2; owner chọn ĐỔI KHUÔN (10/09). Tính đúng của bộ này KHÔNG phụ
// thuộc việc đếm đủ số đường đọc — đó là điều mà mọi bản vá theo-từng-chỗ
// không thể có.
//
// Trả về một trong hai:
//   { kind: 'seq',    items: string[], text: string }   — flow-sequence `[...]`
//   { kind: 'scalar', value: string,   text: string }   — mọi thứ còn lại
// `text` = phần giá trị SAU khi cắt chú thích, giữ nguyên vỏ — bên nào cần
// nguyên văn (vd resolveConfigKey trả chuỗi cho một khoá là danh sách) thì đọc
// nó, không tự cắt lại.
function parseFlowValue(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const end = closingBracketIndex(s);
  if (end >= 0 && /^\s*(#.*)?$/.test(s.slice(end + 1))) {
    const text = s.slice(0, end + 1);
    // `value` CÓ MẶT cả ở nhánh seq (= nguyên văn `[...]`) để nó KHÔNG BAO GIỜ
    // undefined. Lượt chấm 3 bắt: nhánh khối của resolveConfigList gọi `.value`
    // trên một item là flow-sequence và đẩy `undefined` vào một mảng khai kiểu
    // string[] — mà đó là nguồn của `feature_loop.suite_keys`. Bắt bên gọi phải
    // NHỚ một biểu thức ba ngôi là đúng khuôn sai mà cổng chung sinh ra để bỏ:
    // chỗ dễ quên phải nằm TRONG cổng, không nằm ở chín chỗ gọi.
    return { kind: 'seq', text, value: text, items: splitTopLevel(s.slice(1, end)).map(x => unquoteScalar(stripYamlComment(x))).filter(Boolean) };
  }
  const text = stripYamlComment(s);
  return { kind: 'scalar', text, value: unquoteScalar(text) };
}

function resolveConfigKey(configText, dottedKey) {
  // Indent-based walk for a 2-3 level dotted key (e.g. executors.test.api).
  // Returns the scalar value or null. No YAML lib — line-based on purpose.
  const parts = dottedKey.split('.');
  const lines = configText.split('\n');
  let depth = 0;
  let expectedIndent = 0;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent < expectedIndent) {
      // left the branch we were following — reset if we fell below current depth
      while (depth > 0 && indent < expectedIndent) {
        depth--;
        expectedIndent -= 2;
      }
    }
    if (indent !== expectedIndent) continue;
    const m = line.trim().match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    if (m[1] === parts[depth]) {
      if (depth === parts.length - 1) {
        const pv = parseFlowValue(m[2]);
        const val = pv.kind === 'seq' ? pv.text : pv.value;
        return val || null; // leaf must have a non-empty scalar
      }
      depth++;
      expectedIndent += 2;
    }
  }
  return null;
}

// List value of a dotted key (e.g. feature_loop.suite_keys): the `- item`
// lines nested under the leaf, or an inline `[a, b]`. [] when absent. Same
// indent walk as resolveConfigKey. ONE reader for config.yaml lists, shared by
// s4-args.mjs (S4) and repin-lane.mjs (re-pin) — the two lanes cannot read
// suite_keys differently.
function resolveConfigList(configText, dottedKey) {
  const parts = dottedKey.split('.');
  const lines = String(configText || '').split('\n');
  let depth = 0; let expectedIndent = 0; let leafIndent = -1; const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (leafIndent >= 0) {
      if (indent <= leafIndent) break;
      const m = line.trim().match(/^-\s+(.*)$/);
      if (m) out.push(parseFlowValue(m[1]).value);
      continue;
    }
    if (indent < expectedIndent) {
      while (depth > 0 && indent < expectedIndent) { depth--; expectedIndent -= 2; }
    }
    if (indent !== expectedIndent) continue;
    const m = line.trim().match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    if (m[1] === parts[depth]) {
      if (depth === parts.length - 1) {
        // `[` không đóng (hoặc đóng bên trong vỏ) → KHÔNG phải flow-sequence:
        // rơi về nhánh khối, trả [] — fail-CLOSED. Với `suite_keys` thì s4-args
        // chết có tên thay vì chạy một danh sách bịa.
        if (parseFlowValue(m[2]).kind === 'seq') return parseFlowValue(m[2]).items;
        leafIndent = indent; continue;
      }
      depth++;
      expectedIndent += 2;
    }
  }
  return out;
}

// ─── Frontmatter field read (leading block only) ───────────────────────────

// Mirrors pre-merge-check.sh front_field: tolerate leading blank lines, read
// ONLY the leading --- fence block — a body excerpt (pasted log) cannot poison
// the read. Returns the normalized scalar (comments/quotes stripped) or null
// when the file has no leading frontmatter / the key is absent.
function frontmatterField(payload, key) {
  const text = String(payload).replace(/^(?:[ \t]*\r?\n)+/, '');
  const fm = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!fm) return null;
  // `[ \t]*` chứ KHÔNG phải `\s*` sau dấu phân cách: `\s` khớp cả xuống dòng,
  // nên một khoá để TRỐNG (`verdict:`, `approved_at:`, `human_signoff:`) nuốt
  // luôn dòng kế và trả về giá trị của khoá khác. Đọc `verdict:` rỗng ra
  // "decided_by: Manh" khiến một phiên chưa ký bị gọi là hồ sơ hỏng, và
  // `approved_at:` rỗng làm hỏng thứ tự xếp cổng chờ ký. Bug này ẩn được lâu
  // vì mọi khuôn mẫu đều tình cờ có comment `#` ngay sau khoá rỗng — comment
  // hút mất cú nuốt (S4-r2).
  const line = fm[1].match(new RegExp('^' + key + '[ \\t]*[:=][ \\t]*(.*)$', 'mi'));
  if (!line) return null;
  const val = line[1]
    .replace(/^#.*$/, '')      // comment-only value ("# placeholder") = empty
    .replace(/\s+#.*$/, '')
    .trim();
  // Chỉ bóc nháy khi CẢ CẶP khớp. Bóc đầu và cuối độc lập thì một giá trị
  // không-quote mà KẾT THÚC bằng nháy sẽ mất ký tự cuối — `ngăn thứ ba "thật
  // nhưng ngoài hợp đồng"` đọc ra thiếu dấu đóng, và bản đồ sản phẩm in
  // nguyên văn ra cho người đọc nên cái cụt đó hiện thành văn bản hỏng (S4-r5).
  const paired = val.match(/^"([\s\S]*)"$/) || val.match(/^'([\s\S]*)'$/);
  return (paired ? paired[1] : val).trim();
}

// ─── Run-log reconciliation (run_id provenance) ────────────────────────────

// run-log.jsonl sits next to the report, appended by the verify MACHINERY
// (workflow JS computes the exact lines; a mechanical scribe writes them) the
// moment machine results exist — before the report. A PASS report's run_ids
// must all appear there, so a report minted by hand (or by a synthesizer that
// never ran anything) fails the same core the hook and CI re-check share.
// Defense-in-depth against lazy fabrication, not against an adversary editing
// the log too — that path is caught by review/diff like any artifact tamper.

function extractRunIds(payload) {
  const ids = [];
  const RE = /^\s*(?:-\s+)?run_id\s*[:=]\s*(.+?)\s*$/i;
  for (const line of String(payload).split('\n')) {
    const m = line.match(RE);
    if (!m) continue;
    const val = m[1].replace(/\s+#.*$/, '').trim().replace(/^["']+|["']+$/g, '').trim();
    if (val) ids.push(val);
  }
  return ids;
}

// run_ids of {"kind":"repin"} lane lines — lane provenance backs a ### Re-pin
// signature, NEVER an eval block (AC-11 delta-verify-repin: an agent fresh off
// a re-pin has the lane id in context — borrowing it for an eval block is the
// exact lazy-fabrication path this layer exists to block). Null when no log.
function loadRepinRunIds(fileDir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(fileDir, 'run-log.jsonl'), 'utf8');
  } catch (_) {
    return null;
  }
  const ids = new Set();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && entry.kind === 'repin' && typeof entry.run_id === 'string' && entry.run_id) ids.add(entry.run_id);
    } catch (_) { /* skip malformed line */ }
  }
  return ids;
}

// ─── Re-pin eval lane (repin-chay-lai-eval, 2026-09-07) ─────────────────────
// A {"kind":"repin"} lane proves the repo's suites (suites_exit); it proves
// NOTHING about the slug's own evals unless it re-ran them at that sha. Real
// case (crm-onehub, 2026-09-07): a signed record whose premise an 88-commit
// merge removed was re-pinned green and reached the main branch with CI green.
// Every lane that backs verified_commit must carry `evals_exit` = {evalId:
// exit} covering every test/script eval declared in the slug's evals.yaml, all
// 0 (ui-check/judgment cannot run in a machine lane — declared limit, see
// GUIDE §7.1). NO date mark, NO grandfather (owner, 2026-09-08): a suite-only
// lane never proved the pin, whenever it ran — old pins are honest debt, red
// until re-pinned with the eval lane; the kit's own debt is named in
// tests/scripts/mirror-sync-grandfather.mjs (two-way checked), not hidden here.
const REPIN_MACHINE_EXECUTORS = ['test', 'script'];
// Giá trị trạng-thái DUY NHẤT khiến một ô rời khỏi tập đáng ghim. Chuẩn hoá vì
// một lời khai bọc nháy hay viết hoa vẫn là cùng lời khai — cùng lớp với bộ
// giải nháy của 2.11.0, chỉ ở chiều đọc.
const EVAL_STATUS_NOT_RUN = 'not-run';
function normaliseEvalStatus(v) {
  return unquoteScalar(String(v == null ? '' : v)).trim().toLowerCase();
}
// MỘT nơi quyết định «eval máy đáng ghim»: executor máy VÀ không tự khai là
// không chạy. Bên ĐỌC (machineEvalIds) và bên GHI (repin-lane.mjs) cùng gọi —
// hai bản luật là điều kiện đủ để writer/reader trôi khỏi nhau.
function isRepinMachineEval(e) {
  if (!REPIN_MACHINE_EXECUTORS.includes(String(e.executor || '').trim().toLowerCase())) return false;
  return normaliseEvalStatus(e.status) !== EVAL_STATUS_NOT_RUN;
}

function loadEvalYaml() {
  try { return require(path.join(__dirname, 'eval-yaml.cjs')); } catch (_) { return null; }
}

// ids of evals whose executor is machine-run (test/script) AND not self-
// declared not-run, in file order. Null when the shared parser is not
// vendored next to this file — the caller fails closed instead of guessing.
function machineEvalIds(evalsText) {
  const ey = loadEvalYaml();
  if (!ey) return null;
  return ey.parseEvals(evalsText, ['executor', 'status']).filter(isRepinMachineEval).map(e => e.id);
}
// Id bị loại vì tự khai không chạy — pin phải NÓI RA chúng, không được im.
function machineEvalIdsSkipped(evalsText) {
  const ey = loadEvalYaml();
  if (!ey) return null;
  return ey.parseEvals(evalsText, ['executor', 'status'])
    .filter(e => REPIN_MACHINE_EXECUTORS.includes(String(e.executor || '').trim().toLowerCase()))
    .filter(e => normaliseEvalStatus(e.status) === EVAL_STATUS_NOT_RUN)
    .map(e => e.id);
}

// Hai vế, theo tiền lệ mã thoát mong đợi đã khai (ADR 0016): một ô chỉ được loại khi hồ sơ
// khai VÀ báo cáo đã ký không mang mã thoát nào cho nó. Thiếu vế hai thì «thêm
// một dòng khai» thành đường né đo — một hồ sơ đã ký có mã thoát THẬT cho một
// eval, rồi ai đó thêm `status: not-run` vào evals.yaml, sẽ ghim lại XANH mà
// không ai đối chiếu gì với vật đã ký trước đó.
//
// Trả HAI kết luận TÁCH BẠCH, không một mảng id: `xungDot` = ô bị loại mà báo
// cáo đã ký CÓ mã thoát cho chính nó · `khongDoiChieuDuoc` = ô bị loại mà không
// có văn bản báo cáo đã ký nào để đối chiếu. Bản đầu trả `[]` cho vế sau (rà
// cuối 12/09/2026) — fail-OPEN, trái luật sinh đôi của nó (mã thoát mong đợi,
// ADR 0016) vốn fail-CLOSED ở đúng nhánh đó: bên gọi ba đối số (bản
// recheck-evidence.cjs / pre-merge-check.sh của repo tiêu thụ chưa chép tệp
// mới) sẽ tắt lưới LẶNG ở đúng kho lưới sinh ra để cứu. Hồ sơ KHÔNG có ô bị
// loại nào thì cả hai vế rỗng — vắng báo cáo không tự sinh vi phạm.
function notRunConflicts(evalsText, reportText) {
  const skipped = machineEvalIdsSkipped(evalsText);
  if (!skipped || !skipped.length) return { xungDot: [], khongDoiChieuDuoc: [] };
  if (reportText == null) return { xungDot: [], khongDoiChieuDuoc: skipped.slice() };
  const signed = extractEvalBlockExits(reportText);
  return { xungDot: skipped.filter(id => signed.has(id)), khongDoiChieuDuoc: [] };
}

// entry: the parsed repin line that backs verified_commit (sha == vc);
// evalsText: evals.yaml content, or null when the file is missing; slug for
// the message; reportText (NEW, optional) is the committed evidence-report.md
// text this lane is signing for. Returns { errs } — messages carry NO prefix
// so recheck ("REPIN x ") and pre-merge ("VIOLATION [slug]: ") print one text.
//
// Luật hai vế (owner, hồ sơ eval-khai-ma-thoat-mong-doi 2026-09-09): một mã
// thoát KHÁC 0 chỉ chống lưng được pin khi ĐỦ HAI VẾ — (a) evals.yaml đã KHAI
// đúng mã đó (đọc qua lib/eval-yaml.cjs#expectedExits — gọi hàm dùng chung,
// không tự đọc trường ở đây), VÀ
// (b) báo cáo ĐÃ KÝ (## Evidence, khối `- eval: <id>`) đã ghi ĐÚNG mã đó
// trước khi làn này chạy — nếu không, mã khác 0 mới xuất hiện chính là tiền
// đề vừa mất, không phải giới hạn đã người ký nhận. Thiếu MỘT vế = fail-open
// (chỉ cần sửa dòng khai của hồ sơ đã ký là làn xanh lại). reportText VẮNG
// (bên gọi cũ chưa truyền, hoặc lib/eval-yaml.cjs không nạp được) đi thẳng
// nhánh fail-closed — coi như vế hai không kiểm được, đỏ như luật trước khi
// có luật hai vế (đường đọc-cũ an toàn cho repo tiêu thụ chưa chép tệp mới).
function checkRepinEvals(entry, evalsText, slug, reportText) {
  const id = entry.run_id; const sha = entry.sha;
  const ts = typeof entry.ts === 'string' ? entry.ts : '?';
  const errs = [];
  if (evalsText == null) {
    errs.push(`re-pin lane "${id}" backs verified_commit ${sha} but _acceptance/${slug}/evals.yaml is missing — nothing to prove the pin against`);
    return { errs };
  }
  const ex = entry.evals_exit;
  if (ex === undefined) {
    errs.push(`re-pin lane "${id}" (ts ${ts}) backs verified_commit ${sha} but recorded no evals_exit — a suite-only lane proves the repo's suites, not this slug's evals; run feature-loop/scripts/repin-lane.mjs (it re-runs evals.yaml's test/script evals at HEAD), do not hand-write the line`);
    return { errs };
  }
  if (!ex || typeof ex !== 'object' || Array.isArray(ex)) {
    errs.push(`re-pin lane "${id}" evals_exit is not an object of {evalId: exit} — malformed lane line; run a NEW lane`);
    return { errs };
  }
  const ids = machineEvalIds(evalsText);
  if (ids === null) {
    errs.push(`cannot list machine evals for re-pin lane "${id}": lib/eval-yaml.cjs is not vendored next to evidence-core.cjs — copy the full INIT-CI-COPY-LIST`);
    return { errs };
  }
  const has = i => Object.prototype.hasOwnProperty.call(ex, i);
  const missing = ids.filter(i => !has(i));
  if (missing.length) errs.push(`re-pin lane "${id}" evals_exit lacks eval(s) ${missing.join(', ')} declared in evals.yaml (executor test/script) — the lane did not re-run them at ${sha}; run a NEW lane`);
  const boQua = machineEvalIdsSkipped(evalsText) || [];
  // Ô bị loại KHÔNG còn đi qua vòng chấm mã thoát dưới (nó rời khỏi `ids`), nên
  // một mã đỏ ghi cho chính nó sẽ không ai soi — răng đang sống bị gỡ lặng
  // (rà cuối 12/09/2026). Làn thật không bao giờ ghi khoá cho ô nó không đo:
  // một dòng pin như vậy là vật viết tay hoặc do một writer đã trôi.
  const doTrongOBoQua = boQua.filter(i => has(i) && ex[i] !== 0);
  if (doTrongOBoQua.length) errs.push(`re-pin lane "${id}" evals_exit mang mã thoát khác 0 cho ${doTrongOBoQua.map(i => `${i}=${JSON.stringify(ex[i])}`).join(', ')} mà evals.yaml khai không-chạy — ô khai không-chạy không được mang mã đỏ chống lưng một pin; chạy làn MỚI (làn không ghi mã cho ô nó không đo), đừng viết tay dòng pin`);
  const { xungDot, khongDoiChieuDuoc } = notRunConflicts(evalsText, reportText);
  if (xungDot.length) errs.push(`re-pin lane "${id}" bỏ qua eval ${xungDot.join(', ')} vì evals.yaml khai không-chạy, NHƯNG báo cáo đã ký có mã thoát cho chính eval đó — hai vế mâu thuẫn; sửa hồ sơ rồi chạy làn MỚI`);
  if (khongDoiChieuDuoc.length) errs.push(`re-pin lane "${id}" bỏ qua eval ${khongDoiChieuDuoc.join(', ')} vì evals.yaml khai không-chạy, NHƯNG không đối chiếu được vế hai — không có văn bản báo cáo đã ký để soi (bên gọi không truyền reportText, hoặc evidence-report.md vắng); fail-closed như luật mã thoát mong đợi (ADR 0016): chép đủ INIT-CI-COPY-LIST rồi chạy lại, đừng tin lời khai một vế`);
  const ey = loadEvalYaml();
  const expected = (ey && typeof ey.expectedExits === 'function')
    ? ey.expectedExits(evalsText).byId
    : new Map();
  const signed = reportText == null ? null : extractEvalBlockExits(reportText);
  const red = [];
  for (const i of ids) {
    if (!has(i)) continue;
    const got = ex[i];
    if (got === 0) continue;
    const want = expected.get(i) || 0;
    if (want === 0) {
      red.push(`${i}=${JSON.stringify(got)} (chưa khai: evals.yaml không khai mã thoát mong đợi cho eval này)`);
      continue;
    }
    if (got !== want) {
      red.push(`${i}=${JSON.stringify(got)} (khai ${want}, làn trả ${got} — lệch mã đã khai)`);
      continue;
    }
    if (signed == null) {
      red.push(`${i}=${JSON.stringify(got)} (không đọc được báo cáo đã ký để đối chiếu — vế hai của luật không kiểm được)`);
      continue;
    }
    if (signed.get(i) !== want) {
      red.push(`${i}=${JSON.stringify(got)} (tiền đề vừa mất: báo cáo đã ký ghi ${signed.has(i) ? signed.get(i) : 'không ghi mã nào'}, làn nay trả ${got} — một mã khác 0 MỚI xuất hiện chưa ai ký nhận)`);
    }
  }
  if (red.length) errs.push(`re-pin lane "${id}" evals_exit không đạt kỳ vọng đã khai cho ${red.join(', ')} — sửa rồi chạy làn MỚI`);
  return { errs };
}

// evalsPath: absolute/relative path to a slug's evals.yaml. Returns the
// content of the evidence-report.md sitting next to it (same dir), or null
// when absent/unreadable. Callers of checkRepinEvals that only have the
// evals.yaml path (pre-merge-check.sh's inline reader) use this instead of
// reading the file themselves — one rule, one file-read, both live here so
// the two call sites (pre-merge-check.sh, recheck-evidence.cjs) cannot drift.
// recheck-evidence.cjs already holds the report text in memory (it IS the
// file being rechecked) and passes it straight through instead.
function readSignedReportFor(evalsPath) {
  try {
    const reportPath = String(evalsPath).replace(/evals\.yaml$/, 'evidence-report.md');
    return fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : null;
  } catch (_) { return null; }
}

// run_ids claimed INSIDE eval blocks (`- eval: <id>` + indented fields) —
// section citations (run_id at column 0 in ### Re-pin) are deliberately NOT
// collected here: they are lane citations, validated by the repin rule.
function extractEvalBlockRunIds(payload) {
  const ids = [];
  let inBlock = false;
  for (const line of String(payload).split('\n')) {
    if (/^\s*-\s+eval\s*[:=]/i.test(line)) { inBlock = true; continue; }
    if (inBlock && !/^\s+\S/.test(line)) inBlock = false; // dedent/blank/heading ends the block
    if (!inBlock) continue;
    const m = line.match(/^\s+run_id\s*[:=]\s*(.+?)\s*$/i);
    if (!m) continue;
    const val = m[1].replace(/\s+#.*$/, '').trim().replace(/^["']+|["']+$/g, '').trim();
    if (val) ids.push(val);
  }
  return ids;
}

// MỘT biểu thức nhận diện một dòng mã thoát (bất kể trong hay ngoài khối
// eval). Một dòng ĐƯỢC TÍNH LÀ khai mã thoát của khối đang mở chỉ khi từ khoá
// là TOKEN ĐẦU TIÊN sau khoảng trắng đầu dòng — một dòng ghi chú tự do chỉ
// NHẮC tới cụm này giữa câu ("note: last run had exit_code: 9 (stale,
// ignore)") không thoả điều kiện đó nên không bao giờ bị đọc nhầm thành mã
// thoát THẬT của eval đang mở (S4, hồ sơ eval-khai-ma-thoat-mong-doi
// 2026-09-09: đúng phân kỳ này từng khiến một báo cáo PASS hợp lệ bị chặn
// nhầm vì một dòng ghi chú lẫn trong khối). Ngoài mọi khối eval thì không có
// gì để đối chiếu — bất kỳ dòng nào khớp biểu thức (dù từ khoá không đứng
// đầu) đều là một lời khai mã thoát lạc chỗ và bị tính là vi phạm.
//
// Cờ TOÀN CỤC (g) là bắt buộc: MỘT dòng có thể mang NHIỀU khớp (vd một dòng
// trường thật rồi một cụm mã thoát khác lẫn trong ngoặc/ghi chú cuối cùng
// dòng). Không có cờ g, `line.match()` chỉ trả khớp ĐẦU TIÊN mỗi dòng nên mọi
// khớp còn lại trên cùng dòng — dù mang mã KHÁC 0 — biến mất hoàn toàn khỏi
// cả `outside` lẫn `violations` (S4, hồ sơ eval-khai-ma-thoat-mong-doi
// 2026-09-09, lượt soi toàn nhánh: ba hình dạng lọt vì thiếu đúng cờ này).
const EXIT_LINE_RE = /(?:exit_code|verifier_exit_code|exit)\s*[:=]\s*(-?\d+)\b/gi;

// MỘT lượt đi khối, MỘT biểu thức, HAI cách nhìn — trả về CẢ HAI thứ mà L1
// CONSISTENCY và luật hai vế của re-pin cần, để chúng không còn tự dựng lối
// đi khối RIÊNG rồi trôi khỏi nhau (đó chính là lỗ mà hồ sơ
// eval-khai-ma-thoat-mong-doi 2026-09-09 phát hiện: L1 CONSISTENCY từng có
// vòng lặp thứ hai dùng biểu thức KHÔNG neo đầu dòng). Cùng lối đi khối với
// extractEvalBlockRunIds: `- eval: <id>` mở khối, dòng đầu tiên không thụt
// đóng khối.
//
// HAI đường, không ba (đảo lại một phép nới SAI đã yêu cầu ở vòng trước: một
// dòng ghi chú tự do chứa cụm mã thoát bên trong khối KHÔNG còn được tha —
// hợp đồng chỉ cho đúng MỘT ngoại lệ, dòng trường thật neo đầu dòng):
//   byEval     — Map<evalId, mã thoát[]> DANH SÁCH mọi mã ghi trong khối của
//                từng eval, theo đúng thứ tự xuất hiện: mỗi khớp EXIT_LINE_RE
//                mà từ khoá neo ngay đầu phần không-trắng của dòng (token đầu
//                dòng, sau khoảng trắng đầu dòng) được gom vào danh sách của
//                khối đang mở. MỘT dòng chỉ có ĐÚNG MỘT vị trí neo đầu dòng
//                (khớp đầu tiên của dòng nếu nó đứng ở đó) nên tối đa MỘT
//                phần tử của danh sách tới từ mỗi dòng — đây là MỘT ngoại lệ
//                duy nhất hợp đồng cho phép, lặp lại trên nhiều dòng của cùng
//                khối thì gom thành danh sách thay vì để dòng SAU ghi đè dòng
//                TRƯỚC (S4, eval-khai-ma-thoat-mong-doi 2026-09-09, lượt soi
//                toàn nhánh: `Map.set` ghi đè từng khiến một mã khác 0 ở dòng
//                đầu biến mất khi dòng sau trong cùng khối cũng neo đầu dòng).
//   outside    — mảng các mã thoát KHÁC 0 khớp EXIT_LINE_RE nằm ngoài mọi
//                khối eval, theo đúng thứ tự xuất hiện (MỌI khớp trên một
//                dòng, không chỉ khớp đầu tiên).
//   violations — mảng {evalId, code, line} cho MỌI khớp EXIT_LINE_RE TRONG
//                khối mang mã KHÁC 0 mà từ khoá KHÔNG neo đầu dòng — dấu gạch
//                đầu dòng chen trước ("  - exit_code: 9"), lệch thụt lề, hay
//                nằm giữa một câu văn xuôi hoặc sau dòng trường thật trên
//                CÙNG dòng ("exit_code: 0 (truoc do exit_code: 7)") đều CÙNG
//                một hình dạng vi phạm, không còn phân biệt theo "trông giống
//                trường thật" hay "trông giống ghi chú" — thứ duy nhất phân
//                biệt là VỊ TRÍ neo, không phải nội dung xung quanh. Cùng bộ
//                lọc "khác 0" như `outside`: L1 CONSISTENCY chỉ soi mã THẤT
//                BẠI — một mã 0 lạc chỗ (vd "... exit=0 ...") không tố cáo
//                điều gì nên không phải vi phạm (corpus thật, hồ sơ
//                lenh-tran-tai-lieu-dau-tay, có đúng hình dạng này ở một ghi
//                chú vô hại).
function walkEvalExits(payload) {
  const byEval = new Map();
  const outside = [];
  const violations = [];
  let cur = null;
  for (const line of String(payload).split('\n')) {
    const open = line.match(/^\s*-\s+eval\s*[:=]\s*(.+?)\s*$/i);
    if (open) { cur = open[1].replace(/\s+#.*$/, '').trim().replace(/^["']+|["']+$/g, '').trim(); continue; }
    if (cur && !/^\s+\S/.test(line)) cur = null;
    const leading = line.length - line.trimStart().length;
    // MỌI khớp trên dòng, không chỉ khớp đầu — cờ g trên EXIT_LINE_RE cho
    // phép matchAll đi hết dòng thay vì dừng ở khớp đầu tiên.
    for (const m of line.matchAll(EXIT_LINE_RE)) {
      const code = Number(m[1]);
      if (cur) {
        if (m.index === leading) {
          if (!byEval.has(cur)) byEval.set(cur, []);
          byEval.get(cur).push(code); // neo đầu dòng — GOM vào danh sách, không ghi đè
        } else if (code !== 0) {
          violations.push({ evalId: cur, code, line }); // mọi hình dạng khác, mã khác 0 — vi phạm
        }
      } else if (code !== 0) {
        outside.push(code);
      }
    }
  }
  return { byEval, outside, violations };
}

// Mã thoát ghi TRONG khối của từng eval — MỘT giá trị mỗi eval (chữ ký +
// hành vi cũ, vì checkRepinEvals so sánh trực tiếp `signed.get(i) !== want`).
// walkEvalExits nay trả DANH SÁCH mã cho mỗi khối (một khối HIẾM khi nhưng CÓ
// THỂ mang nhiều dòng neo đầu dòng); rút gọn về một giá trị phải chọn AN TOÀN
// (fail-closed) chứ không phải "dòng cuối thắng" như bug cũ: ưu tiên mã KHÁC
// 0 ĐẦU TIÊN trong danh sách — một mã khác 0 gần như chắc chắn LỆCH mã đã
// khai (`want`) nên khiến checkRepinEvals đỏ đúng hướng; chỉ khi mọi mã trong
// khối đều là 0 mới trả 0. Dùng cho luật hai vế của re-pin và (gián tiếp, qua
// walkEvalExits) cho L1 CONSISTENCY.
function extractEvalBlockExits(payload) {
  const byEvalLists = walkEvalExits(payload).byEval;
  const out = new Map();
  for (const [evalId, codes] of byEvalLists) {
    const nonZero = codes.find(c => c !== 0);
    out.set(evalId, nonZero !== undefined ? nonZero : 0);
  }
  return out;
}

// Set of run_ids the machinery logged, or null when no log exists (older
// flow — tolerated; pre-merge NOTEs it). Malformed lines are skipped.
function loadRunLogIds(fileDir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(fileDir, 'run-log.jsonl'), 'utf8');
  } catch (_) {
    return null;
  }
  const ids = new Set();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.run_id === 'string' && entry.run_id) ids.add(entry.run_id);
    } catch (_) { /* skip malformed line */ }
  }
  return ids;
}

// ─── Observed inspection (L2 OBSERVED — schema v2+) ────────────────────────

// A `screenshot:` in an evidence block proves a frame was SAVED; `observed:`
// proves someone LOOKED at it. From template schema_version 2, every
// screenshot-bearing block in a PASS-family report must describe what is
// visible in the frames (>= OBSERVED_MIN_CHARS substantive chars after
// stripping {{...}} placeholders, comments and YAML block markers). Older
// reports (schema < 2 / absent) are tolerated here — pre-merge-check.sh NOTEs
// them instead.
const OBSERVED_MIN_CHARS = 20;

function evaluateObserved(payload) {
  const failures = [];
  const sv = parseInt(frontmatterField(payload, 'schema_version') || '', 10);
  if (!(sv >= 2)) return failures;
  const lines = String(payload).split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*-\s+eval\s*[:=]/i.test(lines[i])) starts.push(i);
  }
  for (let b = 0; b < starts.length; b++) {
    const block = lines.slice(starts[b], b + 1 < starts.length ? starts[b + 1] : lines.length);
    if (!block.some(l => /^\s*screenshot\s*[:=]/i.test(l))) continue;
    const evalId = (block[0].match(/^\s*-\s+eval\s*[:=]\s*(\S+)/i) || [])[1] || `#${b + 1}`;
    let content = null;
    for (let i = 0; i < block.length; i++) {
      const m = block[i].match(/^\s*observed\s*[:=]\s*(.*)$/i);
      if (!m) continue;
      // Inline value: whitespace+# starts a real YAML comment — not content.
      const parts = [m[1].replace(/(^|\s)#.*$/, '')];
      // Continuation lines end at the first non-blank line NOT indented deeper
      // than the observed: key (YAML block-scalar semantics). A word:-shaped
      // content line ("step1: form hien thi...") is NOT a terminator.
      const keyIndent = block[i].match(/^\s*/)[0].length;
      for (let j = i + 1; j < block.length; j++) {
        const ln = block[j];
        if (!ln.trim()) continue;                         // blank line inside block scalar
        if (ln.match(/^\s*/)[0].length <= keyIndent) break; // dedent = next field/block
        // Whole-line # doesn't count; mid-line # is literal block-scalar
        // content (e.g. a CSS selector "#main-nav") — keep it.
        if (!/^\s*#/.test(ln)) parts.push(ln);
      }
      content = parts.join(' ');
      break;
    }
    const substantive = (content || '')
      .replace(/\{\{[^}]*\}\}/g, '')   // template placeholders don't count (may span joined lines)
      .replace(/[|>]/g, ' ')           // YAML block markers
      .trim();
    if (substantive.length < OBSERVED_MIN_CHARS) {
      failures.push(
        `eval ${evalId}: screenshot evidence without substantive observed: ` +
        `(${content === null ? 'field missing' : 'placeholder/too short'}) — ` +
        `the verifier must OPEN each saved frame (multimodal Read) and describe what is visible vs expected`
      );
    }
  }
  return failures;
}

// ─── Verifier extraction & authenticity ────────────────────────────────────

function extractVerifierValues(payload) {
  // NOTE: `verified_by:` is deliberately NOT in this list — the report
  // template uses it for agent attribution, not as an evidence verifier.
  const values = [];
  const KEY_RE = /^\s*(?:-\s+)?(verifier|checked_by)\s*[:=]\s*(.+?)\s*$/i;
  for (const line of payload.split('\n')) {
    const m = line.match(KEY_RE);
    if (!m) continue;
    let val = m[2].replace(/\s+#.*$/, '').trim().replace(/^["']+|["']+$/g, '').trim();
    if (val) values.push(val);
  }
  return values;
}

function findGitRoot(startDir) {
  let cur = startDir;
  while (cur && cur !== path.dirname(cur)) {
    try {
      if (fs.existsSync(path.join(cur, '.git'))) return cur;
    } catch (_) {}
    cur = path.dirname(cur);
  }
  return null;
}

function isAuthenticVerifier(value, fileDir, configPath, configText) {
  const configRef = value.match(/^config:([\w.-]+)$/);
  if (configRef) {
    if (!configText) {
      return { ok: false, reason: `verifier "${value}" but no _acceptance/config.yaml found` };
    }
    const resolved = resolveConfigKey(configText, configRef[1]);
    if (resolved) return { ok: true, resolved: `${configPath} :: ${configRef[1]} = ${resolved}` };
    return { ok: false, reason: `config key not found or empty: "${configRef[1]}" in ${configPath} (note: the parser requires 2-space indentation in config.yaml)` };
  }

  const scriptMatch = value.match(/(\S+\.(py|mjs|js|sh))\b/);
  if (scriptMatch) {
    const rawPath = scriptMatch[1].replace(/^["']+|["']+$/g, '');
    const candidates = [];
    if (path.isAbsolute(rawPath)) {
      candidates.push(rawPath);
    } else {
      if (fileDir) {
        candidates.push(path.resolve(fileDir, rawPath));
        const gitRoot = findGitRoot(fileDir);
        if (gitRoot) candidates.push(path.resolve(gitRoot, rawPath));
      }
      candidates.push(path.resolve(process.cwd(), rawPath));
    }
    for (const c of candidates) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return { ok: true, resolved: c };
      } catch (_) {}
    }
    // Unresolvable script path: fall through to the blocklist check so a
    // free-text value like "manual review.sh notes" still gets the clearer
    // manual-verifier message when applicable.
    const MANUAL_RE = /\b(manual|human|heuristic|cross-reference|eyeball|interpret(ation)?|persona\s+rubric|llm\s+rubric|llm[-\s]as[-\s]judge)\b/i;
    if (MANUAL_RE.test(value)) {
      return { ok: false, reason: `manual/heuristic verifier disallowed: "${value}"` };
    }
    return {
      ok: false,
      reason: `verifier script not found. raw: ${rawPath}; tried:\n` +
        candidates.map(c => `      ${c}`).join('\n'),
    };
  }

  const MANUAL_RE = /\b(manual|human|heuristic|cross-reference|eyeball|interpret(ation)?|persona\s+rubric|llm\s+rubric|llm[-\s]as[-\s]judge)\b/i;
  if (MANUAL_RE.test(value)) {
    return { ok: false, reason: `manual/heuristic verifier disallowed: "${value}"` };
  }
  return { ok: false, reason: `verifier is neither config:<key> nor a script path (.py/.sh/.js): "${value}"` };
}

// ─── Verdict / enforcement determination ───────────────────────────────────

// Does this payload claim a PASS-family verdict (so the evidence bar applies)?
// Reads the leading frontmatter verdict; falls back to an anti-evasion scan when
// no frontmatter verdict exists.
function determineEnforce(payload) {
  let overall = null;
  const fmMatch = payload.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const vm = fmMatch[1].match(/^verdict\s*[:=]\s*([A-Za-z-]+)\s*$/m);
    if (vm) overall = vm[1].toUpperCase();
  }
  if (overall) return PASS_FAMILY.test(overall);
  const CLAIM_RE = /(?:^|\n)\s*(?:-\s+)?verdict\s*[:=]\s*(PASS|PASSED|ACCEPTED|APPROVED|GO|SUCCESS)\b/i;
  const CHECKMARK_RE = /✅\s*(PASS|PASSED|ACCEPTED|APPROVED|GO|SUCCESS)/i;
  return CLAIM_RE.test(payload) || CHECKMARK_RE.test(payload);
}

// ─── The shared evidence evaluation (assumes the report is PASS-family) ─────

// Returns { missing[], consistencyFailure, authFailures[], judgmentFailure, anyFailure }.
// Caller decides what to do with it (block / warn / report). Does NOT read
// enforcement mode or honor bypass — those are caller policy.
function evaluateEvidence(payload, opts) {
  opts = opts || {};
  const fileDir = opts.fileDir || null;
  const configText = opts.configText || null;
  const configPath = opts.configPath || null;

  const FAILED_JUDGMENT_RE = /verdict\s*[:=]\s*FAIL\b/i;

  // L1 CONSISTENCY — một PASS thật không chứa eval trượt. Ngoại lệ DUY NHẤT:
  // mã khác 0 nằm TRONG khối của đúng eval đã khai đúng mã ấy, TRÊN MỘT dòng
  // trường thật neo đầu dòng (giới hạn đã khai, không phải một lượt trượt).
  // Mọi mã khác 0 còn lại — ngoài khối, lệch mã, của eval không khai, hoặc
  // trong khối nhưng không neo đầu dòng (dù trông giống trường thật lệch
  // định dạng hay lẫn trong văn xuôi) — vẫn là vi phạm. (Đảo lại một phép nới
  // SAI đã yêu cầu ở vòng trước: hợp đồng không có rổ "ghi chú được tha".)
  const declared = (() => {
    if (!fileDir) return new Map();
    const ey = loadEvalYaml();
    if (!ey || typeof ey.expectedExits !== 'function') return new Map();
    try {
      const txt = fs.readFileSync(path.join(fileDir, 'evals.yaml'), 'utf8');
      const r = ey.expectedExits(txt);
      return r.errs.length ? new Map() : r.byId;   // khai sai → không tha gì cả
    } catch (_) { return new Map(); }
  })();
  // MỘT lượt đi khối dùng chung (walkEvalExits — cũng là nguồn của
  // extractEvalBlockExits) thay vì tự dựng lối đi khối RIÊNG ở đây: đó chính
  // là lỗ đã trôi khỏi nhau trước khi vá (S4, eval-khai-ma-thoat-mong-doi
  // 2026-09-09). `outside` đã lọc sẵn mã 0; `byEval` giữ DANH SÁCH mọi mã (kể
  // cả 0) của mỗi khối nên ở đây tự lọc `code !== 0` trước khi xét vi phạm —
  // MỘT khối chỉ được tha khi MỌI mã khác 0 trong danh sách của nó đều bằng
  // đúng mã đã khai; một mã khác 0 nào KHÁC trong cùng khối (dòng trước bị
  // dòng sau ghi đè ở bug cũ) vẫn là vi phạm độc lập. `violations` là MỌI
  // khớp TRONG khối mà từ khoá không neo đầu dòng — fail-CLOSED, không được
  // rơi mất, và không còn nhánh nào tha nó theo hình dạng.
  const { byEval: blockExits, outside: outsideExits, violations: unanchoredExits } = walkEvalExits(payload);
  let consistencyFailure = null;
  {
    const viPham = [];
    for (const code of outsideExits) {
      viPham.push(`mã ${code} ngoài mọi khối eval`);
    }
    for (const { evalId, code, line } of unanchoredExits) {
      viPham.push(
        `eval ${evalId}: dòng "${line.trim()}" mang mã ${code} không neo đầu dòng trong khối — chỉ dòng trường thật neo đầu dòng (vd "exit_code: ${code}") mới được tính là mã thoát của khối; sửa lại đúng thụt lề nếu là trường thật, hoặc bỏ cụm mã thoát khỏi ghi chú/văn xuôi nếu không phải`
      );
    }
    for (const [evalId, codes] of blockExits) {
      for (const code of codes) {
        if (code === 0) continue;
        if (declared.get(evalId) === code) continue;   // giới hạn đã khai
        // declared.has(evalId) — KHÔNG kèm điều kiện giá trị: một eval khai
        // đúng giới hạn 0 vẫn PHẢI đọc ra "khai 0", không phải "chưa khai"
        // (Phát hiện 2 — giá trị 0 là falsy nên phép kiểm cũ
        // `declared.has(x) && declared.get(x)` đọc nhầm nó thành chưa khai).
        viPham.push(`eval ${evalId} (mã ${code}${declared.has(evalId) ? `, khai ${declared.get(evalId)}` : ', chưa khai'})`);
      }
    }
    if (viPham.length) {
      consistencyFailure = `PASS report contains a failed eval (exit_code != 0) — the verdict must be REJECT: ${viPham.join('; ')}`;
    } else if (FAILED_JUDGMENT_RE.test(payload)) {
      consistencyFailure = 'PASS report contains a failed judgment (verdict: FAIL) — the verdict must be REJECT';
    }
  }

  // L1 SHAPE
  const HAS_RUN_ID = /run_id\s*[:=]\s*\S{4,}/i.test(payload);
  // Một hồ sơ mà MỌI eval máy đều khai mã khác 0 không thể có dòng exit_code: 0
  // nào. Điều kiện hình dạng thoả bằng một dòng mã thoát ĐÚNG kỳ vọng đã khai.
  const HAS_EXIT_ZERO = /(exit_code|verifier_exit_code|exit)\s*[:=]\s*0\b/i.test(payload)
    || [...blockExits].some(([evalId, codes]) => codes.some(code => code !== 0 && declared.get(evalId) === code));
  const HAS_VERIFIED_AT = /verified_at\s*[:=]\s*\d{4}-\d{2}-\d{2}/i.test(payload);
  const verifierValues = extractVerifierValues(payload);
  const HAS_VERIFIER = verifierValues.length > 0;

  const missing = [];
  if (!HAS_RUN_ID) missing.push('run_id: <id from verifier stdout>');
  if (!HAS_EXIT_ZERO) missing.push('exit_code: 0');
  if (!HAS_VERIFIER) missing.push('verifier: <script path or config:executors.<type>.<surface>>');
  if (!HAS_VERIFIED_AT) missing.push('verified_at: <ISO8601>');

  // verified_commit — PRESENCE-BASED (backward-tolerant): a report without the
  // field (older template) is not penalized here (pre-merge NOTEs it instead);
  // when present it must be a real git SHA so the evidence is pinned to the
  // exact tree that was verified.
  const verifiedCommit = frontmatterField(payload, 'verified_commit');
  if (verifiedCommit !== null && verifiedCommit !== '' && !/^[0-9a-f]{7,40}$/i.test(verifiedCommit)) {
    missing.push(`verified_commit: <git SHA from \`git rev-parse HEAD\`> — found "${verifiedCommit}" (not a 7-40 char hex SHA)`);
  }

  // L2 SUBSTANCE
  const authFailures = [];
  for (const v of verifierValues) {
    const r = isAuthenticVerifier(v, fileDir, configPath, configText);
    if (!r.ok) authFailures.push(r.reason);
  }

  // L3 JUDGMENT — UNCERTAIN must be human-resolved before overall PASS.
  const uncertainCount = (payload.match(/verdict\s*[:=]\s*UNCERTAIN\b/gi) || []).length;
  const overrideCount = (payload.match(/human_override\s*[:=]\s*[^#\s]/gi) || []).length;
  let judgmentFailure = null;
  if (uncertainCount > overrideCount) {
    judgmentFailure = `${uncertainCount} UNCERTAIN judgment(s) but only ${overrideCount} human_override(s) — a human must resolve each UNCERTAIN before overall PASS`;
  }
  // T3 contracts: EVERY judgment item needs a direct human verdict, regardless
  // of what the judge said. Tier comes from the sibling contract.
  if (!judgmentFailure && fileDir) {
    let tier = null;
    try {
      const contract = fs.readFileSync(path.join(fileDir, 'contract.md'), 'utf8');
      const tm = contract.match(/^risk_tier\s*[:=]\s*["']?(T[123])["']?\s*(#.*)?$/mi);
      if (tm) tier = tm[1].toUpperCase();
    } catch (_) {}
    if (tier === 'T3') {
      const judgedCount = (payload.match(/judged_by\s*[:=]\s*\S+/gi) || []).length;
      if (judgedCount > overrideCount) {
        judgmentFailure = `risk_tier T3: ${judgedCount} judgment item(s) but only ${overrideCount} human_override(s) — T3 requires a direct human verdict on every judgment eval`;
      }
    }
  }

  // L2 PROVENANCE — presence-based on the LOG file: when the verify machinery
  // wrote run-log.jsonl next to this report, every run_id the report claims
  // must appear in it. No log (older flow) → tolerated; pre-merge NOTEs it.
  let runLogFailure = null;
  if (fileDir) {
    const logIds = loadRunLogIds(fileDir);
    if (logIds) {
      const unlogged = extractRunIds(payload).filter(id => !logIds.has(id));
      if (unlogged.length) {
        runLogFailure = `run_id(s) not found in run-log.jsonl (machine-written at verify time): ${[...new Set(unlogged)].join(', ')} — this evidence was not produced by a logged verify run; re-verify, do not hand-mint run_ids`;
      }
      if (!runLogFailure) {
        const repinIds = loadRepinRunIds(fileDir);
        if (repinIds && repinIds.size) {
          const borrowed = extractEvalBlockRunIds(payload).filter(id => repinIds.has(id));
          if (borrowed.length) {
            runLogFailure = `eval evidence cites re-pin lane run_id(s): ${[...new Set(borrowed)].join(', ')} — a {"kind":"repin"} line backs a ### Re-pin signature, never an eval block; re-verify, do not borrow lane ids`;
          }
        }
      }
    }
  }

  // L2 OBSERVED — schema v2+ only (backward-tolerant; see evaluateObserved).
  const observedFailures = evaluateObserved(payload);

  const anyFailure = missing.length > 0 || authFailures.length > 0 || !!judgmentFailure || !!consistencyFailure || !!runLogFailure || observedFailures.length > 0;
  return { missing, consistencyFailure, authFailures, judgmentFailure, runLogFailure, observedFailures, anyFailure };
}

// ─── Contract transition guard (Gate-1 integrity) ──────────────────────────

// A contract may only be SET to approved/signed-off — or jump from draft (or a
// brand-new file) straight to implemented/verified — when Gate 1 is recorded
// (approved_by non-empty) or explicitly skipped (gate1_skipped: true, the
// audited escape hatch the skill already documents). Judges the POST-WRITE
// content; oldPayload (the pre-write file, null when creating) supplies the
// Trạng thái V — «máy đã đi trước, owner chưa veto» (hồ sơ veto-co-dau-vet,
// đợt 2 bản neo 12/08). KHÁC hẳn gate1_skipped: bỏ-cổng nghĩa là người đã
// chủ động miễn cổng; V nghĩa là cổng VẪN MỞ, máy đi trước và người veto lúc
// nào cũng được. Hai vật, hai nghĩa, không thay nhau.
//
// Ba điều kiện để V mở đường, thiếu một là chặn:
//   (a) veto_state: mo          — khoá vắng thì luật cũ chạy NGUYÊN VĂN
//   (b) veto_opened_at đọc được — vết thời gian là một nửa cái tên của cơ
//       chế; không có vết thì đây là bỏ-cổng lặng lẽ, không phải V
//   (c) hạng T2                 — T3 chạm lõi/dữ liệu, LUÔN cần người
function vetoGateState(payload) {
  const raw = (frontmatterField(payload, 'veto_state') || '').trim().toLowerCase();
  if (!raw) return { present: false };
  const openedAt = (frontmatterField(payload, 'veto_opened_at') || '').trim();
  const tier = (frontmatterField(payload, 'risk_tier') || '').trim().toUpperCase();
  // Vết thời gian phải PARSE ĐƯỢC, không chỉ khác rỗng: một chuỗi rác qua
  // được thì NOTE đếm cửa-veto mất khả năng đọc «cửa này mở bao lâu rồi».
  const stamped = openedAt !== '' && !Number.isNaN(Date.parse(openedAt));
  return { present: true, state: raw, openedAt, stamped, tier };
}

function evaluateContractWrite(newPayload, oldPayload) {
  const failures = [];
  const status = (frontmatterField(newPayload, 'status') || '').toLowerCase();
  const approvedBy = frontmatterField(newPayload, 'approved_by') || '';
  const gate1Skipped = /^(true|yes|1)$/i.test(frontmatterField(newPayload, 'gate1_skipped') || '');
  const oldStatus = oldPayload == null ? null : (frontmatterField(oldPayload, 'status') || '').toLowerCase();
  const v = vetoGateState(newPayload);

  // Cửa V chỉ mở khi ĐỦ ba điều kiện; mỗi điều kiện thiếu có thông điệp
  // RIÊNG, vì «chưa khai vết» và «hạng T3» là hai kiểu hỏng khác nhau và
  // gộp chúng thì người đọc log học cách phớt lờ cả hai.
  let vOpen = false;
  if (v.present) {
    if (v.state === 'mo') {
      if (!v.stamped) {
        failures.push(`veto_state: mo but veto_opened_at is ${v.openedAt ? `unreadable ("${v.openedAt}")` : 'missing'} — the V lane REQUIRES a parseable timestamp. Without it this is a silent gate skip, not a traceable veto window. Set veto_opened_at: <ISO-8601>.`);
      } else if (v.tier === 'T3') {
        failures.push(`veto_state: mo on a T3 contract — the V lane is T2-only. T3 touches enforcement core / data / breaking API, so it ALWAYS needs a human at Gate 1: fill approved_by (+ approved_at). This is not overridable by the V lane.`);
      } else {
        vOpen = true;
      }
    } else if (v.state !== 'da-veto') {
      failures.push(`veto_state: "${v.state}" is not a known value — use "mo" (machine went ahead, owner has not vetoed) or "da-veto" (owner vetoed; the run must be resolved before merge).`);
    }
  }

  // duong-lui-phai-song AC-6: «da-veto» có vết + T2 là một lối Cổng-1-ĐÃ-GHI — người đã
  // phát ngôn trên hồ sơ máy-đi-trước; chặn nó ở đây là giết đúng nút dừng của làn V
  // (gap-probe P0: hồ sơ machine-cleared × mo không ghi được da-veto). Vết vẫn bắt buộc
  // (V09), T2-only vẫn giữ (V10).
  // Lối này HẸP đúng bằng ca nó phục vụ (S4-r1 finding, lớp fail-open): chỉ hồ sơ ĐANG ở
  // `verified`/`machine-cleared` với cửa veto ĐANG `mo` trong bản cũ mới được ghi da-veto
  // mà không có approved_by — hồ sơ mới/draft, hay `approved`/`signed-off` (không thuộc
  // làn V), vẫn theo luật cũ: kèm da-veto vào không mua được Cổng 1.
  let vetoRecorded = false;
  if (v.present && v.state === 'da-veto') {
    const oldV = oldPayload == null ? { present: false } : vetoGateState(oldPayload);
    // laneStatus đọc bản CŨ (và bản mới vẫn phải trong làn): lối này mở cho hồ sơ ĐANG
    // ở làn V, KHÔNG phải cho lượt ghi tự đặt mình vào làn V. Bản đầu đọc mỗi `status`
    // mới, nên `draft` + `mo` nhảy thẳng sang `machine-cleared` + `da-veto` với
    // approved_by rỗng và TẮT cả hai răng dưới (mốc 2.10.0 lượt chấm 1 — chú thích ở
    // trên đã hứa «trong bản cũ» từ đầu, chỉ mã là đi lệch). Ca V14/V15 giữ chiều đỏ,
    // V16 giữ đối chứng dương cho đúng lối verified → machine-cleared của làn V.
    const trongLan = (st) => st === 'verified' || st === 'machine-cleared';
    const laneStatus = trongLan(oldStatus) && trongLan(status);
    if (!v.stamped) failures.push(`veto_state: da-veto but veto_opened_at is ${v.openedAt ? `unreadable ("${v.openedAt}")` : 'missing'} — a veto without a timestamp is a silent gate skip. Set veto_opened_at: <ISO-8601>.`);
    else if (v.tier === 'T3') failures.push(`veto_state: da-veto on a T3 contract — the V lane (and its veto) is T2-only; T3 always needs approved_by.`);
    // Bản cũ đang `mo` (người vừa veto) HOẶC đã `da-veto` (ghi lại hồ sơ đang veto: thêm Known
    // limits, sửa lý do, resume lượt bị ngắt) — cả hai đều là Cổng 1 đã có phát ngôn của người
    // (S4-r4 finding: hồ sơ đã veto bị chặn mọi lượt ghi với lý do sai «Gate 1 chưa duyệt»).
    else if (laneStatus && oldV.present && (oldV.state === 'mo' || oldV.state === 'da-veto')) vetoRecorded = true;
  }

  // `machine-cleared` = qua Cổng Bằng chứng KHÔNG có chữ ký người — đó CHÍNH là điều làn V
  // chỉ cho phép ở T2. Răng T2-only phải đứng ở tầng GHI, không chỉ ở lưới trước-merge: T3
  // là «Cổng 2 luôn dừng chờ người», và hai tầng cưỡng chế lệch nhau cho cùng một luật là
  // đúng lớp «hai bản dựng trôi khỏi nhau» mà hồ sơ này sinh ra để giết (S4-r8 [0]). Nhánh
  // veto ở trên chỉ chặn ca đi qua veto_state; ca approved_by ĐÃ điền vẫn lọt.
  const hangMoi = (frontmatterField(newPayload, 'risk_tier') || '').trim().toUpperCase();
  // ALLOWLIST (một giá trị ĐƯỢC PHÉP), không phải blacklist một giá trị bị cấm: viết
  // `=== 'T3'` thì T1, hạng rỗng, hay gõ sai ('TIER3') đều LỌT — và lưới trước-merge chỉ
  // chấm hạng trong REQUIRED_FOR (mặc định «T2 T3») nên hồ sơ T1 còn không được lưới sờ
  // tới lần nào. Lời khai «máy đã thông» khi ấy hoàn toàn không có vật (S4-r11 [1]).
  if (status === 'machine-cleared' && hangMoi !== 'T2') {
    failures.push(`status: machine-cleared on a ${hangMoi || '(empty)'} contract — «machine-cleared» means Gate 2 passed WITHOUT a human signature, and that is T2-ONLY. T3 touches enforcement core / data / breaking API, so Gate 2 ALWAYS stops for a human: use verified, then /acceptance-gate:signoff to reach signed-off.`);
  }

  if (!approvedBy && !gate1Skipped && !vOpen && !vetoRecorded) {
    if (status === 'approved' || status === 'signed-off' || status === 'machine-cleared') {
      failures.push(`status: ${status} with empty approved_by — Gate 1 approval not recorded. Fill approved_by (+ approved_at); only when the user explicitly skips Gate 1, record gate1_skipped: true (audited, pre-merge NOTEs it).`);
    }
    if ((oldStatus === null || oldStatus === 'draft') && (status === 'implemented' || status === 'verified' || status === 'machine-cleared')) {
      failures.push(`status: ${oldStatus === null ? '(new file)' : 'draft'} -> ${status} skips Gate 1 — approved_by is empty and gate1_skipped is not true. Lifecycle: draft -> approved (Gate 1) -> implemented -> verified -> signed-off (Gate 2, human) | machine-cleared (Gate 2, machine-clean, no signature).`);
    }
  }

  return { failures, anyFailure: failures.length > 0 };
}

// `machine-cleared` = «máy thông, KHÔNG chữ ký». Chữ ký người trên hồ sơ này là hai sự
// thật cãi nhau: người đã ký thì status phải là `signed-off` (/signoff đổi cùng lượt).
// Trả thông điệp, hoặc null khi không có mâu thuẫn.
function machineClearedSignoffConflict(contractTxt, evidenceTxt) {
  if (contractTxt == null || evidenceTxt == null) return null;
  const st = (frontmatterField(contractTxt, 'status') || '').trim().toLowerCase();
  const sig = (frontmatterField(evidenceTxt, 'human_signoff') || '').trim();
  if (st !== 'machine-cleared' || !sig) return null;
  return `chữ ký người trên hồ sơ máy-thông — ký thì status phải sang signed-off (human_signoff="${sig}", status=machine-cleared). /signoff đổi status cùng lượt ghi chữ ký.`;
}


// <<<CHU-KY-THAT — MỘT NGUỒN của vị từ «chữ ký thật» (hồ sơ cua-veto-sau-chu-ky,
// đổi khuôn S4-r2 do owner quyết 12/09 tại chốt DỪNG-VÁ).
//
// VÌ SAO: vị từ này từng dựng HAI lần — `placeholder_signoff`+`front_field` trong
// scripts/pre-merge-check.sh (awk/case của bash) và `signoffState` trong
// scripts/start-scan.mjs (regex JS). Hai ngữ pháp lệch nhau trong im lặng: thiếu
// dấu đóng fence thì bên bash đọc tới hết tệp còn bên JS trả null. Hai lượt chấm
// liên tiếp bắt đúng một lớp đó, nên khuôn đổi: ngữ pháp về ĐÂY, hai bộ đọc hỏi.
//
// NGỮ PHÁP (khai tường minh — đây là nơi DUY NHẤT được giữ các luật này):
//   · khối frontmatter bắt đầu ở dòng KHÔNG TRẮNG đầu tiên và dòng đó phải là
//     `---` ở CỘT 0 (cho phép khoảng trắng đuôi);
//   · dấu đóng cũng chỉ tính ở CỘT 0. Một `---` thụt lề là NỘI DUNG, không phải
//     dấu đóng — nên khối chạy tới HẾT TỆP, và ca đó kèm `warn` (đọc được, nhưng
//     hình dạng tệp không chuẩn, người cần biết);
//   · khoá chỉ tính ở CỘT 0 (thụt lề = thân), không phân biệt hoa thường, ngăn
//     bằng `:` hoặc `=`, cho phép khoảng trắng trước dấu ngăn;
//   · giá trị: bỏ chú thích `#…`, bóc CẶP nháy, cắt khoảng trắng;
//   · bảng giữ-chỗ: khớp TIỀN TỐ với 7 từ khoá + `<`, khớp ĐÚNG với `none` và ba
//     ký hiệu `>` `|` `-`. Mọi thứ khác là chữ ký thật (phạm vi hẹp có chủ đích —
//     xem chú thích lịch sử ở placeholder_signoff của lưới trước khi nó gọi vào đây).
const CHU_KY_GIU_CHO = [
  { mau: 'pending', tienTo: true }, { mau: 'tbd', tienTo: true },
  { mau: 'todo', tienTo: true }, { mau: 'n/a', tienTo: true },
  { mau: 'unsigned', tienTo: true }, { mau: 'waiting', tienTo: true },
  { mau: '<', tienTo: true },
  { mau: 'none', tienTo: false }, { mau: '>', tienTo: false },
  { mau: '|', tienTo: false }, { mau: '-', tienTo: false },
];
function laGiuCho(s) {
  const v = String(s == null ? '' : s).trim().toLowerCase();
  if (!v) return false;
  return CHU_KY_GIU_CHO.some(p => (p.tienTo ? v.startsWith(p.mau) : v === p.mau));
}
// { signed, value, placeholder, warn } — `warn` LUÔN có mặt (chuỗi rỗng khi hình
// dạng tệp chuẩn); không bao giờ nuốt im một sự cố đọc.
function chuKyThat(reportText) {
  const ket = (o) => ({ signed: false, value: '', placeholder: false, warn: '', ...o });
  if (reportText == null) return ket({ warn: 'không có evidence-report.md' });
  const dong = String(reportText).split('\n');
  const dau = dong.findIndex(l => l.trim() !== '');
  if (dau < 0 || !/^---[ \t]*\r?$/.test(dong[dau]))
    return ket({ warn: 'frontmatter không dẫn đầu báo cáo' });
  let het = -1;
  for (let i = dau + 1; i < dong.length; i++) {
    if (/^---[ \t]*\r?$/.test(dong[i])) { het = i; break; }
  }
  const warn = het === -1
    ? 'frontmatter thiếu dấu đóng «---» ở cột 0 — đọc tới hết tệp'
    : '';
  const than = dong.slice(dau + 1, het === -1 ? dong.length : het);
  const d = than.find(l => /^human_signoff[ \t]*[:=]/i.test(l));
  if (d === undefined) return ket({ warn });
  const val = d.replace(/^human_signoff[ \t]*[:=]/i, '')
    .replace(/^#.*$/, '').replace(/\s+#.*$/, '').trim();
  const cap = val.match(/^"([\s\S]*)"$/) || val.match(/^'([\s\S]*)'$/);
  const s = (cap ? cap[1] : val).trim();
  if (!s) return ket({ warn });
  if (laGiuCho(s)) return ket({ value: s, placeholder: true, warn });
  return ket({ signed: true, value: s, warn });
}
// CLI cho bên gọi KHÔNG phải JS (scripts/pre-merge-check.sh), cùng nếp
// lib/lop-nhin-thay.cjs: in MỘT dòng tab, exit 0 kể cả khi kết luận là «chưa ký».
//   node lib/evidence-core.cjs chu-ky-that <đường dẫn báo cáo>
//     → "<signed 0|1>\t<placeholder 0|1>\t<value>\t<warn>"
//   node lib/evidence-core.cjs giu-cho <chuỗi>   → "1" hoặc "0"
// Exit 3 = không đọc được tệp (bên gọi phân biệt được với «đọc được, chưa ký»).
if (require.main === module) {
  const [lenh, arg] = process.argv.slice(2);
  const mot = s => String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ');
  if (lenh === 'chu-ky-that') {
    let txt;
    try { txt = require('fs').readFileSync(arg, 'utf8'); }
    catch { process.exit(3); }
    const r = chuKyThat(txt);
    process.stdout.write(`${r.signed ? 1 : 0}\t${r.placeholder ? 1 : 0}\t${mot(r.value)}\t${mot(r.warn)}\n`);
    process.exit(0);
  }
  if (lenh === 'giu-cho') { process.stdout.write(laGiuCho(arg) ? '1\n' : '0\n'); process.exit(0); }
  // `bang-mau` để câu NOTE của lưới KỂ TÊN bảng mà không chép bảng: một danh sách
  // gõ tay trong văn xuôi cũng là bản sao, và nó trôi im lặng y như mã.
  if (lenh === 'bang-mau') {
    process.stdout.write(CHU_KY_GIU_CHO.map(p => p.mau + (p.tienTo ? '*' : '')).join(', ') + '\n');
    process.exit(0);
  }
  process.stderr.write('evidence-core: lệnh lạ — dùng chu-ky-that <tệp> | giu-cho <chuỗi>\n');
  process.exit(2);
}
// CHU-KY-THAT>>>

module.exports = {
  PASS_FAMILY,
  chuKyThat,
  laGiuCho,
  // Bảng xuất ra để phép đo RÚT từ chính nguồn (không gõ lại danh sách ở test).
  CHU_KY_GIU_CHO,
  machineClearedSignoffConflict,
  findAcceptanceConfig,
  unquoteScalar,
  stripYamlComment,
  splitTopLevel,
  parseFlowValue,
  resolveConfigKey,
  resolveConfigList,
  REPIN_MACHINE_EXECUTORS,
  normaliseEvalStatus,
  isRepinMachineEval,
  machineEvalIds,
  machineEvalIdsSkipped,
  notRunConflicts,
  extractEvalBlockExits,
  checkRepinEvals,
  readSignedReportFor,
  frontmatterField,
  extractRunIds,
  loadRunLogIds,
  extractVerifierValues,
  findGitRoot,
  isAuthenticVerifier,
  determineEnforce,
  evaluateEvidence,
  evaluateContractWrite,
  vetoGateState,
};
