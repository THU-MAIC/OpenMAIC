/**
 * PBL v2 A/B viewer — tiny dev server.
 *
 * Loads eval-result JSON on demand (NOT a baked-in HTML): lists every run
 * under `results/`, and serves each run's `projects/*.json` + `results.json`
 * through a small JSON API the page fetches. New runs show up on refresh —
 * no rebuild.
 *
 * Usage:
 *   pnpm tsx eval/pbl-v2-planner/serve.ts          # http://localhost:5179
 *   EVAL_PBL_PORT=8080 pnpm tsx eval/pbl-v2-planner/serve.ts
 *
 * Routes:
 *   GET /                  → viewer page (run selector + side-by-side compare)
 *   GET /api/runs          → [{ dir, label, caseCount, mtime }]
 *   GET /api/run?dir=<abs> → { runDir, cases } for one run (dir must be under results/)
 */
import { createServer } from 'node:http';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectRunData, VIEWER_CSS, CLIENT_RENDER_JS } from './compare-html';

function here(): string {
  return typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
}

const RESULTS_ROOT = resolve(join(here(), 'results'));
const PORT = parseInt(process.env.EVAL_PBL_PORT || '5179', 10);

interface RunEntry {
  dir: string;
  label: string;
  caseCount: number;
  mtime: number;
}

/** All run dirs (model/ts leaves containing a projects/ subdir), newest first. */
function listRuns(): RunEntry[] {
  if (!existsSync(RESULTS_ROOT)) return [];
  const runs: RunEntry[] = [];
  for (const model of readdirSync(RESULTS_ROOT)) {
    const modelDir = join(RESULTS_ROOT, model);
    if (!statSync(modelDir).isDirectory()) continue;
    for (const ts of readdirSync(modelDir)) {
      const dir = join(modelDir, ts);
      if (!statSync(dir).isDirectory()) continue;
      const projectsDir = join(dir, 'projects');
      if (!existsSync(projectsDir)) continue;
      const caseCount = new Set(
        readdirSync(projectsDir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.slice(0, f.lastIndexOf('__'))),
      ).size;
      runs.push({
        dir,
        label: `${model} / ${ts}  (${caseCount} cases)`,
        caseCount,
        mtime: statSync(dir).mtimeMs,
      });
    }
  }
  return runs.sort((a, b) => b.mtime - a.mtime);
}

function pageHtml(): string {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PBL v2 — A/B viewer</title><style>${VIEWER_CSS}</style></head>
<body>
<header>
  <h1>PBL v2 — loop vs single-call</h1>
  <select id="runSel" title="选择一次 eval run"></select>
  <span class="meta" id="meta"></span>
</header>
<div class="layout"><nav id="nav"></nav><main id="main"></main></div>
<script>${CLIENT_RENDER_JS}
async function loadRun(){
  const dir = document.getElementById('runSel').value;
  if (!dir) return;
  try {
    const data = await (await fetch('/api/run?dir='+encodeURIComponent(dir))).json();
    renderRun(data);
  } catch (e) { document.getElementById('main').innerHTML = '<p class="missing">加载失败: '+esc(e.message||e)+'</p>'; }
}
async function boot(){
  const sel = document.getElementById('runSel');
  let runs = [];
  try { runs = await (await fetch('/api/runs')).json(); } catch (e) {}
  if (!runs.length){ document.getElementById('main').innerHTML='<p class="missing">results/ 下还没有 run。先跑 runner。</p>'; return; }
  sel.innerHTML = runs.map(r => '<option value="'+esc(r.dir)+'">'+esc(r.label)+'</option>').join('');
  sel.onchange = loadRun;
  loadRun();
}
boot();
</script>
</body></html>`;
}

function send(
  res: import('node:http').ServerResponse,
  code: number,
  type: string,
  body: string,
): void {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (url.pathname === '/') {
      return send(res, 200, 'text/html; charset=utf-8', pageHtml());
    }
    if (url.pathname === '/api/runs') {
      return send(res, 200, 'application/json', JSON.stringify(listRuns()));
    }
    if (url.pathname === '/api/run') {
      const dir = resolve(url.searchParams.get('dir') ?? '');
      // Path-traversal guard: only serve dirs under results/.
      if (!dir.startsWith(RESULTS_ROOT + '/') && dir !== RESULTS_ROOT) {
        return send(res, 403, 'application/json', JSON.stringify({ error: 'forbidden' }));
      }
      if (!existsSync(join(dir, 'projects'))) {
        return send(res, 404, 'application/json', JSON.stringify({ error: 'not a run dir' }));
      }
      return send(res, 200, 'application/json', JSON.stringify(collectRunData(dir)));
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (err) {
    send(res, 500, 'application/json', JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`PBL v2 A/B viewer → http://localhost:${PORT}`);
  console.log(`Serving runs from ${RESULTS_ROOT}`);
});
