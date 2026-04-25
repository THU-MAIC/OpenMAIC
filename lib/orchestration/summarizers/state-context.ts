import type { StatelessChatRequest } from '@/lib/types/chat';
import { buildWhiteboardConflicts } from './whiteboard-conflicts';

// ==================== Element Summarization ====================

/**
 * Strip HTML tags to extract plain text
 */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

/**
 * Summarize a single PPT element into a one-line description
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PPTElement variants have heterogeneous shapes
function summarizeElement(el: any): string {
  const id = el.id ? `[id:${el.id}]` : '';
  const pos = `at (${Math.round(el.left)},${Math.round(el.top)})`;
  const size =
    el.width != null && el.height != null
      ? ` size ${Math.round(el.width)}×${Math.round(el.height)}`
      : el.width != null
        ? ` w=${Math.round(el.width)}`
        : '';

  switch (el.type) {
    case 'text': {
      const text = stripHtml(el.content || '').slice(0, 60);
      const suffix = text.length >= 60 ? '...' : '';
      return `${id} text${el.textType ? `[${el.textType}]` : ''}: "${text}${suffix}" ${pos}${size}`;
    }
    case 'image': {
      const src = el.src?.startsWith('data:') ? '[embedded]' : el.src?.slice(0, 50) || 'unknown';
      return `${id} image: ${src} ${pos}${size}`;
    }
    case 'shape': {
      const shapeText = el.text?.content ? stripHtml(el.text.content).slice(0, 40) : '';
      return `${id} shape${shapeText ? `: "${shapeText}"` : ''} ${pos}${size}`;
    }
    case 'chart':
      return `${id} chart[${el.chartType}]: labels=[${(el.data?.labels || []).slice(0, 4).join(',')}] ${pos}${size}`;
    case 'table': {
      const rows = el.data?.length || 0;
      const cols = el.data?.[0]?.length || 0;
      return `${id} table: ${rows}x${cols} ${pos}${size}`;
    }
    case 'latex':
      return `${id} latex: "${(el.latex || '').slice(0, 40)}" ${pos}${size}`;
    case 'line': {
      const lx = Math.round(el.left ?? 0);
      const ly = Math.round(el.top ?? 0);
      const sx = el.start?.[0] ?? 0;
      const sy = el.start?.[1] ?? 0;
      const ex = el.end?.[0] ?? 0;
      const ey = el.end?.[1] ?? 0;
      return `${id} line: (${lx + sx},${ly + sy}) → (${lx + ex},${ly + ey})`;
    }
    case 'code': {
      const lang = el.language || 'unknown';
      const lineCount = el.lines?.length || 0;
      const codeFn = el.fileName ? ` "${el.fileName}"` : '';
      const linePreview = (el.lines || [])
        .slice(0, 10)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((l: any) => `    ${l.id}: ${l.content}`)
        .join('\n');
      const moreLines = lineCount > 10 ? `\n    ... and ${lineCount - 10} more lines` : '';
      return `${id} code${codeFn} (${lang}, ${lineCount} lines) ${pos}${size}\n${linePreview}${moreLines}`;
    }
    case 'video':
      return `${id} video ${pos}${size}`;
    case 'audio':
      return `${id} audio ${pos}${size}`;
    default:
      return `${id} ${el.type || 'unknown'} ${pos}${size}`;
  }
}

/**
 * Summarize an array of elements into line descriptions
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PPTElement variants have heterogeneous shapes
export function summarizeElements(elements: any[]): string {
  if (elements.length === 0) return '  (empty)';

  const lines = elements.map((el, i) => `  ${i + 1}. ${summarizeElement(el)}`);

  return lines.join('\n');
}

// ==================== State Context ====================

/**
 * Build context string from store state
 */
export function buildStateContext(storeState: StatelessChatRequest['storeState']): string {
  const { stage, scenes, currentSceneId, mode, whiteboardOpen } = storeState;

  const lines: string[] = [];

  // Mode
  lines.push(`Mode: ${mode}`);

  // Whiteboard status
  lines.push(
    `Whiteboard: ${whiteboardOpen ? 'OPEN (slide canvas is hidden)' : 'closed (slide canvas is visible)'}`,
  );

  // Stage info
  if (stage) {
    lines.push(
      `Course: ${stage.name || 'Untitled'}${stage.description ? ` - ${stage.description}` : ''}`,
    );
  }

  // Scenes summary
  lines.push(`Total scenes: ${scenes.length}`);

  if (currentSceneId) {
    const currentScene = scenes.find((s) => s.id === currentSceneId);
    if (currentScene) {
      lines.push(
        `Current scene: "${currentScene.title}" (${currentScene.type}, id: ${currentSceneId})`,
      );

      // Slide scene: include element details
      if (currentScene.content.type === 'slide') {
        const elements = currentScene.content.canvas.elements;
        lines.push(`Current slide elements (${elements.length}):\n${summarizeElements(elements)}`);
      }

      // Quiz scene: include question summary
      if (currentScene.content.type === 'quiz') {
        const questions = currentScene.content.questions;
        const qSummary = questions
          .slice(0, 5)
          .map((q, i) => `  ${i + 1}. [${q.type}] ${q.question.slice(0, 80)}`)
          .join('\n');
        lines.push(
          `Quiz questions (${questions.length}):\n${qSummary}${questions.length > 5 ? `\n  ... and ${questions.length - 5} more` : ''}`,
        );
      }
    }
  } else if (scenes.length > 0) {
    lines.push('No scene currently selected');
  }

  // List first few scenes
  if (scenes.length > 0) {
    const sceneSummary = scenes
      .slice(0, 5)
      .map((s, i) => `  ${i + 1}. ${s.title} (${s.type}, id: ${s.id})`)
      .join('\n');
    lines.push(
      `Scenes:\n${sceneSummary}${scenes.length > 5 ? `\n  ... and ${scenes.length - 5} more` : ''}`,
    );
  }

  // Whiteboard content (last whiteboard in the stage)
  if (stage?.whiteboard && stage.whiteboard.length > 0) {
    const lastWb = stage.whiteboard[stage.whiteboard.length - 1];
    const wbElements = lastWb.elements || [];
    lines.push(
      `Whiteboard (last of ${stage.whiteboard.length}, ${wbElements.length} elements):\n${summarizeElements(wbElements)}`,
    );
    const conflictsText = buildWhiteboardConflicts(wbElements);
    if (conflictsText) lines.push(conflictsText);
  }

  return lines.join('\n');
}
