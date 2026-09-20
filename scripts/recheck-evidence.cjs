#!/usr/bin/env node
'use strict';
/**
 * recheck-evidence.cjs — CI re-verification of a COMMITTED evidence-report.md.
 *
 * The write-time hook only sees agent edits; a report hand-edited afterwards (or
 * written under ACCEPTANCE_GATE_BYPASS) never faced the gate. This re-applies the
 * EXACT evidence bar (lib/evidence-core.cjs — same code the hook runs) to the
 * committed file, at strict, regardless of the repo's enforcement mode. So a
 * committed PASS that lacks real evidence, carries a nonzero exit, a manual
 * verifier, or an unresolved UNCERTAIN cannot reach merge.
 *
 * Usage: recheck-evidence.cjs <evidence-report.md>
 *   exit 0 — not a PASS-family report (nothing to re-verify) OR evidence holds
 *   exit 1 — committed PASS report fails the evidence bar (failures on stderr)
 *   exit 2 — usage / unreadable file
 */

const fs = require('fs');
const path = require('path');
let core;
try {
  core = require(path.join(__dirname, '..', 'lib', 'evidence-core.cjs'));
} catch (e) {
  process.stderr.write(`recheck-evidence: cannot load lib/evidence-core.cjs (${e.message}) — vendor lib/ next to scripts/\n`);
  process.exit(2);
}

const reportPath = process.argv[2];
if (!reportPath) {
  process.stderr.write('recheck-evidence: usage: recheck-evidence.cjs <evidence-report.md>\n');
  process.exit(2);
}

let payload;
try {
  payload = fs.readFileSync(reportPath, 'utf8');
} catch (e) {
  process.stderr.write(`recheck-evidence: cannot read ${reportPath}: ${e.message}\n`);
  process.exit(2);
}

// Only a PASS-family verdict carries an evidence bar to re-check.
if (!core.determineEnforce(payload)) process.exit(0);

// ── Re-pin provenance (delta-verify-repin, additive rule) ────────────────────
// New-form "### Re-pin" sections cite a run_id on its own line; the lane that
// produced it must be logged per-slug ({"kind":"repin"} line), its sha must
// equal verified_commit, and every suites_exit element must be 0 — a red lane
// cannot back a signature. Old-form sections (no "run_id:") are grandfathered:
// no rule below applies to them.
{
  // End-anchor phải là HẾT-VĂN-BẢN ($(?![\s\S])) chứ không phải cuối-dòng:
  // với flag m, nhánh `\n*$` thoả ngay cuối dòng đầu nên body chỉ còn 1 dòng —
  // section có dòng trống sau heading bị grandfather ÂM THẦM (fail-open,
  // finding S4-r1). Quét TRỌN body và bắt MỌI dòng run_id (không đòi hết dòng
  // sau id — cùng ngữ nghĩa với awk của pre-merge: `run_id: X · ghi chú` vẫn
  // là citation).
  const secRe = /^###\s+Re-pin\b[^\n]*\n([\s\S]*?)(?=\n#{1,3}\s|$(?![\s\S]))/gm;
  const cited = [];
  let m;
  while ((m = secRe.exec(payload)) !== null) {
    for (const im of m[1].matchAll(/^\s*run_id\s*[:=]\s*([^\s·,]+)/gim)) cited.push(im[1]);
  }
  if (cited.length) {
    const dir = path.dirname(path.resolve(reportPath));
    const vcm = payload.match(/^verified_commit\s*:\s*(\S+)/m);
    const vc = vcm ? vcm[1] : '';
    const slug = path.basename(dir);
    const errs = [];
    const logPath = path.join(dir, 'run-log.jsonl');
    if (!fs.existsSync(logPath)) {
      for (const id of cited) errs.push(`REPIN x report cites repin run_id "${id}" but _acceptance/${slug}/run-log.jsonl does not exist — no lane was ever logged for this workspace`);
    } else {
      const repins = new Map();
      for (const l of fs.readFileSync(logPath, 'utf8').split('\n')) {
        try { const e = JSON.parse(l); if (e && e.kind === 'repin' && typeof e.run_id === 'string') repins.set(e.run_id, e); } catch { /* skip malformed line */ }
      }
      // Hotfix sự-kiện-thứ-hai (dogfood #2, 2026-08-05): sha-khớp là quan hệ
      // TỔNG HỢP, không per-section — report tích nhiều section Re-pin theo
      // thời gian, chỉ section MỚI NHẤT chống lưng verified_commit hiện hành;
      // section cũ vẫn phải có lane thật (chống bịa) nhưng sha của nó là lịch
      // sử. Ít nhất MỘT citation khớp vc = pin có lane chống lưng.
      for (const id of cited) {
        const e = repins.get(id);
        if (!e) { errs.push(`REPIN x run_id "${id}" cited in ### Re-pin but no {"kind":"repin"} line with that run_id in run-log.jsonl — the lane never logged this re-pin; re-run the lane, do not hand-mint run_ids`); continue; }
        if (!Array.isArray(e.suites_exit) || e.suites_exit.length === 0 || e.suites_exit.some(x => x !== 0)) errs.push(`REPIN x repin line for run_id "${id}" has nonzero suites_exit ${JSON.stringify(e.suites_exit)} — a red lane cannot back a signature; fix the suites and run a NEW lane`);
      }
      if (vc && !cited.some(id => { const e = repins.get(id); return e && e.sha === vc; })) {
        errs.push(`REPIN x none of the cited re-pin lane(s) matches verified_commit ${vc} — the current pin has no backing lane; re-pin against the verified commit, do not hand-edit the pin`);
      }
      // ── Eval-lane rule (repin-chay-lai-eval, 2026-09-07) ─────────────────
      // The lane that backs verified_commit must have re-run THIS slug's
      // test/script evals at that sha (evals_exit). One rule source:
      // core.checkRepinEvals — pre-merge prints the same words under its own
      // label. No date mark, no grandfather (owner, 2026-09-08).
      if (vc) {
        const evalsPath = path.join(dir, 'evals.yaml');
        const evalsText = fs.existsSync(evalsPath) ? fs.readFileSync(evalsPath, 'utf8') : null;
        for (const id of new Set(cited)) {
          const e = repins.get(id);
          if (!e || e.sha !== vc) continue;
          for (const x of core.checkRepinEvals(e, evalsText, slug, payload).errs) errs.push(`REPIN x ${x}`);
        }
      }
    }
    if (errs.length) {
      process.stderr.write(`recheck-evidence: ${reportPath} — re-pin provenance fails:\n` + errs.map(s => '  ' + s).join('\n') + '\n');
      process.exit(1);
    }
  }
}

const fileDir = path.dirname(path.resolve(reportPath));
const configPath = core.findAcceptanceConfig(fileDir);
let configText = null;
if (configPath) {
  try { configText = fs.readFileSync(configPath, 'utf8'); } catch { /* config unreadable — evaluate without it */ }
}

const r = core.evaluateEvidence(payload, { fileDir, configText, configPath });
if (!r.anyFailure) process.exit(0);

const out = [`recheck-evidence: ${reportPath} — committed PASS report fails the evidence bar:`];
for (const m of r.missing) out.push(`  L1 SHAPE       x ${m}`);
if (r.consistencyFailure) out.push(`  L1 CONSISTENCY x ${r.consistencyFailure}`);
for (const a of r.authFailures) out.push(`  L2 SUBSTANCE   x ${a}`);
if (r.judgmentFailure) out.push(`  L3 JUDGMENT    x ${r.judgmentFailure}`);
if (r.runLogFailure) out.push(`  L2 PROVENANCE  x ${r.runLogFailure}`);
for (const o of r.observedFailures || []) out.push(`  L2 OBSERVED    x ${o}`);
process.stderr.write(out.join('\n') + '\n');
process.exit(1);
