import type { Scene, InteractiveContent } from '@/lib/types/stage';

export interface InteractiveScoOptions {
  scene: Scene;
  sceneIndex: number;
  totalScenes: number;
  allScoHrefs: string[];
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Builds the full HTML string for an interactive SCO page.
 *
 * The interactive HTML is embedded in an isolated <iframe srcdoc="..."> so its
 * own scripts cannot interfere with the SCORM bridge on the parent frame.
 * SCORM completion is set immediately on load (no grading for interactive scenes).
 */
export function buildInteractiveSco(opts: InteractiveScoOptions): string {
  const { scene, sceneIndex, totalScenes, allScoHrefs } = opts;

  if (scene.content.type !== 'interactive') return '';
  const content = scene.content as InteractiveContent;

  if (!content.html) return '';

  // Escape the HTML for use as a srcdoc attribute value
  const srcdoc = content.html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  const myHref = allScoHrefs[sceneIndex];
  const hasPrev = sceneIndex > 0;
  const hasNext = sceneIndex < totalScenes - 1;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(scene.title)}</title>
  <script src="../scorm_bridge.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; font-family: sans-serif; background: #1a1a1a; }
    .page-wrapper { display: flex; flex-direction: column; height: 100%; }
    .content-frame {
      flex: 1;
      border: none;
      width: 100%;
      background: #fff;
    }
    .nav-bar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 16px;
      background: #fff;
      border-top: 1px solid #e0e0e5;
      flex-shrink: 0;
    }
    .nav-bar button {
      background: #f5f5f7; border: 1.5px solid #d0d0d5;
      padding: 6px 18px; border-radius: 6px;
      cursor: pointer; font-size: 0.9rem; font-weight: 500;
    }
    .nav-bar button:hover { background: #e8e8ed; }
    .scene-counter { font-size: 0.85rem; color: #6e6e73; }
  </style>
</head>
<body>
<div class="page-wrapper">
  <iframe class="content-frame" srcdoc="${srcdoc}" sandbox="allow-scripts allow-same-origin allow-forms" title="${escHtml(scene.title)}"></iframe>
  <div class="nav-bar">
    ${hasPrev ? `<button onclick="SCORM.navigate(ALL_SCOS,'${myHref}','prev')">&#8592; Prev</button>` : '<span></span>'}
    <span class="scene-counter">${sceneIndex + 1} / ${totalScenes}</span>
    ${hasNext ? `<button onclick="SCORM.navigate(ALL_SCOS,'${myHref}','next')">Next &#8594;</button>` : '<span></span>'}
  </div>
</div>
<script>
var ALL_SCOS = ${JSON.stringify(allScoHrefs)};
window.addEventListener('load', function() {
  SCORM.init();
  SCORM.setCompleted();
});
window.addEventListener('beforeunload', function() {
  SCORM.finish();
});
</script>
</body>
</html>`;
}
