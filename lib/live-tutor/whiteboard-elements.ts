import katex from 'katex';
import {
  safeKatexOptions,
  type PPTElement,
  type PPTImageElement,
  type PPTLatexElement,
  type PPTTextElement,
  type Whiteboard,
} from '@openmaic/dsl';
import type { WhiteboardOp, WhiteboardStepItem } from './types';

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function paragraphHtml(text: string, fontSize: number, bold = false): string {
  const safe = escapeHtml(text);
  const inner = bold ? `<strong>${safe}</strong>` : safe;
  return `<p style="font-size: ${fontSize}px; line-height: 1.45;">${inner}</p>`;
}

export function renderSafeLatexHtml(latex: string, displayMode = true): string {
  try {
    return katex.renderToString(
      latex,
      safeKatexOptions({
        throwOnError: false,
        displayMode,
        output: 'html',
      }),
    );
  } catch {
    return escapeHtml(latex);
  }
}

/**
 * Strictly sanitizes an LLM-generated SVG diagram so it can be rendered safely
 * as a self-contained vector `data:image/svg+xml` image inside OpenMAIC's whiteboard.
 */
export function sanitizeSvgDiagram(rawSvg: string): string | null {
  const cleaned = rawSvg
    .replace(/```(?:svg|xml|html)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  const match = cleaned.match(/<svg[\s\S]*?<\/svg>/i);
  if (!match) return null;

  let svg = match[0]
    // Strip active / external-loading elements
    .replace(/<(script|foreignObject|iframe|object|embed|use|image|link)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|foreignObject|iframe|object|embed|use|image|link)\b[^>]*\/?>/gi, '')
    // Strip inline event handlers
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // Strip javascript: and external http(s) URLs in href/src/style attributes
    .replace(/(?:xlink:)?href\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/url\(\s*['"]?\s*https?:[^)]*\)/gi, 'none');

  if (!/\bxmlns\s*=/i.test(svg)) {
    svg = svg.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (!/\bviewBox\s*=/i.test(svg)) {
    svg = svg.replace(/^<svg\b/i, '<svg viewBox="0 0 600 340"');
  }
  return svg;
}

/**
 * Strips raw SVG/XML markup or fenced code blocks that Gemini Live occasionally
 * echoes into text captions alongside a `draw_whiteboard_diagram` tool call.
 */
export function sanitizeLiveCaption(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/```[\s\S]*$/g, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<svg\b[\s\S]*$/gi, ' ')
    .replace(/<\/?[a-z][a-z0-9:_-]*(?:\s[^>]*)?>/gi, ' ')
    .replace(/<[a-z][a-z0-9:_-]*\s[^>]*$/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function applyWhiteboardOps(
  current: WhiteboardStepItem[],
  ops: WhiteboardOp[],
): WhiteboardStepItem[] {
  let next = [...current];
  for (const item of ops) {
    if (item.op === 'clear') {
      next = [];
      continue;
    }
    const content = item.content?.trim();
    if (!content) continue;
    const id = `lt-wb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (item.op === 'add_heading') {
      next.push({ id, kind: 'heading', content, color: '#4f46e5' });
    } else if (item.op === 'add_formula') {
      next.push({ id, kind: 'latex', content, color: '#111827' });
    } else if (item.op === 'add_diagram') {
      const safeSvg = sanitizeSvgDiagram(content);
      if (safeSvg) {
        next.push({
          id,
          kind: 'diagram',
          content: safeSvg,
          caption: item.caption?.trim() || undefined,
        });
      }
    } else {
      next.push({ id, kind: 'text', content, color: '#1f2937' });
    }
  }
  return next;
}

const BOARD_VIEWPORT_SIZE = 1000;
const BOARD_VIEWPORT_RATIO = 0.5625;
const BOARD_MAX_VIEWPORT_RATIO = 1;
const BOARD_HEIGHT = Math.floor(BOARD_VIEWPORT_SIZE * BOARD_VIEWPORT_RATIO); // 562
const BOARD_MAX_SUPPORTED_HEIGHT = Math.floor(BOARD_VIEWPORT_SIZE * BOARD_MAX_VIEWPORT_RATIO); // 1000
const BOARD_TOP_PADDING = 28;
const BOARD_BOTTOM_PADDING = 20;
const BOARD_MAX_Y = BOARD_HEIGHT - BOARD_BOTTOM_PADDING; // 542
const BOARD_MAX_SUPPORTED_Y = BOARD_MAX_SUPPORTED_HEIGHT - BOARD_BOTTOM_PADDING; // 980
const BOARD_AVAILABLE_HEIGHT = BOARD_MAX_Y - BOARD_TOP_PADDING; // 514

interface MeasuredStep {
  step: WhiteboardStepItem;
  captionHeight: number;
  bodyHeight: number;
  gapAfter: number;
  totalHeight: number;
}

function measureStep(step: WhiteboardStepItem): MeasuredStep {
  if (step.kind === 'diagram') {
    const captionHeight = step.caption ? 34 : 0;
    const bodyHeight = 250;
    const gapAfter = 14;
    return {
      step,
      captionHeight,
      bodyHeight,
      gapAfter,
      totalHeight: captionHeight + bodyHeight + gapAfter,
    };
  }
  if (step.kind === 'latex') {
    const bodyHeight = 68;
    const gapAfter = 12;
    return { step, captionHeight: 0, bodyHeight, gapAfter, totalHeight: bodyHeight + gapAfter };
  }
  const isHeading = step.kind === 'heading';
  const fontSize = isHeading ? 21 : 17;
  const approxLines = Math.max(1, Math.ceil(step.content.length / 66));
  const bodyHeight = Math.max(isHeading ? 42 : 38, approxLines * (fontSize + 12) + 10);
  const gapAfter = 10;
  return { step, captionHeight: 0, bodyHeight, gapAfter, totalHeight: bodyHeight + gapAfter };
}

/**
 * Projects structured tutor steps onto an OpenMAIC `@openmaic/dsl` Whiteboard
 * so `WhiteboardFrame` / `WhiteboardCanvas` renders text, LaTeX, and vector diagrams natively
 * while keeping every element strictly within the declared 1000×562.5 board viewport.
 */
export function buildWhiteboardFromSteps(
  steps: WhiteboardStepItem[],
  whiteboardId = 'live-tutor-whiteboard',
  startY = BOARD_TOP_PADDING,
): Whiteboard {
  // Keep generated sheets within the renderer's supported ratio range (<= 1.0, i.e. <= 1000px tall)
  const topPadding = Math.max(
    BOARD_TOP_PADDING,
    Math.min(Math.round(startY), BOARD_MAX_SUPPORTED_Y - 120),
  );
  const availableHeight = Math.max(
    120,
    Math.min(BOARD_AVAILABLE_HEIGHT, BOARD_MAX_SUPPORTED_Y - topPadding),
  );
  const maxSectionY = Math.min(topPadding + availableHeight, BOARD_MAX_SUPPORTED_Y);
  const measured = steps.map(measureStep);

  // Keep the most recent window of steps that fits within the tutor section height
  const selected: MeasuredStep[] = [];
  let usedHeight = 0;
  for (let i = measured.length - 1; i >= 0; i--) {
    const item = measured[i];
    const cost = selected.length === 0 ? item.captionHeight + item.bodyHeight : item.totalHeight;
    if (selected.length > 0 && usedHeight + cost > availableHeight) {
      break;
    }
    selected.unshift(item);
    usedHeight += cost;
  }

  // If the most recent heading scrolled off the top, keep it pinned when space permits
  const latestHeading = [...measured].reverse().find((m) => m.step.kind === 'heading');
  if (
    latestHeading &&
    !selected.includes(latestHeading) &&
    usedHeight + latestHeading.totalHeight <= availableHeight
  ) {
    selected.unshift(latestHeading);
  }

  const elements: PPTElement[] = [];
  let cursorY = topPadding;

  for (const item of selected) {
    const { step } = item;
    if (step.kind === 'diagram') {
      if (step.caption) {
        const captionEl: PPTTextElement = {
          id: `${step.id}-cap`,
          type: 'text',
          left: 60,
          top: cursorY,
          width: 880,
          height: 30,
          rotate: 0,
          content: paragraphHtml(step.caption, 16, true),
          defaultFontName: 'Inter',
          defaultColor: '#4f46e5',
        };
        elements.push(captionEl);
        cursorY += item.captionHeight;
      }
      const clampedHeight = Math.max(120, Math.min(item.bodyHeight, maxSectionY - cursorY));
      const imgEl: PPTImageElement = {
        id: step.id,
        type: 'image',
        left: 130,
        top: cursorY,
        width: 740,
        height: clampedHeight,
        rotate: 0,
        fixedRatio: true,
        src: svgToDataUrl(step.content),
        radius: 12,
      };
      elements.push(imgEl);
      cursorY += clampedHeight + item.gapAfter;
      continue;
    }

    if (step.kind === 'latex') {
      const clampedHeight = Math.max(44, Math.min(item.bodyHeight, maxSectionY - cursorY));
      const latexEl: PPTLatexElement = {
        id: step.id,
        type: 'latex',
        left: 72,
        top: cursorY,
        width: 856,
        height: clampedHeight,
        rotate: 0,
        latex: step.content,
        html: renderSafeLatexHtml(step.content, true),
        color: step.color ?? '#111827',
        fixedRatio: true,
      };
      elements.push(latexEl);
      cursorY += clampedHeight + item.gapAfter;
      continue;
    }

    const isHeading = step.kind === 'heading';
    const fontSize = isHeading ? 21 : 17;
    const clampedHeight = Math.max(36, Math.min(item.bodyHeight, maxSectionY - cursorY));

    const textEl: PPTTextElement = {
      id: step.id,
      type: 'text',
      left: 60,
      top: cursorY,
      width: 880,
      height: clampedHeight,
      rotate: 0,
      content: paragraphHtml(step.content, fontSize, isHeading),
      defaultFontName: 'Inter',
      defaultColor: step.color ?? (isHeading ? '#4f46e5' : '#1f2937'),
    };
    elements.push(textEl);
    cursorY += clampedHeight + item.gapAfter;
  }

  const requiredHeight = Math.max(topPadding, cursorY) + BOARD_BOTTOM_PADDING;
  const requiredRatio = requiredHeight / BOARD_VIEWPORT_SIZE;
  return {
    id: whiteboardId,
    viewportSize: BOARD_VIEWPORT_SIZE,
    viewportRatio: Math.min(
      BOARD_MAX_VIEWPORT_RATIO,
      Math.max(BOARD_VIEWPORT_RATIO, requiredRatio),
    ),
    elements,
  };
}
