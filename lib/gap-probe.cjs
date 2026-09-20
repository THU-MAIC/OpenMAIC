'use strict';
// Luật gap-probe — MỘT cài đặt, HAI lối vào.
//   · scripts/gate-card.js       → require('../lib/gap-probe.cjs')
//   · scripts/pre-merge-check.sh → node lib/gap-probe.cjs classify <dir>
//
// Contract v2 chết vì hai bản cài đặt hai ngôn ngữ, parity giữ bằng comment:
// 3 round S4, mỗi round lộ một chỗ hai bên lệch nhau (thứ tự khởi tạo biến, neo
// path, nuốt mã lỗi git diff, và cuối cùng là dòng JSON hỏng mở được van thoát
// ở bash trong khi thẻ Cổng 1 loại nó). Đừng tách lại — AC-19/AC-20 canh việc
// này bằng máy chứ không bằng chữ.
const fs = require('fs');
const path = require('path');

// Luật van thoát DUY NHẤT. Cả thẻ lẫn pre-merge đọc hằng này.
const DESCOPE_RE = /^\s*bỏ gap-probe/i;
const VERDICTS = ['clean', 'findings', 'probe-failed'];

// verdict CHỈ đọc từ khối frontmatter ĐẦU file. Một dòng `verdict:` trong thân
// bài (vd trích trong bảng finding) KHÔNG được tính — AC-6. File rỗng do `touch`
// cho null nên rơi vào nhánh "missing": đó là chốt chống bypass.
function frontVerdict(text) {
  if (typeof text !== 'string') return null;
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!m) return null;
  const line = m[1].split(/\r?\n/).find(l => /^\s*verdict\s*:/.test(l));
  if (!line) return null;
  const v = line
    .replace(/^\s*verdict\s*:\s*/, '')
    .replace(/\s*#.*$/, '')
    .trim()
    .replace(/^["']/, '')
    .replace(/["']$/, '')
    .trim()
    .toLowerCase();
  return VERDICTS.includes(v) ? v : null;
}

// id của entry descope ĐẦU TIÊN mở đầu "bỏ gap-probe". PARSE thật từng dòng —
// dòng JSON hỏng bị BỎ QUA chứ không được khớp bằng regex trên chuỗi thô
// (AC-13: van thoát fail-CLOSED). Một dòng lỗi không làm hỏng cả ledger.
function descopeId(ledgerText) {
  if (typeof ledgerText !== 'string') return null;
  for (const line of ledgerText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    if (!e || e.type !== 'descope') continue;
    if (DESCOPE_RE.test(String(e.decision || ''))) {
      return String(e.id || '(entry không có id)');
    }
  }
  return null;
}

// outcome: 'ok' (đã có phản biện) | 'probe-failed' | 'descoped' | 'missing'
// Hàm THUẦN — quyết định VIOLATION hay NOTE là việc của lối vào, không phải của
// luật: cùng một `missing` là chặn ở `required` và nhắc ở `advisory`.
function classify({ probeText, ledgerText }) {
  const verdict = frontVerdict(probeText);
  if (verdict === 'clean' || verdict === 'findings') return { outcome: 'ok', verdict, id: null };
  if (verdict === 'probe-failed') return { outcome: 'probe-failed', verdict, id: null };
  const id = descopeId(ledgerText);
  if (id) return { outcome: 'descoped', verdict, id };
  return { outcome: 'missing', verdict, id: null };
}

// Lối vào filesystem cho CLI. File vắng = chuỗi rỗng, KHÔNG throw — "không có
// gap-probe.md" là một trạng thái hợp lệ của luật, không phải lỗi chương trình.
function classifyDir(dir) {
  const rd = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return ''; } };
  return classify({ probeText: rd('gap-probe.md'), ledgerText: rd('decisions.jsonl') });
}

module.exports = { DESCOPE_RE, VERDICTS, frontVerdict, descopeId, classify, classifyDir };

if (require.main === module) {
  const [sub, dir] = process.argv.slice(2);
  if (sub !== 'classify' || !dir) {
    process.stderr.write('usage: gap-probe.cjs classify <slug-dir>\n');
    process.exit(2);
  }
  const r = classifyDir(dir);
  process.stdout.write(r.outcome + '\t' + (r.id || '') + '\n');
}
