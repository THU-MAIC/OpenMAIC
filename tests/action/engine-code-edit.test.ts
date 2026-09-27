import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { PPTCodeElement, WbEditCodeAction } from '@openmaic/dsl';
import { ActionEngine } from '@/lib/action/engine';
import type { StageStore } from '@/lib/api/stage-api';
import { useCanvasStore } from '@/lib/store/canvas';

const initialWhiteboardOpen = useCanvasStore.getState().whiteboardOpen;

afterEach(() => {
  useCanvasStore.setState({ whiteboardOpen: initialWhiteboardOpen });
});

async function replaceLines(lineIds: string[] | undefined, content = 'X') {
  const code: PPTCodeElement = {
    id: 'code-1',
    type: 'code',
    language: 'typescript',
    lines: ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id, content: id })),
    fileName: 'example.ts',
    showLineNumbers: true,
    fontSize: 14,
    left: 100,
    top: 120,
    width: 500,
    height: 300,
    rotate: 0,
  };
  const store = createStore<ReturnType<StageStore['getState']>>(() => ({
    stage: {
      id: 'stage-1',
      name: 'Code editing',
      createdAt: 1,
      updatedAt: 1,
      whiteboard: [{ id: 'wb-1', viewportSize: 1000, viewportRatio: 9 / 16, elements: [code] }],
    },
    scenes: [],
    currentSceneId: null,
    mode: 'edit',
  }));
  const action: WbEditCodeAction & { newLineIds: string[] } = {
    id: 'edit-1',
    type: 'wb_edit_code',
    elementId: code.id,
    operation: 'replace_lines',
    lineIds,
    content,
    newLineIds: ['new-1', 'new-2', 'new-3'],
  };

  await new ActionEngine(store).execute(action, { silent: true });

  const edited = store.getState().stage!.whiteboard![0].elements[0] as PPTCodeElement;
  return { code, edited };
}

describe('ActionEngine wb_edit_code replace_lines', () => {
  it.each([
    {
      name: 'out-of-order noncontiguous targets',
      lineIds: ['D', 'B'],
      expected: ['A', 'X', 'C', 'E'],
    },
    { name: 'ordered noncontiguous targets', lineIds: ['B', 'D'], expected: ['A', 'X', 'C', 'E'] },
    { name: 'reversed contiguous targets', lineIds: ['D', 'C', 'B'], expected: ['A', 'X', 'E'] },
    {
      name: 'targets including the first line',
      lineIds: ['E', 'A'],
      expected: ['X', 'B', 'C', 'D'],
    },
    { name: 'a single target', lineIds: ['C'], expected: ['A', 'B', 'X', 'D', 'E'] },
  ])(
    'anchors replacement at the earliest document line for $name',
    async ({ lineIds, expected }) => {
      const { code, edited } = await replaceLines(lineIds);

      expect(edited.lines.map((line) => line.content)).toEqual(expected);
      expect(edited.lines.find((line) => line.content === 'X')?.id).toBe(lineIds[0]);
      expect(edited).toEqual({ ...code, lines: edited.lines });
      expect(code.lines.map((line) => line.content)).toEqual(['A', 'B', 'C', 'D', 'E']);
    },
  );

  it('keeps replacement content and supplied line IDs in their existing order', async () => {
    const { edited } = await replaceLines(['D', 'B'], 'X\nY\nZ');

    expect(edited.lines).toEqual([
      { id: 'A', content: 'A' },
      { id: 'D', content: 'X' },
      { id: 'B', content: 'Y' },
      { id: 'new-3', content: 'Z' },
      { id: 'C', content: 'C' },
      { id: 'E', content: 'E' },
    ]);
  });

  it('removes the targets when replacement content is empty', async () => {
    const { edited } = await replaceLines(['D', 'B'], '');

    expect(edited.lines).toEqual([
      { id: 'A', content: 'A' },
      { id: 'C', content: 'C' },
      { id: 'E', content: 'E' },
    ]);
  });

  it.each([{ lineIds: undefined }, { lineIds: [] }, { lineIds: ['missing'] }])(
    'does not change the code when no targets match: $lineIds',
    async ({ lineIds }) => {
      const { code, edited } = await replaceLines(lineIds);

      expect(edited).toEqual(code);
    },
  );
});
