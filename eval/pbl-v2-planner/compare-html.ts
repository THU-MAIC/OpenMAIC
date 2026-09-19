/**
 * Shared rendering for the PBL v2 A/B comparison viewer.
 *
 * Two consumers:
 *   - `build-compare.ts` / the runner → `buildCompareHtml(runDir)` writes a
 *     self-contained static `compare.html` (data embedded).
 *   - `serve.ts` → a small dev server that lists every run under `results/`
 *     and loads each run's JSON on demand (data fetched).
 *
 * Both share `VIEWER_CSS` + `CLIENT_RENDER_JS` so the rendering stays in one
 * place. `collectRunData(runDir)` reads `projects/<case>__<variant>.json`
 * plus the optional `results.json` (judge scores) into one blob.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

export interface EmbeddedVariant {
  project?: unknown;
  result?: unknown;
}
export interface EmbeddedCase {
  id: string;
  variants: Record<string, EmbeddedVariant>;
}
export interface EmbeddedData {
  runDir: string;
  cases: EmbeddedCase[];
}

function safeReadJson(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

/** Collect `<case>__<variant>.json` + results.json for a run into one blob. */
export function collectRunData(runDir: string): EmbeddedData {
  const projectsDir = join(runDir, 'projects');
  const cases = new Map<string, EmbeddedCase>();

  if (existsSync(projectsDir)) {
    for (const file of readdirSync(projectsDir)) {
      if (!file.endsWith('.json')) continue;
      const base = file.slice(0, -'.json'.length);
      const sep = base.lastIndexOf('__');
      if (sep === -1) continue;
      const caseId = base.slice(0, sep);
      const variant = base.slice(sep + 2);
      if (!cases.has(caseId)) cases.set(caseId, { id: caseId, variants: {} });
      cases.get(caseId)!.variants[variant] = {
        ...cases.get(caseId)!.variants[variant],
        project: safeReadJson(join(projectsDir, file)),
      };
    }
  }

  const results = safeReadJson(join(runDir, 'results.json'));
  if (Array.isArray(results)) {
    for (const r of results as Array<Record<string, unknown>>) {
      const caseId = String(r.caseId ?? '');
      const variant = String(r.variant ?? '');
      if (!caseId || !variant) continue;
      if (!cases.has(caseId)) cases.set(caseId, { id: caseId, variants: {} });
      const v = cases.get(caseId)!.variants[variant] ?? {};
      v.result = r;
      cases.get(caseId)!.variants[variant] = v;
    }
  }

  return {
    runDir,
    cases: [...cases.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Embed JSON safely inside a <script> tag. */
function embed(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

export const VIEWER_CSS = `
  :root { --bg:#0f1115; --panel:#171a21; --border:#2a2f3a; --fg:#e6e9ef; --muted:#9aa3b2;
          --accent:#6ea8fe; --good:#3fb950; --warn:#d29922; --bad:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
         background:var(--bg); color:var(--fg); }
  header { padding:10px 16px; border-bottom:1px solid var(--border); display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  header .meta { color:var(--muted); font-size:12px; }
  select { background:var(--panel); color:var(--fg); border:1px solid var(--border); border-radius:6px; padding:5px 8px; font-size:12px; max-width:60vw; }
  .layout { display:flex; height:calc(100vh - 50px); }
  nav { width:240px; border-right:1px solid var(--border); overflow:auto; flex:0 0 auto; }
  nav button { display:block; width:100%; text-align:left; background:none; border:none; color:var(--fg);
               padding:10px 14px; cursor:pointer; border-bottom:1px solid var(--border); font-size:13px; }
  nav button:hover { background:var(--panel); }
  nav button.active { background:#1f2530; border-left:3px solid var(--accent); }
  nav .ov { float:right; color:var(--muted); font-variant-numeric:tabular-nums; }
  main { flex:1; overflow:auto; padding:16px; }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:16px; align-items:start; }
  .col { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:14px; }
  .col h2 { margin:0 0 4px; font-size:14px; }
  .judge { font-size:12px; color:var(--muted); margin:6px 0 10px; border:1px solid var(--border);
           border-radius:6px; padding:8px; background:#10131a; }
  .judge .dims { display:grid; grid-template-columns:1fr auto 1fr auto; gap:2px 10px; margin-top:6px; }
  .pill { display:inline-block; padding:1px 7px; border-radius:10px; font-size:11px; font-weight:600; }
  .pill.good { background:rgba(63,185,80,.15); color:var(--good); }
  .pill.warn { background:rgba(210,153,34,.15); color:var(--warn); }
  .pill.bad { background:rgba(248,81,73,.15); color:var(--bad); }
  .redlines { margin-top:6px; }
  .redlines .pill { margin:2px 4px 0 0; background:rgba(248,81,73,.15); color:var(--bad); }
  .proj-title { font-size:15px; font-weight:600; margin:2px 0; }
  .desc { color:var(--muted); margin:2px 0 8px; }
  .kv { font-size:12px; color:var(--muted); margin:2px 0; }
  .ms { border:1px solid var(--border); border-radius:6px; margin:8px 0; }
  .ms > summary { cursor:pointer; padding:8px 10px; font-weight:600; list-style:none; }
  .ms > summary::-webkit-details-marker { display:none; }
  .ms[open] > summary { border-bottom:1px solid var(--border); }
  .ms .body { padding:8px 10px; }
  .script { font-size:12px; margin:3px 0; }
  .script b { color:var(--accent); }
  .core { font-size:12px; color:var(--warn); margin:4px 0; }
  .mt { border-left:2px solid var(--border); padding:4px 0 4px 10px; margin:8px 0; }
  .mt .t { font-weight:600; }
  .mt .d { color:var(--muted); font-size:13px; }
  .mt ul { margin:4px 0 0; padding-left:18px; }
  .mt li { color:#c8cfdb; font-size:12.5px; }
  .doc { font-size:12px; color:var(--muted); margin-top:6px; }
  .missing { color:var(--bad); }
`;

/** Client-side render functions. Exposes `renderRun(data)` which fills
 *  #meta, #nav and #main. Pure DOM, no framework. */
export const CLIENT_RENDER_JS = `
const VARIANTS = ['loop','single-call'];
const DIMS = ['projectNotLecture','taskEvaluability','typeFit','granularity','coherence','topicFidelity',
  'singleConcreteOutcome','difficultyProgressionAndFit','learnerAgency','authenticWorkflow','stageIntegrity','closureAndConsolidation'];
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

function overallPill(o){
  if (o == null) return '';
  const cls = o >= 4 ? 'good' : o >= 3 ? 'warn' : 'bad';
  return '<span class="pill '+cls+'">overall '+o+'</span>';
}
function completabilityBlock(result){
  const c = result && result.completability;
  if (!c) return '<div class="judge">可完成性未评分（生成失败、gate 未过或旧 run）</div>';
  const cls = c.pass ? 'good' : 'bad';
  const blockers = c.blockers || [];
  const blockerHtml = blockers.length
    ? '<div class="redlines">blockers '+blockers.map(x=>'<span class="pill">'+esc(x)+'</span>').join('')+'</div>'
    : '<div class="redlines"><span class="pill good">无 blocker</span></div>';
  return '<div class="judge"><span class="pill '+cls+'">complete '+(c.pass?'PASS':'FAIL')+' '+c.score+'</span>'
    + '<span class="pill '+(c.riskLevel==='low'?'good':c.riskLevel==='medium'?'warn':'bad')+'" style="margin-left:4px">risk '+esc(c.riskLevel||'?')+'</span>'
    + blockerHtml
    + '<div style="margin-top:6px">'+esc(c.rationale||'')+'</div></div>';
}
function judgeBlock(result){
  const j = result && result.judge;
  if (!j) return '<div class="judge">未评分（生成失败或 gate 未过）</div>';
  let dims = '<div class="dims">';
  for (const d of DIMS){ const v=j.scores?.[d]; dims += '<span>'+d+'</span><span>'+(v??'-')+'</span>'; }
  dims += '</div>';
  const rl = (j.redLines||[]);
  const rlHtml = rl.length
    ? '<div class="redlines">红线 '+rl.map(c=>'<span class="pill">'+esc(c)+'</span>').join('')+'</div>'
    : '<div class="redlines"><span class="pill good">无红线</span></div>';
  const dur = result.durationMs!=null ? ' · '+(result.durationMs/1000).toFixed(1)+'s' : '';
  return '<div class="judge">'+overallPill(j.overall)+rlHtml
    + '<div style="margin-top:6px">'+esc(j.rationale||'')+'</div>'+dims
    + '<div class="kv" style="margin-top:6px">'+(result.milestoneCount??'?')+' milestones · '
    + (result.microtaskCount??'?')+' microtasks'+dur+'</div></div>';
}
function renderProject(p){
  if (!p) return '<div class="missing">（无此 variant 的生成结果）</div>';
  const inst = p.roles && p.roles.find(r=>r.type==='instructor');
  let h = '<div class="proj-title">'+esc(p.title)+'</div>';
  h += '<div class="desc">'+esc(p.description)+'</div>';
  if (p.learningObjective) h += '<div class="kv">🎯 '+esc(p.learningObjective)+'</div>';
  h += '<div class="kv">tier: '+esc(p.proficiency||'?')+'</div>';
  if (inst) h += '<div class="kv">👤 '+esc(inst.name)+(inst.description?' — '+esc(inst.description):'')+'</div>';
  for (const m of (p.milestones||[])){
    h += '<details class="ms"><summary>'+esc(m.title)+' <span class="kv">('+(m.microtasks||[]).length+' 任务)</span></summary><div class="body">';
    if (m.description) h += '<div class="desc">'+esc(m.description)+'</div>';
    if (m.briefing) h += '<div class="script"><b>briefing</b> '+esc(m.briefing)+'</div>';
    if (m.completionCriteria) h += '<div class="script"><b>done</b> '+esc(m.completionCriteria)+'</div>';
    if (m.debrief) h += '<div class="script"><b>debrief</b> '+esc(m.debrief)+'</div>';
    if (m.synthesisCheck?.coreConcept) h += '<div class="core">★ coreConcept: '+esc(m.synthesisCheck.coreConcept)+'</div>';
    for (const t of (m.microtasks||[])){
      h += '<div class="mt"><div class="t">'+esc(t.title)+'</div>';
      if (t.description) h += '<div class="d">'+esc(t.description)+'</div>';
      if (t.learnerBrief) h += '<div class="script"><b>learnerBrief</b> '+esc(t.learnerBrief)+'</div>';
      if (t.successWhen) h += '<div class="script"><b>successWhen</b> '+esc(t.successWhen)+'</div>';
      if (t.characterObjective) h += '<div class="script"><b>characterObjective</b> '+esc(t.characterObjective)+'</div>';
      if (t.skillFocus) h += '<div class="script"><b>skillFocus</b> '+esc(t.skillFocus)+'</div>';
      if (t.narration) h += '<div class="script"><b>narration</b> '+esc(t.narration)+'</div>';
      if (t.hints && t.hints.length){ h += '<ul>'+t.hints.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>'; }
      h += '</div>';
    }
    for (const d of (m.documents||[])){ h += '<div class="doc">📄 '+esc(d.title)+'</div>'; }
    h += '</div></details>';
  }
  return h;
}
function renderCase(c){
  document.getElementById('main').innerHTML = '<div class="cols">' + VARIANTS.map(v => {
    const e = c.variants[v] || {};
    return '<div class="col"><h2>'+v+'</h2>'+completabilityBlock(e.result)+judgeBlock(e.result)+renderProject(e.project)+'</div>';
  }).join('') + '</div>';
}
function navLabel(c){
  const o = VARIANTS.map(v => {
    const cpl=c.variants[v]?.result?.completability;
    if (cpl) return (cpl.pass?'P':'F')+cpl.score;
    const j=c.variants[v]?.result?.judge;
    return j? j.overall : null;
  });
  return esc(c.id) + '<span class="ov">'+o.map(x=>x==null?'-':x).join('/')+'</span>';
}
function renderRun(data){
  const metaEl = document.getElementById('meta'); if (metaEl) metaEl.textContent = data.runDir || '';
  const nav = document.getElementById('nav'); nav.innerHTML='';
  document.getElementById('main').innerHTML='';
  if (!data.cases || !data.cases.length){ document.getElementById('main').innerHTML='<p class="missing">此 run 无数据。</p>'; return; }
  data.cases.forEach((c,i)=>{
    const b=document.createElement('button');
    b.innerHTML = navLabel(c);
    b.onclick=()=>{ [...nav.children].forEach(x=>x.classList.remove('active')); b.classList.add('active'); renderCase(c); };
    nav.appendChild(b);
    if (i===0){ b.classList.add('active'); renderCase(c); }
  });
}
`;

function staticTemplate(data: EmbeddedData): string {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PBL v2 — loop vs single-call</title><style>${VIEWER_CSS}</style></head>
<body>
<header><h1>PBL v2 — loop vs single-call</h1><span class="meta" id="meta"></span></header>
<div class="layout"><nav id="nav"></nav><main id="main"></main></div>
<script>${CLIENT_RENDER_JS}\nrenderRun(${embed(data)});</script>
</body></html>`;
}

export function buildCompareHtml(runDir: string): string {
  const data = collectRunData(runDir);
  const outPath = join(runDir, 'compare.html');
  writeFileSync(outPath, staticTemplate(data), 'utf-8');
  return outPath;
}
