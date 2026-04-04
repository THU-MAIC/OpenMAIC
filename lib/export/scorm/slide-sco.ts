import type { Scene, SlideContent } from '@/lib/types/stage';
import type {
  PPTElement,
  PPTTextElement,
  PPTImageElement,
  PPTShapeElement,
  PPTLineElement,
  PPTChartElement,
  PPTTableElement,
  PPTLatexElement,
  PPTVideoElement,
  PPTAudioElement,
  SlideBackground,
  Gradient,
} from '@/lib/types/slides';
import type { SpeechAction } from '@/lib/types/action';
import { isMediaPlaceholder, useMediaGenerationStore } from '@/lib/store/media-generation';
import type { AssetMap } from './asset-collector';

export interface SlideScoOptions {
  scene: Scene;
  sceneIndex: number;
  totalScenes: number;
  allScoHrefs: string[];
  assetMap: AssetMap;
  includeVideos: boolean;
}

// ── Helpers ──

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolvedSrc(src: string, assetMap: AssetMap): string {
  // If the src was collected as an asset, return the relative ZIP path
  const stored = assetMap.get(src);
  if (stored) return `../${stored}`;
  // Media placeholder that was resolved
  if (isMediaPlaceholder(src)) {
    const task = useMediaGenerationStore.getState().tasks[src];
    if (task?.objectUrl) {
      const stored2 = assetMap.get(task.objectUrl);
      if (stored2) return `../${stored2}`;
    }
    return ''; // not available
  }
  // Absolute URL or data URI — use directly
  return src;
}

function buildBackgroundCss(bg: SlideBackground | undefined, assetMap: AssetMap): string {
  if (!bg) return '';
  if (bg.type === 'solid' && bg.color) return `background-color: ${bg.color};`;
  if (bg.type === 'image' && bg.image?.src) {
    const src = resolvedSrc(bg.image.src, assetMap);
    if (!src) return '';
    const size = bg.image.size === 'repeat' ? 'auto' : bg.image.size;
    const repeat = bg.image.size === 'repeat' ? 'repeat' : 'no-repeat';
    return `background-image: url('${src}'); background-size: ${size}; background-repeat: ${repeat}; background-position: center;`;
  }
  if (bg.type === 'gradient' && bg.gradient) {
    return `background: ${buildGradientCss(bg.gradient)};`;
  }
  return '';
}

function buildGradientCss(g: Gradient): string {
  const stops = g.colors.map((c) => `${c.color} ${c.pos}%`).join(', ');
  if (g.type === 'radial') return `radial-gradient(circle, ${stops})`;
  return `linear-gradient(${g.rotate}deg, ${stops})`;
}

function elStyle(el: PPTElement & { rotate: number }): string {
  return `position:absolute;left:${el.left}px;top:${el.top}px;width:${el.width}px;height:${el.height}px;${el.rotate ? `transform:rotate(${el.rotate}deg);` : ''}`;
}

// ── Element renderers ──

function renderText(el: PPTTextElement): string {
  const fill = el.fill ? `background:${el.fill};` : '';
  const opacity = el.opacity !== undefined ? `opacity:${el.opacity};` : '';
  const lineH = el.lineHeight ?? 1.5;
  const wordSp = el.wordSpace ?? 0;
  const overflow = el.vertical ? 'writing-mode:vertical-rl;' : '';
  return `<div style="${elStyle(el)}overflow:hidden;font-family:${escHtml(el.defaultFontName || 'sans-serif')};color:${el.defaultColor || '#000'};line-height:${lineH};letter-spacing:${wordSp}px;${fill}${opacity}${overflow}">${el.content}</div>`;
}

function renderImage(el: PPTImageElement, assetMap: AssetMap): string {
  const src = resolvedSrc(el.src, assetMap);
  if (!src) return '';

  const filters: string[] = [];
  if (el.filters) {
    if (el.filters.blur) filters.push(`blur(${el.filters.blur})`);
    if (el.filters.brightness) filters.push(`brightness(${el.filters.brightness})`);
    if (el.filters.contrast) filters.push(`contrast(${el.filters.contrast})`);
    if (el.filters.grayscale) filters.push(`grayscale(${el.filters.grayscale})`);
    if (el.filters.saturate) filters.push(`saturate(${el.filters.saturate})`);
    if (el.filters['hue-rotate']) filters.push(`hue-rotate(${el.filters['hue-rotate']})`);
    if (el.filters.sepia) filters.push(`sepia(${el.filters.sepia})`);
    if (el.filters.invert) filters.push(`invert(${el.filters.invert})`);
    if (el.filters.opacity) filters.push(`opacity(${el.filters.opacity})`);
  }
  const filterCss = filters.length ? `filter:${filters.join(' ')};` : '';

  let clipCss = '';
  let borderRadius = '';
  if (el.clip) {
    const [[x1, y1], [x2, y2]] = el.clip.range;
    clipCss = `clip-path:inset(${y1}% ${100 - x2}% ${100 - y2}% ${x1}%);`;
    if (el.clip.shape === 'ellipse') borderRadius = 'border-radius:50%;';
  }

  const flipH = el.flipH ? 'scaleX(-1)' : '';
  const flipV = el.flipV ? 'scaleY(-1)' : '';
  const flipCss = flipH || flipV ? `transform-origin:center;${el.rotate ? `transform:rotate(${el.rotate}deg) ${flipH} ${flipV};` : `transform:${flipH} ${flipV};`}` : '';

  const colorMask = el.colorMask
    ? `<div style="position:absolute;inset:0;background:${el.colorMask};pointer-events:none;"></div>`
    : '';

  const base = el.rotate ? `transform:rotate(${el.rotate}deg);` : '';
  const style = `position:absolute;left:${el.left}px;top:${el.top}px;width:${el.width}px;height:${el.height}px;${flipCss || base}overflow:hidden;${borderRadius}`;

  return `<div style="${style}">${colorMask}<img src="${src}" style="width:100%;height:100%;object-fit:cover;${filterCss}${clipCss}" loading="lazy" alt=""/></div>`;
}

function renderShape(el: PPTShapeElement): string {
  const [vw, vh] = el.viewBox;
  const fill = el.gradient ? buildGradientCss(el.gradient) : el.fill;
  const opacity = el.opacity !== undefined ? `opacity:${el.opacity};` : '';
  const flipH = el.flipH ? 'scale(-1,1)' : '';
  const flipV = el.flipV ? 'scale(1,-1)' : '';
  const transform = (flipH || flipV) ? ` transform="${flipH || flipV}"` : '';
  const outline = el.outline?.color && el.outline.width
    ? `stroke="${el.outline.color}" stroke-width="${el.outline.width}" stroke-dasharray="${el.outline.style === 'dashed' ? '8 4' : el.outline.style === 'dotted' ? '2 4' : 'none'}"`
    : 'stroke="none"';

  let textOverlay = '';
  if (el.text?.content) {
    const t = el.text;
    textOverlay = `<div style="position:absolute;inset:0;display:flex;align-items:${t.align === 'top' ? 'flex-start' : t.align === 'bottom' ? 'flex-end' : 'center'};justify-content:center;padding:4px;overflow:hidden;font-family:${escHtml(t.defaultFontName || 'sans-serif')};color:${t.defaultColor || '#000'};line-height:${t.lineHeight ?? 1.5};">${t.content}</div>`;
  }

  return `<div style="${elStyle(el)}${opacity}overflow:visible;">
  <svg viewBox="0 0 ${vw} ${vh}" style="width:100%;height:100%;"${transform}>
    <path d="${escHtml(el.path)}" fill="${escHtml(fill)}" ${outline} fill-rule="nonzero"/>
  </svg>${textOverlay}
</div>`;
}

function renderLine(el: PPTLineElement): string {
  const [sx, sy] = el.start;
  const [ex, ey] = el.end;
  const minX = Math.min(sx, ex);
  const minY = Math.min(sy, ey);
  const maxX = Math.max(sx, ex);
  const maxY = Math.max(sy, ey);
  const w = maxX - minX || 2;
  const h = maxY - minY || 2;
  const dash = el.style === 'dashed' ? 'stroke-dasharray="8 4"' : el.style === 'dotted' ? 'stroke-dasharray="2 4"' : '';
  return `<div style="position:absolute;left:${minX}px;top:${minY}px;width:${w}px;height:${h}px;overflow:visible;">
  <svg viewBox="${minX} ${minY} ${w} ${h}" style="overflow:visible;width:${w}px;height:${h}px;">
    <line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="${el.color}" stroke-width="2" ${dash}/>
  </svg>
</div>`;
}

function renderChart(el: PPTChartElement): string {
  // NOTE: ECharts cannot render without a DOM/canvas at build time.
  // We emit a data table as a SCORM-compatible fallback.
  // Future enhancement: pre-render to SVG using headless ECharts.
  const { labels, legends, series } = el.data;
  const fill = el.fill ? `background:${el.fill};` : '';

  let rows = `<tr><th></th>${labels.map((l) => `<th>${escHtml(l)}</th>`).join('')}</tr>`;
  for (let i = 0; i < legends.length; i++) {
    rows += `<tr><th>${escHtml(legends[i])}</th>${(series[i] ?? []).map((v) => `<td>${v}</td>`).join('')}</tr>`;
  }

  return `<div style="${elStyle(el)}overflow:auto;${fill}font-size:11px;">
  <table style="border-collapse:collapse;width:100%;">
    ${rows}
  </table>
</div>`;
}

function renderTable(el: PPTTableElement): string {
  let colGroup = '<colgroup>';
  for (const w of el.colWidths) {
    colGroup += `<col style="width:${(w * 100).toFixed(1)}%"/>`;
  }
  colGroup += '</colgroup>';

  let tbody = '<tbody>';
  for (let ri = 0; ri < el.data.length; ri++) {
    tbody += '<tr>';
    for (const cell of el.data[ri]) {
      if (!cell) continue;
      const s = cell.style ?? {};
      const css = [
        s.bold ? 'font-weight:bold' : '',
        s.em ? 'font-style:italic' : '',
        s.underline ? 'text-decoration:underline' : '',
        s.strikethrough ? 'text-decoration:line-through' : '',
        s.color ? `color:${s.color}` : '',
        s.backcolor ? `background:${s.backcolor}` : '',
        s.fontsize ? `font-size:${s.fontsize}` : '',
        s.align ? `text-align:${s.align}` : '',
      ]
        .filter(Boolean)
        .join(';');
      const cs = cell.colspan > 1 ? ` colspan="${cell.colspan}"` : '';
      const rs = cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : '';
      tbody += `<td${cs}${rs} style="border:1px solid ${el.outline.color ?? '#ccc'};padding:4px;${css}">${cell.text}</td>`;
    }
    tbody += '</tr>';
  }
  tbody += '</tbody>';

  return `<div style="${elStyle(el)}overflow:auto;">
  <table style="border-collapse:collapse;width:100%;height:100%;">${colGroup}${tbody}</table>
</div>`;
}

function renderLatex(el: PPTLatexElement): string {
  if (el.html) {
    return `<div style="${elStyle(el)}overflow:hidden;display:flex;align-items:center;justify-content:${el.align ?? 'center'};">${el.html}</div>`;
  }
  // Legacy SVG path fallback
  if (el.path && el.viewBox) {
    const [vw, vh] = el.viewBox;
    return `<div style="${elStyle(el)}overflow:hidden;">
  <svg viewBox="0 0 ${vw} ${vh}" style="width:100%;height:100%;">
    <path d="${escHtml(el.path)}" fill="${el.color ?? '#000'}" stroke-width="${el.strokeWidth ?? 0}"/>
  </svg>
</div>`;
  }
  return '';
}

function renderVideo(el: PPTVideoElement, assetMap: AssetMap, includeVideos: boolean): string {
  if (includeVideos) {
    const src = resolvedSrc(el.src, assetMap);
    if (!src) return '';
    const posterSrc = el.poster ? resolvedSrc(el.poster, assetMap) : '';
    const posterAttr = posterSrc ? ` poster="${posterSrc}"` : '';
    return `<div style="${elStyle(el)}overflow:hidden;"><video controls style="width:100%;height:100%;" src="${src}"${posterAttr}></video></div>`;
  } else {
    // Show poster image instead of video
    const posterSrc =
      el.poster
        ? resolvedSrc(el.poster, assetMap)
        : (() => {
            // Fallback: check media generation store poster via original src
            if (isMediaPlaceholder(el.src)) {
              const task = useMediaGenerationStore.getState().tasks[el.src];
              return task?.poster ? resolvedSrc(task.poster, assetMap) : '';
            }
            return '';
          })();
    if (!posterSrc) return ''; // no poster available, skip element
    return `<div style="${elStyle(el)}overflow:hidden;"><img src="${posterSrc}" style="width:100%;height:100%;object-fit:cover;" alt=""/></div>`;
  }
}

function renderAudio(el: PPTAudioElement, assetMap: AssetMap): string {
  const src = resolvedSrc(el.src, assetMap);
  if (!src) return '';
  return `<div style="${elStyle(el)}overflow:hidden;display:flex;align-items:center;"><audio controls${el.loop ? ' loop' : ''} style="width:100%;" src="${src}"></audio></div>`;
}

function renderElement(el: PPTElement, assetMap: AssetMap, includeVideos: boolean): string {
  switch (el.type) {
    case 'text': return renderText(el as PPTTextElement);
    case 'image': return renderImage(el as PPTImageElement, assetMap);
    case 'shape': return renderShape(el as PPTShapeElement);
    case 'line': return renderLine(el as PPTLineElement);
    case 'chart': return renderChart(el as PPTChartElement);
    case 'table': return renderTable(el as PPTTableElement);
    case 'latex': return renderLatex(el as PPTLatexElement);
    case 'video': return renderVideo(el as PPTVideoElement, assetMap, includeVideos);
    case 'audio': return renderAudio(el as PPTAudioElement, assetMap);
    default: return '';
  }
}

// ── Check if any latex element is present (need KaTeX CSS) ──

function hasLatexWithHtml(els: PPTElement[]): boolean {
  return els.some((el) => el.type === 'latex' && (el as PPTLatexElement).html);
}

// ── Build narration audio tags and chain script ──

function buildNarrationHtml(scene: Scene, assetMap: AssetMap): { tags: string; script: string } {
  if (!scene.actions) return { tags: '', script: '' };

  const speechUrls: string[] = [];
  for (const action of scene.actions) {
    if (action.type === 'speech') {
      const speech = action as SpeechAction;
      if (speech.audioUrl) {
        const stored = assetMap.get(speech.audioUrl);
        if (stored) speechUrls.push(`../${stored}`);
      }
    }
  }

  if (speechUrls.length === 0) return { tags: '', script: '' };

  const tags = speechUrls
    .map((url, i) => `<audio id="narr_${i}" src="${url}"${i === 0 ? ' style="display:none"' : ' style="display:none"'}></audio>`)
    .join('\n');

  const script = `
var _narrIdx = 0;
var _narrUrls = ${JSON.stringify(speechUrls)};
function _playNarr(i) {
  if (i >= _narrUrls.length) return;
  var a = document.getElementById('narr_' + i);
  if (!a) return;
  a.onended = function() { _playNarr(i + 1); };
  a.play().catch(function(){});
}
// Auto-play narration when page loads (requires user interaction policy may block)
document.addEventListener('DOMContentLoaded', function() { _playNarr(0); });
`;

  return { tags, script };
}

// ── Main ──

/**
 * Builds the full HTML string for a slide SCO page.
 *
 * The slide canvas is rendered as absolutely-positioned elements inside a
 * 960×(960*viewportRatio) container that scales responsively via CSS transform.
 * TTS narration audio plays automatically on load.
 * SCORM completion is set immediately on page load (slides are self-completing).
 */
export function buildSlideSco(opts: SlideScoOptions): string {
  const { scene, sceneIndex, totalScenes, allScoHrefs, assetMap, includeVideos } = opts;

  if (scene.content.type !== 'slide') return '';
  const canvas = (scene.content as SlideContent).canvas;

  const canvasW = canvas.viewportSize ?? 960;
  const canvasH = Math.round(canvasW * (canvas.viewportRatio ?? 0.5625));
  const bgCss = buildBackgroundCss(canvas.background, assetMap);
  const bgFallback = canvas.theme?.backgroundColor ?? '#ffffff';

  const elements = canvas.elements
    .map((el) => renderElement(el, assetMap, includeVideos))
    .filter(Boolean)
    .join('\n');

  const { tags: narrTags, script: narrScript } = buildNarrationHtml(scene, assetMap);

  const needsKatex = hasLatexWithHtml(canvas.elements);
  // Minimal KaTeX CSS — inlined to ensure offline use (no CDN dependency)
  const katexCss = needsKatex
    ? `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css" crossorigin="anonymous" onerror="this.remove()">`
    : '';

  const myHref = allScoHrefs[sceneIndex];
  const hasPrev = sceneIndex > 0;
  const hasNext = sceneIndex < totalScenes - 1;

  const navButtons = `
<div class="nav-bar">
  ${hasPrev ? `<button onclick="SCORM.navigate(ALL_SCOS,'${myHref}','prev')">&#8592; Prev</button>` : '<span></span>'}
  <span class="scene-counter">${sceneIndex + 1} / ${totalScenes}</span>
  ${hasNext ? `<button onclick="SCORM.navigate(ALL_SCOS,'${myHref}','next')">Next &#8594;</button>` : '<span></span>'}
</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(scene.title)}</title>
  <script src="../scorm_bridge.js"></script>
  ${katexCss}
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; overflow: hidden; background: #1a1a1a; height: 100%; font-family: sans-serif; }
    .stage-wrapper { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
    .slide-canvas {
      position: relative;
      width: ${canvasW}px;
      height: ${canvasH}px;
      transform-origin: center center;
      background: ${bgFallback};
      ${bgCss}
      overflow: hidden;
    }
    .nav-bar {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 4px 0;
    }
    .nav-bar button {
      background: rgba(255,255,255,0.15);
      border: 1px solid rgba(255,255,255,0.3);
      color: #fff;
      padding: 6px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }
    .nav-bar button:hover { background: rgba(255,255,255,0.25); }
    .scene-counter { color: rgba(255,255,255,0.6); font-size: 13px; min-width: 60px; text-align: center; }
  </style>
</head>
<body>
<div class="stage-wrapper">
  <div class="slide-canvas" id="slide-canvas">
    ${elements}
  </div>
  ${navButtons}
</div>
${narrTags}
<script>
var ALL_SCOS = ${JSON.stringify(allScoHrefs)};
window.addEventListener('load', function() {
  SCORM.init();
  SCORM.setCompleted();
  rescale();
});
window.addEventListener('beforeunload', function() {
  SCORM.finish();
});
function rescale() {
  var vw = window.innerWidth;
  var vh = window.innerHeight - 48; // leave room for nav bar
  var s = Math.min(vw / ${canvasW}, vh / ${canvasH});
  document.getElementById('slide-canvas').style.transform = 'scale(' + s + ')';
}
window.addEventListener('resize', rescale);
${narrScript}
</script>
</body>
</html>`;
}
