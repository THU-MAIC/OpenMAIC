import type { StatelessChatRequest } from '@/lib/types/chat';
import type { WhiteboardActionRecord } from '../types';

// ==================== Virtual Whiteboard Context ====================

/**
 * Tracked element from replaying the whiteboard ledger
 */
interface VirtualWhiteboardElement {
  agentName: string;
  summary: string;
  elementId?: string; // Present for elements from initial whiteboard state
}

/**
 * Replay the whiteboard ledger to build an attributed element list.
 *
 * - wb_clear resets the accumulated elements
 * - wb_draw_* appends a new element with the agent's name
 * - wb_open / wb_close are ignored (structural, not content)
 *
 * Returns empty string when the ledger is empty (zero extra token overhead).
 */
export function buildVirtualWhiteboardContext(
  storeState: StatelessChatRequest['storeState'],
  ledger?: WhiteboardActionRecord[],
): string {
  if (!ledger || ledger.length === 0) return '';

  // Replay ledger to build current element list
  const elements: VirtualWhiteboardElement[] = [];

  for (const record of ledger) {
    switch (record.actionName) {
      case 'wb_clear':
        elements.length = 0;
        break;
      case 'wb_delete': {
        // Remove element by matching elementId from initial whiteboard state
        // (elements drawn this round don't have tracked IDs)
        const deleteId = String(record.params.elementId || '');
        const idx = elements.findIndex((el) => el.elementId === deleteId);
        if (idx >= 0) elements.splice(idx, 1);
        break;
      }
      case 'wb_draw_text': {
        const content = String(record.params.content || '').slice(0, 40);
        const x = record.params.x ?? '?';
        const y = record.params.y ?? '?';
        const w = record.params.width ?? 400;
        const h = record.params.height ?? 100;
        elements.push({
          agentName: record.agentName,
          summary: `text: "${content}${content.length >= 40 ? '...' : ''}" at (${x},${y}), size ~${w}x${h}`,
        });
        break;
      }
      case 'wb_draw_shape': {
        const shapeType = record.params.type || record.params.shape || 'rectangle';
        const x = record.params.x ?? '?';
        const y = record.params.y ?? '?';
        const w = record.params.width ?? 100;
        const h = record.params.height ?? 100;
        elements.push({
          agentName: record.agentName,
          summary: `shape(${shapeType}) at (${x},${y}), size ${w}x${h}`,
        });
        break;
      }
      case 'wb_draw_chart': {
        const chartType = record.params.chartType || record.params.type || 'bar';
        const labels = Array.isArray(record.params.labels)
          ? record.params.labels
          : (record.params.data as Record<string, unknown>)?.labels;
        const x = record.params.x ?? '?';
        const y = record.params.y ?? '?';
        const w = record.params.width ?? 350;
        const h = record.params.height ?? 250;
        elements.push({
          agentName: record.agentName,
          summary: `chart(${chartType})${labels ? `: labels=[${(labels as string[]).slice(0, 4).join(',')}]` : ''} at (${x},${y}), size ${w}x${h}`,
        });
        break;
      }
      case 'wb_draw_latex': {
        const latex = String(record.params.latex || '').slice(0, 40);
        const x = record.params.x ?? '?';
        const y = record.params.y ?? '?';
        const w = record.params.width ?? 400;
        // Estimate latex height: ~80px default for single-line, more for complex formulas
        const h = record.params.height ?? 80;
        elements.push({
          agentName: record.agentName,
          summary: `latex: "${latex}${latex.length >= 40 ? '...' : ''}" at (${x},${y}), size ~${w}x${h}`,
        });
        break;
      }
      case 'wb_draw_table': {
        const data = record.params.data as unknown[][] | undefined;
        const rows = data?.length || 0;
        const cols = (data?.[0] as unknown[])?.length || 0;
        const x = record.params.x ?? '?';
        const y = record.params.y ?? '?';
        const w = record.params.width ?? 400;
        const h = record.params.height ?? rows * 40 + 20;
        elements.push({
          agentName: record.agentName,
          summary: `table(${rows}×${cols}) at (${x},${y}), size ${w}x${h}`,
        });
        break;
      }
      case 'wb_draw_line': {
        const sx = record.params.startX ?? '?';
        const sy = record.params.startY ?? '?';
        const ex = record.params.endX ?? '?';
        const ey = record.params.endY ?? '?';
        const pts = record.params.points as string[] | undefined;
        const hasArrow = pts?.includes('arrow') ? ' (arrow)' : '';
        elements.push({
          agentName: record.agentName,
          summary: `line${hasArrow}: (${sx},${sy}) → (${ex},${ey})`,
        });
        break;
      }
      case 'wb_draw_code': {
        const lang = String(record.params.language || '');
        const codeFileName = record.params.fileName ? ` "${record.params.fileName}"` : '';
        const x = record.params.x ?? '?';
        const y = record.params.y ?? '?';
        const w = record.params.width ?? 500;
        const h = record.params.height ?? 300;
        const code = String(record.params.code || '');
        const lineCount = code.split('\n').length;
        elements.push({
          agentName: record.agentName,
          summary: `code block${codeFileName} (${lang}, ${lineCount} lines) at (${x},${y}), size ${w}x${h}`,
        });
        break;
      }
      case 'wb_edit_code': {
        const op = record.params.operation || 'edit';
        const targetId = record.params.elementId || '?';
        elements.push({
          agentName: record.agentName,
          summary: `edited code "${targetId}" (${op})`,
        });
        break;
      }
      // wb_open, wb_close — skip
    }
  }

  if (elements.length === 0) return '';

  const elementLines = elements
    .map((el, i) => `  ${i + 1}. [by ${el.agentName}] ${el.summary}`)
    .join('\n');

  return `
## Whiteboard Changes This Round (IMPORTANT)
Other agents have modified the whiteboard during this discussion round.
Current whiteboard elements (${elements.length}):
${elementLines}

DO NOT redraw content that already exists. Check positions above before adding new elements.
`;
}
