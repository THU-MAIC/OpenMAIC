// lop-nhin-thay.cjs — LUẬT DUY NHẤT trả lời «hợp đồng này có MẶT NGƯỜI NHÌN không» và «đã có
// bằng chứng lớp nhìn-thấy (ui-observed) chưa».
//
// Vì sao một chỗ: bốn bộ đọc (lint W8 · thẻ Cổng Phạm vi · thẻ Cổng Bằng chứng · pre-merge NOTE)
// và vị từ «có người dùng cuối» của nguong-o-co-hoi.cjs cùng hỏi một câu. Từ vựng `surfaces` đã
// trôi một lần (web / web-ui ngoài enum, mỗi bộ đọc một regex) — hồ sơ lop-bang-chung-nhin-thay
// (D4) gom về đây. Ai thêm bên đọc thứ năm thì GỌI hàm này, đừng chép regex.
//
// Neo máy của nghĩa vụ ở bản khai (lint W8 · thẻ Cổng Phạm vi · NOTE pre-merge) là
// `executor: ui-check`. Răng của FRAME là thẻ Cổng Bằng chứng: nó đọc block của eval ui-check
// trong evidence-report (đạt = exit_code 0 + screenshot:). Hook write-time KHÔNG đòi screenshot
// trên block ui-check — nó chỉ kiểm observed: khi block ĐÃ có screenshot: (evidence-core
// evaluateObserved). `layer: ui-observed` là NHÃN KHAI để luật ghép cặp đọc đối xứng với
// backend-effect; nhãn đặt trên executor khác ui-check là lạc chỗ (D1).
//
// Hàm THUẦN nhận chuỗi; chỉ classify() và CLI đọc đĩa — bên gọi quyết định đọc ở đâu.
'use strict';
const fs = require('fs');
const path = require('path');
const evalYaml = require('./eval-yaml.cjs');

// Enum PHẢI BẰNG chú thích dòng `surfaces:` của khối CONTRACT-FRONTMATTER-TEMPLATE
// (ca LNT1 round-trip khuôn ↔ lib — đổi một bên là ca đỏ nêu giá trị).
const SURFACE_ENUM = ['api', 'cli', 'sdk', 'ui', 'mobile', 'docs', 'ci', 'config'];
const SURFACE_ALIAS = { web: 'ui', 'web-ui': 'ui' };
// Tiền tố entry descope — SKILL chép nguyên văn, thẻ/lint/pre-merge so bằng startsWith.
const UI_OBSERVED_DESCOPE = 'bỏ ui-observed — ';

function tokensOf(surfaces) {
  const s = evalYaml.stripComment(String(surfaces == null ? '' : surfaces).replace(/^\s*surfaces:\s*/i, ''));
  return s.replace(/[\[\]"']/g, '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
}
const canon = t => SURFACE_ALIAS[t] || t;
const laMatNguoiNhin = surfaces => tokensOf(surfaces).some(t => canon(t) === 'ui');
const tokenLa = surfaces => tokensOf(surfaces).filter(t => !SURFACE_ENUM.includes(t) && !SURFACE_ALIAS[t]);

const ex = e => String(e && e.executor || '').trim().toLowerCase();
const ly = e => String(e && e.layer || '').trim().toLowerCase();
const uiCheckIds = evals => (Array.isArray(evals) ? evals : []).filter(e => ex(e) === 'ui-check').map(e => e.id);
const coUiObserved = evals => uiCheckIds(evals).length > 0;
const nhanLacCho = evals => (Array.isArray(evals) ? evals : []).filter(e => ly(e) === 'ui-observed' && ex(e) !== 'ui-check').map(e => e.id);

// Cùng nếp eval-coverage-lint: giá trị trong quote giữ nguyên (kể cả #), ngoài quote thì
// " # …" là comment.
function fieldVal(raw) {
  const s = String(raw).trim();
  const q = s[0];
  if (q === '"' || q === "'") { const end = s.indexOf(q, 1); if (end > 0) return s.slice(1, end); }
  return evalYaml.stripComment(s);
}
const parseEvalsText = text => evalYaml.parseEvals(text, ['criterion', 'executor', 'layer'], fieldVal);

function descopeId(ledgerText) {
  for (const line of String(ledgerText == null ? '' : ledgerText).split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j && j.type === 'descope' && String(j.decision || '').startsWith(UI_OBSERVED_DESCOPE)) return j.id || null;
    } catch (_) { /* dòng hỏng: bỏ qua, bên đọc khác đã đếm */ }
  }
  return null;
}

function frontLine(text, key) {
  const m = String(text == null ? '' : text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = m ? m[1] : '';
  const l = fm.split('\n').find(x => x.startsWith(key + ':'));
  return l ? evalYaml.stripComment(l.slice(key.length + 1)) : '';
}

function classify(dir) {
  const rd = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return null; } };
  const c = rd('contract.md');
  if (c == null) return { applicable: false, reason: 'no-contract' };
  const surfaces = frontLine(c, 'surfaces');
  const approved_at = frontLine(c, 'approved_at') || '-';
  const applicable = laMatNguoiNhin(surfaces);
  const e = rd('evals.yaml');
  if (e == null) return { applicable, reason: 'no-evals', surfaces, approved_at, tokenLa: tokenLa(surfaces) };
  const evals = parseEvalsText(e);
  return {
    applicable, reason: '', surfaces, approved_at,
    declared: uiCheckIds(evals).length,
    lacCho: nhanLacCho(evals),
    descoped: descopeId(rd('decisions.jsonl')),
    tokenLa: tokenLa(surfaces),
  };
}

module.exports = { SURFACE_ENUM, SURFACE_ALIAS, UI_OBSERVED_DESCOPE, tokensOf, laMatNguoiNhin, tokenLa, uiCheckIds, coUiObserved, nhanLacCho, fieldVal, parseEvalsText, descopeId, frontLine, classify };

// CLI cho bash (pre-merge): `node lib/lop-nhin-thay.cjs classify <dir>` → MỘT dòng
// `applicable\tdeclared\tdescoped_id\tapproved_at` (mẫu lib/gap-probe.cjs classify).
if (require.main === module) {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd !== 'classify' || !dir) { process.stderr.write('usage: lop-nhin-thay.cjs classify <dir>\n'); process.exit(2); }
  const r = classify(dir);
  if (r.reason === 'no-contract') process.exit(3);
  if (r.reason === 'no-evals') { process.stdout.write(`n-a\t-\t-\t${r.approved_at}\n`); process.exit(0); }
  process.stdout.write(`${r.applicable ? 1 : 0}\t${r.declared}\t${r.descoped || '-'}\t${r.approved_at}\n`);
}
