// Design-quality detection core for the acceptance gate.
// Wraps the vendored Impeccable detector (Apache-2.0, vendor/impeccable/) and
// normalizes both engines to one shape: { rule, severity, pTier }.
// Two engines:
//   detectStatic(file)        -> source-text scan, zero dependency
//   detectDomWith(JSDOM, file) -> rendered-DOM scan, needs a JSDOM ctor injected
//                                 by the caller (so jsdom resolves from the
//                                 caller's location, not this module's).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.join(HERE, '..', 'vendor', 'impeccable', 'engine');
const BROWSER_BUNDLE = path.join(ENGINE_DIR, 'detect-antipatterns-browser.js');

// Severity-to-P-tier policy from the shared source of truth (lib/p-tiers.json),
// also injected into the browser scan (scripts/design-scan.js) so script and
// ui-check tiers agree. P0 = ship-blocking (a11y / legibility); P1 = strong
// AI-slop tell; P2 = craft warning; P3 = advisory; DROP = project-config drift.
const TIERS = JSON.parse(fs.readFileSync(path.join(HERE, 'p-tiers.json'), 'utf8'));
const P0_RULES = new Set(TIERS.p0);
const P1_RULES = new Set(TIERS.p1);
const DROP_RULES = new Set(TIERS.drop);

function pTier(rule, severity) {
  if (P0_RULES.has(rule)) return 'P0';
  if (P1_RULES.has(rule)) return 'P1';
  if (severity === 'advisory') return 'P3';
  return 'P2';
}

function normalize(rawList) {
  const out = [];
  const seen = new Set();
  for (const f of rawList) {
    const rule = f.rule || f.antipattern || f.id || f.type;
    if (!rule || DROP_RULES.has(rule)) continue;
    const severity = f.severity || 'warning';
    const detail = f.detail ?? f.snippet ?? '';
    // Key on detail first so the DOM tier dedupes per-detail exactly like the
    // browser wrapper (design-scan.js); static still falls back to line.
    const key = rule + '|' + (f.detail ?? f.line ?? f.snippet ?? '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rule, severity, pTier: pTier(rule, severity), detail });
  }
  return out;
}

function summarize(findings, failOn) {
  const tiers = new Set(failOn);
  const blocking = findings.filter((f) => tiers.has(f.pTier));
  return {
    findings,
    hits: [...new Set(findings.map((f) => f.rule))],
    p0Count: findings.filter((f) => f.pTier === 'P0').length,
    blocking: blocking.map((f) => f.rule),
    verdict: blocking.length ? 'REJECT' : 'PASS',
    exitCode: blocking.length ? 2 : 0,
  };
}

export async function detectStatic(file, { failOn = ['P0'] } = {}) {
  // Import the static-html engine directly — the CLI entry (detect-antipatterns.mjs)
  // reaches outside the vendored engine, this leaf does not.
  const { detectHtml } = await import(
    path.join(ENGINE_DIR, 'engines', 'static-html', 'detect-html.mjs')
  );
  const raw = await detectHtml(file, {});
  return { mode: 'static', ...summarize(normalize(raw || []), failOn) };
}

// JSDOM is injected so it resolves from the caller's node_modules. Browser-API
// gaps jsdom lacks (IntersectionObserver, layout rects) are polyfilled; the
// detector bundle is loaded then removed from the DOM so it never scans itself.
// External CSS is loaded (resources:'usable' + the file's own URL) so real,
// multi-file artifacts resolve their tokens/contrast — page <script> tags are
// stripped first so the gate never runs (or hangs on) the artifact's own JS.
export async function detectDomWith(JSDOM, file, { failOn = ['P0'], loadCssMs = 2500 } = {}) {
  const html = fs.readFileSync(file, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');
  const bundle = fs.readFileSync(BROWSER_BUNDLE, 'utf8');
  const poly = [
    'window.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}takeRecords(){return[]}};',
    'window.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};',
    'window.matchMedia=q=>({matches:false,media:q,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});',
    'Element.prototype.getBoundingClientRect=function(){return{x:0,y:0,top:0,left:0,right:120,bottom:60,width:120,height:60,toJSON(){return{}}}};',
  ].join('');
  const dom = new JSDOM(html, {
    url: pathToFileURL(file).href,
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  await new Promise((res) => {
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    window.addEventListener('load', fin);
    setTimeout(fin, loadCssMs);
  });
  window.__IMPECCABLE_CONFIG__ = { autoScan: false };
  const p = window.document.createElement('script');
  p.textContent = poly;
  window.document.head.appendChild(p);
  const s = window.document.createElement('script');
  s.textContent = bundle;
  window.document.body.appendChild(s);
  s.remove();
  p.remove();
  if (typeof window.impeccableDetect !== 'function') {
    throw new Error('detector bundle did not attach impeccableDetect');
  }
  const raw = window.impeccableDetect({ serialize: false });
  const flat = raw.flatMap((r) => (r.findings || []).map((f) => ({ rule: f.type, severity: f.severity, detail: f.detail })));
  const result = { mode: 'dom', ...summarize(normalize(flat), failOn) };
  window.close?.();
  return result;
}
