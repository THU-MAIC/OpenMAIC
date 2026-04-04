/**
 * slide-sco.ts
 * Builds the HTML fragment (a <section> element) for a slide scene.
 * Assets use paths relative to the ZIP root (no "../").
 */
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

export interface SlideSceneMeta {
  type: 'slide';
  sceneId: string;        // e.g. "scene-0"
  canvasId: string;       // e.g. "canvas-0"
  scalerId: string;       // e.g. "scaler-0"
  cw: number;             // canvas width px
  ch: number;             // canvas height px
  narrIds: string[];      // IDs of <audio> narration elements to chain-play
  hasNarration: boolean;
}

export interface SlideSectionResult {
  html: string;
  meta: SlideSceneMeta;
  needsKatex: boolean;
}

// ── Helpers ──

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Resolve a src to a ZIP-root-relative path. */
function assetPath(src: string, assetMap: AssetMap): string {
  if (!src) return '';
  const stored = assetMap.get(src);
  if (stored) return stored; // e.g. "assets/images/..."
  if (isMediaPlaceholder(src)) {
    const task = useMediaGenerationStore.getState().tasks[src];
    if (task?.objectUrl) {
      const s2 = assetMap.get(task.objectUrl);
      if (s2) return s2;
    }
    return '';
  }
  // Absolute URL or data URI — use as-is
  return src;
}

function buildBackgroundCss(bg: SlideBackground | undefined, assetMap: AssetMap): string {
  if (!bg) return '';
  if (bg.type === 'solid' && bg.color) return `background-color:${bg.color};`;
  if (bg.type === 'image' && bg.image?.src) {
    const p = assetPath(bg.image.src, assetMap);
    if (!p) return '';
    const size = bg.image.size === 'repeat' ? 'auto' : bg.image.size;
    const repeat = bg.image.size === 'repeat' ? 'repeat' : 'no-repeat';
    return `background-image:url('${p}');background-size:${size};background-repeat:${repeat};background-position:center;`;
  }
  if (bg.type === 'gradient' && bg.gradient) return `background:${gradientCss(bg.gradient)};`;
  return '';
}

function gradientCss(g: Gradient): string {
  const stops = g.colors.map((c) => `${c.color} ${c.pos}%`).join(', ');
  return g.type === 'radial'
    ? `radial-gradient(circle, ${stops})`
    : `linear-gradient(${g.rotate}deg, ${stops})`;
}

function elBaseStyle(el: { left: number; top: number; width: number; height: number; rotate: number }): string {
  return `position:absolute;left:${el.left}px;top:${el.top}px;width:${el.width}px;height:${el.height}px;${el.rotate ? `transform:rotate(${el.rotate}deg);` : ''}`;
}

// ── Element renderers ──

function renderText(el: PPTTextElement): string {
  const fill = el.fill ? `background:${el.fill};` : '';
  const opacity = el.opacity !== undefined ? `opacity:${el.opacity};` : '';
  const lh = el.lineHeight ?? 1.5;
  const ws = el.wordSpace ?? 0;
  const vert = el.vertical ? 'writing-mode:vertical-rl;' : '';
  return `<div style="${elBaseStyle(el)}overflow:hidden;font-family:${escHtml(el.defaultFontName || 'sans-serif')};color:${el.defaultColor || '#000'};line-height:${lh};letter-spacing:${ws}px;${fill}${opacity}${vert}">${el.content}</div>`;
}

function renderImage(el: PPTImageElement, assetMap: AssetMap): string {
  const p = assetPath(el.src, assetMap);
  if (!p) return '';
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
  let br = '';
  if (el.clip) {
    const [[x1, y1], [x2, y2]] = el.clip.range;
    clipCss = `clip-path:inset(${y1}% ${100 - x2}% ${100 - y2}% ${x1}%);`;
    if (el.clip.shape === 'ellipse') br = 'border-radius:50%;';
  }
  const flipH = el.flipH ? 'scaleX(-1)' : '';
  const flipV = el.flipV ? 'scaleY(-1)' : '';
  const flipT = (flipH || flipV) && !el.rotate ? `transform:${[flipH, flipV].filter(Boolean).join(' ')};` : '';
  const colorMask = el.colorMask
    ? `<div style="position:absolute;inset:0;background:${el.colorMask};pointer-events:none;"></div>`
    : '';
  const rot = el.rotate ? `transform:rotate(${el.rotate}deg);` : '';
  return `<div style="position:absolute;left:${el.left}px;top:${el.top}px;width:${el.width}px;height:${el.height}px;${rot}overflow:hidden;${br}">
  ${colorMask}<img src="${p}" style="width:100%;height:100%;object-fit:cover;${filterCss}${clipCss}${flipT}" loading="lazy" alt=""/>
</div>`;
}

/**
 * Build an SVG <defs> gradient block and return the fill reference.
 * SVG fill attribute does not support CSS gradient syntax — must use <defs>.
 */
function svgGradientDef(el: PPTShapeElement): { defs: string; fillRef: string } {
  if (!el.gradient) return { defs: '', fillRef: escHtml(el.fill || 'none') };
  const gradId = `grad-${el.id}`;
  const stops = el.gradient.colors
    .map((c) => `<stop offset="${c.pos}%" stop-color="${escHtml(c.color)}"/>`)
    .join('');
  let defs: string;
  if (el.gradient.type === 'radial') {
    defs = `<defs><radialGradient id="${gradId}" cx="50%" cy="50%" r="50%" gradientUnits="objectBoundingBox">${stops}</radialGradient></defs>`;
  } else {
    // Linear: default direction left→right, rotated by el.gradient.rotate around center
    defs = `<defs><linearGradient id="${gradId}" x1="0" y1="0.5" x2="1" y2="0.5" gradientUnits="objectBoundingBox" gradientTransform="rotate(${el.gradient.rotate},0.5,0.5)">${stops}</linearGradient></defs>`;
  }
  return { defs, fillRef: `url(#${gradId})` };
}

function renderShape(el: PPTShapeElement): string {
  const [vw, vh] = el.viewBox;
  const opacity = el.opacity !== undefined ? `opacity:${el.opacity};` : '';
  const flipH = el.flipH ? 'scale(-1,1)' : '';
  const flipV = el.flipV ? 'scale(1,-1)' : '';
  const svgTransform = (flipH || flipV) ? ` transform="${[flipH, flipV].filter(Boolean).join(' ')}"` : '';
  const outline = el.outline?.color && el.outline.width
    ? `stroke="${escHtml(el.outline.color)}" stroke-width="${el.outline.width}" stroke-dasharray="${el.outline.style === 'dashed' ? '8 4' : el.outline.style === 'dotted' ? '2 4' : 'none'}"`
    : 'stroke="none"';
  let text = '';
  if (el.text?.content) {
    const t = el.text;
    const va = t.align === 'top' ? 'flex-start' : t.align === 'bottom' ? 'flex-end' : 'center';
    text = `<div style="position:absolute;inset:0;display:flex;align-items:${va};justify-content:center;padding:4px;overflow:hidden;font-family:${escHtml(t.defaultFontName || 'sans-serif')};color:${t.defaultColor || '#000'};line-height:${t.lineHeight ?? 1.5};">${t.content}</div>`;
  }
  const { defs, fillRef } = svgGradientDef(el);
  return `<div style="${elBaseStyle(el)}${opacity}overflow:visible;">
  <svg viewBox="0 0 ${vw} ${vh}" style="width:100%;height:100%;"${svgTransform}>
    ${defs}<path d="${escHtml(el.path)}" fill="${fillRef}" ${outline} fill-rule="nonzero"/>
  </svg>${text}
</div>`;
}

function renderLine(el: PPTLineElement): string {
  const [sx, sy] = el.start;
  const [ex, ey] = el.end;
  const minX = Math.min(sx, ex);
  const minY = Math.min(sy, ey);
  const w = Math.max(Math.abs(ex - sx), 2);
  const h = Math.max(Math.abs(ey - sy), 2);
  const dash = el.style === 'dashed' ? 'stroke-dasharray="8 4"' : el.style === 'dotted' ? 'stroke-dasharray="2 4"' : '';
  return `<div style="position:absolute;left:${minX}px;top:${minY}px;width:${w}px;height:${h}px;overflow:visible;">
  <svg style="overflow:visible;width:${w}px;height:${h}px;" viewBox="${minX} ${minY} ${w} ${h}">
    <line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="${escHtml(el.color)}" stroke-width="2" ${dash}/>
  </svg>
</div>`;
}

function renderChart(el: PPTChartElement): string {
  // NOTE: ECharts cannot render at build time. Fallback: data table.
  // Future improvement: pre-render to SVG using headless ECharts.
  const { labels, legends, series } = el.data;
  const fill = el.fill ? `background:${el.fill};` : '';
  let rows = `<tr><th></th>${labels.map((l) => `<th>${escHtml(l)}</th>`).join('')}</tr>`;
  for (let i = 0; i < legends.length; i++) {
    rows += `<tr><th>${escHtml(legends[i])}</th>${(series[i] ?? []).map((v) => `<td style="text-align:right">${v}</td>`).join('')}</tr>`;
  }
  return `<div style="${elBaseStyle(el)}overflow:auto;${fill}font-size:11px;">
  <table style="border-collapse:collapse;width:100%;">${rows}</table>
</div>`;
}

function renderTable(el: PPTTableElement): string {
  let colGroup = '<colgroup>';
  for (const w of el.colWidths) colGroup += `<col style="width:${(w * 100).toFixed(1)}%"/>`;
  colGroup += '</colgroup>';
  let tbody = '<tbody>';
  for (const row of el.data) {
    tbody += '<tr>';
    for (const cell of row) {
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
      ].filter(Boolean).join(';');
      const cs = cell.colspan > 1 ? ` colspan="${cell.colspan}"` : '';
      const rs = cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : '';
      tbody += `<td${cs}${rs} style="border:1px solid ${escHtml(el.outline.color ?? '#ccc')};padding:4px;${css}">${cell.text}</td>`;
    }
    tbody += '</tr>';
  }
  tbody += '</tbody>';
  return `<div style="${elBaseStyle(el)}overflow:auto;">
  <table style="border-collapse:collapse;width:100%;height:100%;">${colGroup}${tbody}</table>
</div>`;
}

function renderLatex(el: PPTLatexElement): string {
  if (el.html) {
    return `<div style="${elBaseStyle(el)}overflow:hidden;display:flex;align-items:center;justify-content:${el.align ?? 'center'};">${el.html}</div>`;
  }
  if (el.path && el.viewBox) {
    const [vw, vh] = el.viewBox;
    return `<div style="${elBaseStyle(el)}overflow:hidden;">
  <svg viewBox="0 0 ${vw} ${vh}" style="width:100%;height:100%;">
    <path d="${escHtml(el.path)}" fill="${el.color ?? '#000'}" stroke-width="${el.strokeWidth ?? 0}"/>
  </svg>
</div>`;
  }
  return '';
}

function renderVideo(el: PPTVideoElement, assetMap: AssetMap, includeVideos: boolean): string {
  if (includeVideos) {
    const p = assetPath(el.src, assetMap);
    if (!p) return '';
    const posterP = el.poster ? assetPath(el.poster, assetMap) : '';
    const posterAttr = posterP ? ` poster="${posterP}"` : '';
    return `<div style="${elBaseStyle(el)}overflow:hidden;"><video controls style="width:100%;height:100%;" src="${p}"${posterAttr}></video></div>`;
  }
  // Video replaced by poster
  const posterSrc = el.poster
    ? assetPath(el.poster, assetMap)
    : (() => {
        if (isMediaPlaceholder(el.src)) {
          const task = useMediaGenerationStore.getState().tasks[el.src];
          return task?.poster ? assetPath(task.poster, assetMap) : '';
        }
        return '';
      })();
  if (!posterSrc) return '';
  return `<div style="${elBaseStyle(el)}overflow:hidden;"><img src="${posterSrc}" style="width:100%;height:100%;object-fit:cover;" alt=""/></div>`;
}

function renderAudio(el: PPTAudioElement, assetMap: AssetMap): string {
  const p = assetPath(el.src, assetMap);
  if (!p) return '';
  return `<div style="${elBaseStyle(el)}overflow:hidden;display:flex;align-items:center;"><audio controls${el.loop ? ' loop' : ''} style="width:100%;" src="${p}"></audio></div>`;
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

function hasLatex(els: PPTElement[]): boolean {
  return els.some((el) => el.type === 'latex' && (el as PPTLatexElement).html);
}

// ── Public API ──

export interface SlideSectionOptions {
  scene: Scene;
  sceneIndex: number;
  assetMap: AssetMap;
  includeVideos: boolean;
}

/**
 * Builds the HTML <section> fragment for a slide scene.
 * Asset paths are relative to the ZIP root (no "../").
 */
export function buildSlideSection(opts: SlideSectionOptions): SlideSectionResult {
  const { scene, sceneIndex, assetMap, includeVideos } = opts;

  const canvas = (scene.content as SlideContent).canvas;
  const cw = canvas.viewportSize ?? 960;
  const ch = Math.round(cw * (canvas.viewportRatio ?? 0.5625));

  const sceneId = `scene-${sceneIndex}`;
  const canvasId = `canvas-${sceneIndex}`;
  const scalerId = `scaler-${sceneIndex}`;

  const bgCss = buildBackgroundCss(canvas.background, assetMap);
  const bgFallback = canvas.theme?.backgroundColor ?? '#ffffff';

  const elements = canvas.elements
    .map((el) => renderElement(el, assetMap, includeVideos))
    .filter(Boolean)
    .join('\n    ');

  // TTS narration audio elements
  // Look up by audioUrl first, then by idb:{audioId} (for IndexedDB-stored audio)
  const narrIds: string[] = [];
  let narrTags = '';
  if (scene.actions) {
    let idx = 0;
    for (const action of scene.actions) {
      if (action.type === 'speech') {
        const speech = action as SpeechAction;
        const mapKey = speech.audioUrl || (speech.audioId ? `idb:${speech.audioId}` : '');
        if (mapKey) {
          const p = assetMap.get(mapKey);
          if (p) {
            const id = `narr-${sceneIndex}-${idx}`;
            narrIds.push(id);
            narrTags += `<audio id="${id}" src="${p}" style="display:none"></audio>\n  `;
            idx++;
          }
        }
      }
    }
  }

  const html = `<section id="${sceneId}" class="om-scene om-slide" data-title="${escHtml(scene.title)}" style="display:none">
  <div class="om-scaler" id="${scalerId}">
    <div class="om-canvas" id="${canvasId}" style="width:${cw}px;height:${ch}px;background:${bgFallback};${bgCss}">
      ${elements}
    </div>
  </div>
  ${narrTags}</section>`;

  const meta: SlideSceneMeta = {
    type: 'slide',
    sceneId,
    canvasId,
    scalerId,
    cw,
    ch,
    narrIds,
    hasNarration: narrIds.length > 0,
  };

  return { html, meta, needsKatex: hasLatex(canvas.elements) };
}

export type { PPTElement };
