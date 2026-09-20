#!/usr/bin/env node
/**
 * Sàn thẩm mỹ P0 trên các file giao diện MỘT VÒNG ĐỤNG TỚI.
 *
 * `design-gate.mjs` chấm đúng một file mỗi lần, nên nó không dùng trực tiếp
 * làm lệnh trong `_acceptance/config.yaml` được: một khoá cấu hình cấp kho
 * không thể mang tên file của một tính năng. Lệnh này lấp đúng khoảng đó —
 * nó tự tìm file giao diện đã đổi so với nhánh gốc rồi chấm từng file.
 *
 * Mã thoát: 0 không có lỗi P0 · 2 có ít nhất một P0 · 3 không chấm được.
 * Không có file giao diện nào đổi là PASS: vòng không chạm giao diện thì
 * không có gì để chấm, và im lặng ở đây là đúng — nhưng đầu ra vẫn nói ra
 * rằng nó đã chấm 0 file, để «không có gì để chấm» không trông giống «đã
 * chấm và sạch».
 */
import { execFileSync } from 'node:child_process';

const UI_FILE = /^(components|app)\/.*\.(tsx|jsx)$/;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function diffBase() {
  const explicit = process.argv.indexOf('--base');
  if (explicit !== -1 && process.argv[explicit + 1]) return process.argv[explicit + 1];
  for (const ref of ['origin/main', 'main', 'origin/master', 'master']) {
    try {
      return git(['merge-base', 'HEAD', ref]);
    } catch {
      /* thử ref kế tiếp */
    }
  }
  throw new Error('không tìm được nhánh gốc để so — truyền --base <ref>');
}

function emit(body, code) {
  process.stdout.write(JSON.stringify(body, null, 2) + '\n');
  process.exit(code);
}

let base;
try {
  base = diffBase();
} catch (error) {
  emit({ verdict: 'BLOCKED', reason: String(error.message ?? error) }, 3);
}

const changed = git(['diff', '--name-only', `${base}...HEAD`])
  .split('\n')
  .filter((line) => UI_FILE.test(line));

const results = [];
let blocking = 0;
for (const file of changed) {
  let raw;
  try {
    raw = execFileSync('node', ['scripts/design-gate.mjs', file], { encoding: 'utf8' });
  } catch (error) {
    // design-gate.mjs thoát khác 0 khi có P0; đầu ra vẫn là JSON trên stdout.
    raw = error.stdout ?? '';
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    emit({ verdict: 'BLOCKED', reason: `không đọc được kết quả cho ${file}`, base }, 3);
  }
  const p0 = (parsed.findings ?? []).filter((f) => f.pTier === 'P0');
  blocking += p0.length;
  results.push({ file, verdict: parsed.verdict, p0: p0.map((f) => f.rule) });
}

emit(
  {
    verifier: 'scripts/design-gate-changed.mjs',
    verified_at: new Date().toISOString(),
    base,
    scanned: results.length,
    verdict: blocking === 0 ? 'PASS' : 'REJECT',
    fail_on: ['P0'],
    results,
  },
  blocking === 0 ? 0 : 2,
);
