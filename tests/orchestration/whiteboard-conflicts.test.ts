import { describe, expect, test } from 'vitest';
import { buildWhiteboardConflicts } from '@/lib/orchestration/summarizers/whiteboard-conflicts';

// Minimal PPTElement stand-ins — the summarizer only reads geometry fields.
const text = (id: string, left: number, top: number, width: number, height: number) => ({
  type: 'text',
  id,
  left,
  top,
  width,
  height,
  content: '<p>sample</p>',
});

const table = (id: string, left: number, top: number, width: number, height: number) => ({
  type: 'table',
  id,
  left,
  top,
  width,
  height,
  data: [[{ text: 'a' }]],
});

const line = (
  id: string,
  left: number,
  top: number,
  start: [number, number],
  end: [number, number],
) => ({ type: 'line', id, left, top, start, end });

describe('buildWhiteboardConflicts — no conflicts', () => {
  test('empty element list returns empty string', () => {
    expect(buildWhiteboardConflicts([])).toBe('');
  });

  test('two well-separated elements return empty string', () => {
    const out = buildWhiteboardConflicts([
      text('t1', 20, 20, 200, 60),
      text('t2', 400, 200, 200, 60),
    ]);
    expect(out).toBe('');
  });

  test('just-touching bboxes (intersection area = 0) are not reported', () => {
    const out = buildWhiteboardConflicts([
      text('t1', 0, 0, 100, 100),
      text('t2', 100, 0, 100, 100), // shares only the x=100 edge
    ]);
    expect(out).toBe('');
  });

  test('line routed clear of all elements produces no conflict', () => {
    const out = buildWhiteboardConflicts([
      text('t1', 100, 100, 200, 60),
      line('l1', 0, 0, [50, 50], [50, 400]),
    ]);
    expect(out).toBe('');
  });
});

describe('buildWhiteboardConflicts — bbox overlap', () => {
  test('one element fully inside another reports ~100% overlap', () => {
    const out = buildWhiteboardConflicts([
      table('big', 0, 0, 500, 400),
      text('small', 50, 50, 100, 80), // entirely inside the table
    ]);
    expect(out).toContain('OVERLAP:');
    expect(out).toContain('100%');
  });

  test('50% overlap is reported; 10% is not (30% threshold)', () => {
    // Each bbox 100×100; smaller area = 10000. Overlap area = 50×100 = 5000 → 50%.
    const overlapping = buildWhiteboardConflicts([
      text('a', 0, 0, 100, 100),
      text('b', 50, 0, 100, 100),
    ]);
    expect(overlapping).toContain('OVERLAP:');
    expect(overlapping).toContain('50%');

    // Overlap area = 10×100 = 1000 → 10% — below threshold.
    const tiny = buildWhiteboardConflicts([text('a', 0, 0, 100, 100), text('b', 90, 0, 100, 100)]);
    expect(tiny).toBe('');
  });

  test('non-line elements without width/height are skipped, not crashed', () => {
    const out = buildWhiteboardConflicts([
      text('t1', 0, 0, 100, 100),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'text', id: 'broken', left: 10, top: 10 } as any, // missing width/height
    ]);
    // Only one valid element remaining → no overlap to report.
    expect(out).toBe('');
  });
});

describe('buildWhiteboardConflicts — line crossing elements', () => {
  test('line passing through the middle of a text box is reported', () => {
    const out = buildWhiteboardConflicts([
      text('t1', 100, 100, 200, 60), // covers x∈[100,300], y∈[100,160]
      line('l1', 0, 0, [0, 130], [400, 130]), // horizontal line through y=130, cuts the box
    ]);
    expect(out).toContain('LINE CROSSES:');
    expect(out).toContain('t1');
  });

  test('line whose endpoint is inside a bbox is reported', () => {
    const out = buildWhiteboardConflicts([
      text('t1', 100, 100, 200, 60),
      line('l1', 0, 0, [50, 50], [200, 130]), // endpoint (200,130) is inside t1
    ]);
    expect(out).toContain('LINE CROSSES:');
  });

  test('line with endpoints on opposite sides of a box but path above the box is clean', () => {
    const out = buildWhiteboardConflicts([
      text('t1', 100, 100, 200, 60),
      line('l1', 0, 0, [50, 50], [400, 50]), // y=50, above the box (y∈[100,160])
    ]);
    expect(out).toBe('');
  });
});

describe('buildWhiteboardConflicts — canvas edge clipping', () => {
  test('element extending past right edge is reported', () => {
    const out = buildWhiteboardConflicts([text('wide', 900, 100, 200, 60)]);
    expect(out).toContain('OUT OF CANVAS:');
    expect(out).toContain('right edge by 100px');
  });

  test('element extending past bottom edge is reported (canvas height = 563)', () => {
    const out = buildWhiteboardConflicts([text('tall', 100, 500, 100, 80)]);
    expect(out).toContain('OUT OF CANVAS:');
    expect(out).toContain('bottom edge by 17px'); // 500+80-563 = 17
  });

  test('element with negative left is reported', () => {
    const out = buildWhiteboardConflicts([text('negx', -10, 100, 50, 50)]);
    expect(out).toContain('OUT OF CANVAS:');
    expect(out).toContain('left edge by 10px');
  });

  test('element exactly at right edge (x+w == 1000) is NOT reported', () => {
    const out = buildWhiteboardConflicts([text('edge', 900, 100, 100, 60)]);
    expect(out).toBe('');
  });

  test('element exactly at bottom edge (y+h == 563) is NOT reported', () => {
    const out = buildWhiteboardConflicts([text('edge', 100, 500, 100, 63)]);
    expect(out).toBe('');
  });
});

describe('buildWhiteboardConflicts — output format', () => {
  test('renders a single markdown block with a header and bullet list', () => {
    const out = buildWhiteboardConflicts([text('a', 0, 0, 100, 100), text('b', 50, 0, 100, 100)]);
    expect(out).toMatch(/## ⚠ Layout Conflicts Detected/);
    expect(out).toMatch(/\n {2}- OVERLAP:/);
  });

  test('lists multiple conflicts in one block', () => {
    const out = buildWhiteboardConflicts([
      text('a', 0, 0, 100, 100),
      text('b', 50, 0, 100, 100), // overlap with a
      text('outside', 950, 100, 200, 60), // out of canvas
    ]);
    const bullets = out.split('\n').filter((l) => l.trim().startsWith('- '));
    expect(bullets.length).toBeGreaterThanOrEqual(2);
  });
});
