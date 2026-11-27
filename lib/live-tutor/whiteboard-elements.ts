import katex from 'katex';
import {
  safeKatexOptions,
  type PPTElement,
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
    } else {
      next.push({ id, kind: 'text', content, color: '#1f2937' });
    }
  }
  return next;
}

/**
 * Projects structured tutor steps onto an OpenMAIC `@openmaic/dsl` Whiteboard
 * so `WhiteboardFrame` / `WhiteboardCanvas` renders text and LaTeX natively.
 */
export function buildWhiteboardFromSteps(
  steps: WhiteboardStepItem[],
  whiteboardId = 'live-tutor-whiteboard',
): Whiteboard {
  const elements: PPTElement[] = [];
  let cursorY = 44;

  for (const step of steps) {
    if (step.kind === 'latex') {
      const latexEl: PPTLatexElement = {
        id: step.id,
        type: 'latex',
        left: 72,
        top: cursorY,
        width: 856,
        height: 76,
        rotate: 0,
        latex: step.content,
        html: renderSafeLatexHtml(step.content, true),
        color: step.color ?? '#111827',
        fixedRatio: true,
      };
      elements.push(latexEl);
      cursorY += 92;
      continue;
    }

    const isHeading = step.kind === 'heading';
    const fontSize = isHeading ? 22 : 18;
    const approxLines = Math.max(1, Math.ceil(step.content.length / 64));
    const height = Math.max(isHeading ? 48 : 44, approxLines * (fontSize + 14) + 12);

    const textEl: PPTTextElement = {
      id: step.id,
      type: 'text',
      left: 60,
      top: cursorY,
      width: 880,
      height,
      rotate: 0,
      content: paragraphHtml(step.content, fontSize, isHeading),
      defaultFontName: 'Inter',
      defaultColor: step.color ?? (isHeading ? '#4f46e5' : '#1f2937'),
    };
    elements.push(textEl);
    cursorY += height + 14;
  }

  return {
    id: whiteboardId,
    viewportSize: 1000,
    viewportRatio: 0.5625,
    elements,
  };
}
