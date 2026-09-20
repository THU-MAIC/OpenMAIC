#!/usr/bin/env node
// design-gate.mjs — production design-quality executor for the acceptance gate.
//
// Runs the vendored Impeccable detector over one rendered surface and emits a
// machine verdict with hook-legal evidence (run_id, exit_code, verifier,
// verified_at). Wire it into a consumer's _acceptance/config.yaml as:
//
//   executors:
//     design:
//       gate: "node <kit>/scripts/design-gate.mjs"
//       fail_on: [P0]
//
// and reference it from a `script` eval: cmd: config:executors.design.gate
//
// Usage:
//   node scripts/design-gate.mjs <file.html> [--mode dom|static] [--fail-on P0,P1]
//
// DOM mode (default) needs jsdom resolvable from this script's install. When it
// is not, the gate emits BLOCKED (exit 3) with install guidance — it never
// silently falls back to the weaker static scan and passes an inaccessible UI.
// Pass --mode static to accept the zero-dependency source scan knowingly.
//
// Exit codes: 0 PASS · 2 REJECT (blocking finding) · 3 BLOCKED · 4 bad usage.

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { detectStatic, detectDomWith } from '../lib/design-detect.mjs';

function parseArgs(argv) {
  const a = { mode: 'dom', failOn: ['P0'], target: null, jsdom: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--mode') a.mode = argv[++i];
    else if (t === '--fail-on') a.failOn = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (t === '--jsdom') a.jsdom = argv[++i];
    else if (!t.startsWith('--')) a.target = t;
  }
  return a;
}

// jsdom may be installed in a non-default location (e.g. scoped to a test folder
// or the consumer's own node_modules). --jsdom <dir> resolves it from there.
async function loadJsdom(dir) {
  if (dir) {
    const req = createRequire(path.join(path.resolve(dir), 'noop.js'));
    return req('jsdom');
  }
  return import('jsdom');
}

function emit(obj, code) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(code);
}

const args = parseArgs(process.argv.slice(2));
const base = {
  run_id: 'design-gate-' + crypto.randomBytes(5).toString('hex'),
  verifier: 'scripts/design-gate.mjs (vendored Impeccable detector)',
  verified_at: new Date().toISOString(),
  target: args.target,
  fail_on: args.failOn,
};

if (!args.target) {
  emit({ ...base, verdict: 'BLOCKED', reason: 'no target file given', exit_code: 4 }, 4);
}

let result;
if (args.mode === 'static') {
  result = await detectStatic(args.target, { failOn: args.failOn });
} else {
  let JSDOM;
  try {
    ({ JSDOM } = await loadJsdom(args.jsdom));
  } catch {
    emit({
      ...base, mode: 'dom', verdict: 'BLOCKED', exit_code: 3,
      reason: 'DOM mode needs jsdom but it could not be resolved. Run `npm i jsdom` where this gate runs, pass --jsdom <dir-with-node_modules>, or use --mode static to accept the weaker source scan (it cannot see computed contrast).',
    }, 3);
  }
  result = await detectDomWith(JSDOM, args.target, { failOn: args.failOn });
}

emit({
  ...base,
  mode: result.mode,
  verdict: result.verdict,
  exit_code: result.exitCode,
  p0_count: result.p0Count,
  blocking: result.blocking,
  hits: result.hits,
  findings: result.findings,
}, result.exitCode);
