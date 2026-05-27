/**
 * Geometric conflict detection for whiteboard elements.
 *
 * Computes pairwise overlap, line-through-element intersection, and
 * canvas-edge clipping from the raw whiteboard JSON, and renders a
 * concise text summary for inclusion in the system prompt.
 *
 * The agent reads bbox coordinates poorly when left to compute
 * intersections itself; this surfaces the conflicts directly so the
 * model can act on them instead of inferring them.
 */

const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 563;
const OVERLAP_THRESHOLD = 0.3; // intersection / min-area; flag if >= 30%

interface BBox {
  id: string;
  type: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LineSeg {
  id: string;
  label: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PPTElement variants have heterogeneous shapes
function elementLabel(el: any): string {
  switch (el.type) {
    case 'text': {
      const t = stripHtml(el.content || '').slice(0, 24);
      return `text "${t}${t.length >= 24 ? '…' : ''}"`;
    }
    case 'latex': {
      const t = String(el.latex || '').slice(0, 24);
      return `latex "${t}${t.length >= 24 ? '…' : ''}"`;
    }
    case 'shape': {
      const t = el.text?.content ? stripHtml(el.text.content).slice(0, 16) : '';
      return t ? `shape "${t}"` : 'shape';
    }
    case 'table':
      return `table ${el.data?.length || 0}×${el.data?.[0]?.length || 0}`;
    case 'chart':
      return `chart[${el.chartType || 'unknown'}]`;
    case 'code':
      return `code(${el.language || 'unknown'})`;
    case 'image':
      return 'image';
    case 'line': {
      const pts = el.points as string[] | undefined;
      const arrow = pts?.includes('arrow') ? 'arrow' : 'line';
      return arrow;
    }
    default:
      return el.type || 'element';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PPTElement
function toBBox(el: any): BBox | null {
  if (el.type === 'line') return null;
  if (typeof el.left !== 'number' || typeof el.top !== 'number') return null;
  if (typeof el.width !== 'number' || typeof el.height !== 'number') return null;
  return {
    id: el.id || '',
    type: el.type,
    label: elementLabel(el),
    x: el.left,
    y: el.top,
    w: el.width,
    h: el.height,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PPTLineElement
function toLineSeg(el: any): LineSeg | null {
  if (el.type !== 'line') return null;
  const lx = el.left ?? 0;
  const ly = el.top ?? 0;
  const sx = el.start?.[0] ?? 0;
  const sy = el.start?.[1] ?? 0;
  const ex = el.end?.[0] ?? 0;
  const ey = el.end?.[1] ?? 0;
  return {
    id: el.id || '',
    label: elementLabel(el),
    x1: lx + sx,
    y1: ly + sy,
    x2: lx + ex,
    y2: ly + ey,
  };
}

/**
 * Relative overlap = intersection area / min(area_A, area_B).
 * 1.0 means one element is fully covered by the other.
 */
function relativeOverlap(a: BBox, b: BBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const minArea = Math.min(a.w * a.h, b.w * b.h);
  return minArea > 0 ? inter / minArea : 0;
}

function pointInRect(px: number, py: number, b: BBox): boolean {
  return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
}

/**
 * Standard CCW segment-segment intersection (proper crossing only).
 */
function segmentsIntersect(
  ax1: number,
  ay1: number,
  ax2: number,
  ay2: number,
  bx1: number,
  by1: number,
  bx2: number,
  by2: number,
): boolean {
  const ccw = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) =>
    (y3 - y1) * (x2 - x1) - (x3 - x1) * (y2 - y1);
  const d1 = ccw(bx1, by1, bx2, by2, ax1, ay1);
  const d2 = ccw(bx1, by1, bx2, by2, ax2, ay2);
  const d3 = ccw(ax1, ay1, ax2, ay2, bx1, by1);
  const d4 = ccw(ax1, ay1, ax2, ay2, bx2, by2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function lineCrossesBBox(line: LineSeg, b: BBox): boolean {
  if (pointInRect(line.x1, line.y1, b) || pointInRect(line.x2, line.y2, b)) return true;
  const edges: Array<[number, number, number, number]> = [
    [b.x, b.y, b.x + b.w, b.y],
    [b.x + b.w, b.y, b.x + b.w, b.y + b.h],
    [b.x + b.w, b.y + b.h, b.x, b.y + b.h],
    [b.x, b.y + b.h, b.x, b.y],
  ];
  for (const [ex1, ey1, ex2, ey2] of edges) {
    if (segmentsIntersect(line.x1, line.y1, line.x2, line.y2, ex1, ey1, ex2, ey2)) return true;
  }
  return false;
}

function shortId(id: string): string {
  return id ? `[${id.slice(0, 8)}]` : '';
}

/**
 * Build a text block listing all detected layout conflicts on the
 * current whiteboard. Returns empty string when there are no conflicts
 * (so callers can simply concatenate without needing to check).
 *
 * Detected conflicts:
 * - bbox overlap >= 30% of the smaller element's area
 * - line/arrow path crossing through any non-line element's bbox
 * - any element extending past the 1000×563 canvas bounds
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PPTElement variants
export function buildWhiteboardConflicts(elements: any[]): string {
  if (!elements || elements.length === 0) return '';

  const bboxes: BBox[] = [];
  const lines: LineSeg[] = [];

  for (const el of elements) {
    if (el?.type === 'line') {
      const seg = toLineSeg(el);
      if (seg) lines.push(seg);
    } else {
      const b = toBBox(el);
      if (b) bboxes.push(b);
    }
  }

  const conflicts: string[] = [];

  // Pairwise overlap between bbox elements
  for (let i = 0; i < bboxes.length; i++) {
    for (let j = i + 1; j < bboxes.length; j++) {
      const ratio = relativeOverlap(bboxes[i], bboxes[j]);
      if (ratio >= OVERLAP_THRESHOLD) {
        conflicts.push(
          `OVERLAP: ${bboxes[i].label}${shortId(bboxes[i].id)} and ${bboxes[j].label}${shortId(bboxes[j].id)} share ${Math.round(ratio * 100)}% of the smaller one's area — they sit on top of each other.`,
        );
      }
    }
  }

  // Lines crossing element bboxes
  for (const line of lines) {
    for (const b of bboxes) {
      if (lineCrossesBBox(line, b)) {
        conflicts.push(
          `LINE CROSSES: ${line.label}${shortId(line.id)} from (${Math.round(line.x1)},${Math.round(line.y1)}) to (${Math.round(line.x2)},${Math.round(line.y2)}) passes through ${b.label}${shortId(b.id)} — the line is drawn over content.`,
        );
      }
    }
  }

  // Edge clipping
  for (const b of bboxes) {
    const out: string[] = [];
    if (b.x < 0) out.push(`left edge by ${Math.round(-b.x)}px`);
    if (b.y < 0) out.push(`top edge by ${Math.round(-b.y)}px`);
    if (b.x + b.w > CANVAS_WIDTH)
      out.push(`right edge by ${Math.round(b.x + b.w - CANVAS_WIDTH)}px`);
    if (b.y + b.h > CANVAS_HEIGHT)
      out.push(`bottom edge by ${Math.round(b.y + b.h - CANVAS_HEIGHT)}px`);
    if (out.length > 0) {
      conflicts.push(
        `OUT OF CANVAS: ${b.label}${shortId(b.id)} extends past ${out.join(', ')} — content is clipped.`,
      );
    }
  }

  if (conflicts.length === 0) return '';

  const lines_out = conflicts.map((c) => `  - ${c}`).join('\n');
  return `\n## ⚠ Layout Conflicts Detected (computed from current whiteboard JSON)
The following geometric conflicts exist on the board RIGHT NOW. Each entry is a real visible problem on the current board. You MUST address these before adding new content — either wb_delete one of the conflicting elements, or wb_clear and start fresh:
${lines_out}
`;
}
