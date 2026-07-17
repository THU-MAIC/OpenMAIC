import { describe, expect, it } from 'vitest';
import { buildStateContext } from '@/lib/orchestration/summarizers/state-context';
import type { StatelessChatRequest } from '@/lib/types/chat';

function makeStoreState(whiteboardElements: unknown[]): StatelessChatRequest['storeState'] {
  return {
    stage: {
      id: 'stage-1',
      name: 'Code lesson',
      whiteboard: [{ id: 'whiteboard-1', elements: whiteboardElements }],
    },
    scenes: [],
    currentSceneId: null,
    mode: 'autonomous',
    whiteboardOpen: true,
  } as unknown as StatelessChatRequest['storeState'];
}

function bigCodeBlock(id: string, lineCount: number) {
  return {
    id,
    type: 'code',
    language: 'python',
    fileName: `${id}.py`,
    lines: Array.from({ length: lineCount }, (_, i) => ({
      id: `${id}-L${i}`,
      content: `${id}_line_${i} = ${i}`,
    })),
  };
}

describe('buildStateContext whiteboard code summary', () => {
  it('bounds a single very large code block instead of dumping every line', () => {
    const context = buildStateContext(makeStoreState([bigCodeBlock('code', 5000)]));

    // The tail is an omitted count, not a line-by-line dump...
    expect(context).toContain('more line(s) omitted');
    // ...and a late line's content is not rendered.
    expect(context).not.toContain('code_line_4999 = 4999');
    // The whole state context stays within a deterministic bound driven by the
    // shared code-line budget plus the small non-code overhead.
    expect(context.length).toBeLessThan(3000);
  });

  it('shares one deterministic budget across multiple large code blocks', () => {
    const oneBlock = buildStateContext(makeStoreState([bigCodeBlock('a', 2000)]));
    const fourBlocks = buildStateContext(
      makeStoreState([
        bigCodeBlock('a', 2000),
        bigCodeBlock('b', 2000),
        bigCodeBlock('c', 2000),
        bigCodeBlock('d', 2000),
      ]),
    );

    // Four large blocks do not multiply the code dump: the budget is shared, so
    // going from one to four blocks only adds bounded per-block headers, not
    // four full code listings.
    expect(fourBlocks.length - oneBlock.length).toBeLessThan(600);
    expect(fourBlocks.length).toBeLessThan(3500);
    expect(fourBlocks).toContain('more line(s) omitted');
  });

  it('renders a normal small code block in full', () => {
    const context = buildStateContext(
      makeStoreState([
        {
          id: 'small',
          type: 'code',
          language: 'python',
          lines: [
            { id: 'L1', content: 'x = 1' },
            { id: 'L2', content: 'y = 2' },
          ],
        },
      ]),
    );

    expect(context).toContain('L1: x = 1');
    expect(context).toContain('L2: y = 2');
    expect(context).not.toContain('more line(s) omitted');
  });

  it('gives a newer persisted code block budget priority over an older large one', () => {
    // stage.whiteboard elements are appended in creation order, so an OLD large
    // block sits before a NEWER small one. With source-order budgeting the old
    // block would starve the new one; newest-first budgeting must let the newer
    // persisted block keep its element id, line ids, and content so a later
    // agent can edit it — while the display order stays board order.
    const context = buildStateContext(
      makeStoreState([
        bigCodeBlock('old', 2000),
        {
          id: 'new',
          type: 'code',
          language: 'python',
          lines: [
            { id: 'N1', content: 'fresh = 1' },
            { id: 'N2', content: 'fresh = 2' },
          ],
        },
      ]),
    );

    // The newer small block is fully editable despite being created after a
    // much larger block.
    expect(context).toContain('[id:new]');
    expect(context).toContain('N1: fresh = 1');
    expect(context).toContain('N2: fresh = 2');
    // The older large block is announced but squeezed to the omitted tail.
    expect(context).toContain('[id:old]');
    expect(context).toContain('more line(s) omitted');
    expect(context).not.toContain('old_line_1999 = 1999');

    // Display order is unchanged: the old block still renders before the new one.
    expect(context.indexOf('[id:old]')).toBeLessThan(context.indexOf('[id:new]'));
  });
});
