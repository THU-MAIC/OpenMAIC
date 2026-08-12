// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { PPTElement, PPTTextElement, SlideContent } from '@openmaic/dsl';
import { applyEditorTransaction, type EditorTransaction } from '../../src/core';
import {
  createCanvasCommands,
  createClipboardPasteState,
  handleCanvasShortcut,
  type ElementClipboard,
} from '../../src/react';
import type { Selection } from '../../src/react/types';

function text(id: string, overrides: Partial<PPTTextElement> = {}): PPTTextElement {
  return {
    id,
    type: 'text',
    left: 0,
    top: 0,
    width: 100,
    height: 40,
    rotate: 0,
    content: `<p>${id}</p>`,
    defaultFontName: 'Arial',
    defaultColor: '#333333',
    ...overrides,
  };
}

function content(elements: PPTElement[] = [text('a'), text('b'), text('c')]): SlideContent {
  return {
    type: 'slide',
    canvas: { id: 'slide-1', viewportSize: 1000, viewportRatio: 0.5625, elements },
  } as SlideContent;
}

function setup({
  elements,
  selection = { elementIds: ['a'], primaryId: 'a' },
  hiddenElementIds,
  clipboard,
  createElementId,
  createGroupId,
}: {
  elements?: PPTElement[];
  selection?: Selection;
  hiddenElementIds?: readonly string[];
  clipboard?: ElementClipboard;
  createElementId?: (type: PPTElement['type']) => string;
  createGroupId?: () => string;
} = {}) {
  const source = content(elements);
  const onTransaction = vi.fn<(transaction: EditorTransaction) => void>();
  const onSelectionChange = vi.fn<(next: Selection) => void>();
  return {
    source,
    onTransaction,
    onSelectionChange,
    commands: createCanvasCommands({
      content: source,
      selection,
      hiddenElementIds,
      onTransaction,
      onSelectionChange,
      clipboard,
      clipboardPasteState: createClipboardPasteState(),
      createElementId: createElementId ?? ((type) => `${type}-copy`),
      createGroupId: createGroupId ?? (() => 'copied-group'),
    }),
  };
}

describe('canvas commands', () => {
  it('emits one canonical transaction for delete, lock, and alignment', () => {
    const deleted = setup({ selection: { elementIds: ['a', 'b'], primaryId: 'a' } });
    deleted.commands.deleteSelection();
    expect(deleted.onTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [{ type: 'element.deleteMany', elementIds: ['a', 'b'] }],
      }),
    );
    expect(deleted.onSelectionChange).toHaveBeenCalledWith({ elementIds: [] });

    const locked = setup();
    locked.commands.lockSelection();
    expect(locked.onTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [
          { type: 'element.updateMany', updates: [{ elementId: 'a', patch: { lock: true } }] },
        ],
      }),
    );

    const aligned = setup({ selection: { elementIds: ['a', 'b'], primaryId: 'a' } });
    aligned.commands.alignSelection('middle');
    expect(aligned.onTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [{ type: 'element.align', elementIds: ['a', 'b'], command: 'vertical' }],
      }),
    );
  });

  it('keeps groups contiguous when moving them and produces a canonical reorder transaction', () => {
    const elements = [
      text('a1', { groupId: 'A' }),
      text('a2', { groupId: 'A' }),
      text('b1', { groupId: 'B' }),
      text('b2', { groupId: 'B' }),
    ];
    const state = setup({ elements, selection: { elementIds: ['a1'], primaryId: 'a1' } });
    state.commands.reorderTarget('a1', 'forward');
    const transaction = state.onTransaction.mock.calls[0][0];
    expect(
      applyEditorTransaction(state.source, transaction).canvas.elements.map(
        (element) => element.id,
      ),
    ).toEqual(['b1', 'b2', 'a1', 'a2']);
  });

  it('selects only visible unlocked elements without emitting a transaction', () => {
    const state = setup({
      elements: [text('a'), text('b', { lock: true }), text('c')],
      selection: { elementIds: [] },
      hiddenElementIds: ['c'],
    });

    state.commands.selectAll();

    expect(state.onSelectionChange).toHaveBeenCalledWith({
      elementIds: ['a'],
      primaryId: 'a',
    });
    expect(state.onTransaction).not.toHaveBeenCalled();
  });

  it('closes a partial selection over its complete group before deleting', () => {
    const state = setup({
      elements: [text('g1', { groupId: 'G' }), text('g2', { groupId: 'G' }), text('x')],
      selection: { elementIds: ['g1'], primaryId: 'g1' },
    });

    state.commands.deleteSelection();

    expect(state.onTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [{ type: 'element.deleteMany', elementIds: ['g1', 'g2'] }],
      }),
    );
    expect(state.onSelectionChange).toHaveBeenCalledWith({ elementIds: [] });
  });

  it('unlocks and selects the complete target group', () => {
    const state = setup({
      elements: [
        text('g1', { groupId: 'G', lock: true }),
        text('g2', { groupId: 'G', lock: true }),
        text('x'),
      ],
      selection: { elementIds: [] },
    });

    state.commands.unlockTarget('g2');

    const next = applyEditorTransaction(state.source, state.onTransaction.mock.calls[0][0]);
    expect(next.canvas.elements.slice(0, 2)).toEqual([
      expect.objectContaining({ id: 'g1', lock: false }),
      expect.objectContaining({ id: 'g2', lock: false }),
    ]);
    expect(state.onSelectionChange).toHaveBeenCalledWith({
      elementIds: ['g1', 'g2'],
      primaryId: 'g2',
    });
  });

  it('groups a multi-selection and ungroups an existing group', () => {
    const grouped = setup({
      selection: { elementIds: ['a', 'b'], primaryId: 'b' },
      createGroupId: () => 'group-new',
    });
    grouped.commands.toggleGroup();
    const groupedContent = applyEditorTransaction(
      grouped.source,
      grouped.onTransaction.mock.calls[0][0],
    );
    expect(groupedContent.canvas.elements.slice(0, 2)).toEqual([
      expect.objectContaining({ id: 'a', groupId: 'group-new' }),
      expect.objectContaining({ id: 'b', groupId: 'group-new' }),
    ]);

    const ungrouped = setup({
      elements: [text('g1', { groupId: 'G' }), text('g2', { groupId: 'G' }), text('x')],
      selection: { elementIds: ['g1', 'g2'], primaryId: 'g2' },
    });
    ungrouped.commands.toggleGroup();
    const ungroupedContent = applyEditorTransaction(
      ungrouped.source,
      ungrouped.onTransaction.mock.calls[0][0],
    );
    expect(ungroupedContent.canvas.elements.slice(0, 2)).toEqual([
      expect.not.objectContaining({ groupId: expect.anything() }),
      expect.not.objectContaining({ groupId: expect.anything() }),
    ]);
    expect(ungrouped.onSelectionChange).toHaveBeenCalledWith({
      elementIds: ['g2'],
      primaryId: 'g2',
    });
  });

  it('compacts non-adjacent members into one contiguous group block', () => {
    const elements = [text('a'), text('between'), text('c'), text('top')];
    const state = setup({
      elements,
      selection: { elementIds: ['a', 'c'], primaryId: 'c' },
      createGroupId: () => 'group-new',
    });

    state.commands.toggleGroup();

    const next = applyEditorTransaction(state.source, state.onTransaction.mock.calls[0][0]);
    expect(next.canvas.elements.map((element) => element.id)).toEqual(['between', 'a', 'c', 'top']);
    expect(next.canvas.elements.filter((element) => element.groupId === 'group-new')).toHaveLength(
      2,
    );
    expect(state.onTransaction).toHaveBeenCalledTimes(1);
  });

  it('skips destructive no-op commands for an empty effective selection', () => {
    const state = setup({
      selection: { elementIds: ['missing'], primaryId: 'missing' },
    });

    state.commands.deleteSelection();
    state.commands.lockSelection();
    state.commands.toggleGroup();
    state.commands.alignSelection('left');
    state.commands.reorderTarget('missing', 'front');
    state.commands.unlockTarget('missing');

    expect(state.onTransaction).not.toHaveBeenCalled();
    expect(state.onSelectionChange).not.toHaveBeenCalled();
  });

  it('pastes cloned elements with fresh ids, groups, and incremental offsets', async () => {
    const source = [
      text('g1', { groupId: 'source', left: 10, top: 20 }),
      text('g2', { groupId: 'source', left: 80, top: 20 }),
    ];
    const clipboard: ElementClipboard = {
      write: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue(source),
    };
    let nextId = 0;
    let nextGroupId = 0;
    const state = setup({
      elements: source,
      selection: { elementIds: ['g1'], primaryId: 'g1' },
      clipboard,
      createElementId: (type) => `${type}-copy-${++nextId}`,
      createGroupId: () => `copied-group-${++nextGroupId}`,
    });

    await state.commands.copySelection();
    expect(clipboard.write).toHaveBeenCalledWith(source);

    await state.commands.pasteElements();
    expect(state.onTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [
          expect.objectContaining({
            type: 'element.add',
            element: expect.objectContaining({
              id: 'text-copy-1',
              groupId: 'copied-group-1',
              left: 30,
              top: 40,
            }),
          }),
          expect.objectContaining({
            type: 'element.add',
            element: expect.objectContaining({
              id: 'text-copy-2',
              groupId: 'copied-group-1',
              left: 100,
              top: 40,
            }),
          }),
        ],
      }),
    );

    await state.commands.pasteElements();
    expect(state.onTransaction.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        operations: [
          expect.objectContaining({
            element: expect.objectContaining({ id: 'text-copy-3', left: 50, top: 60 }),
          }),
          expect.objectContaining({
            element: expect.objectContaining({ id: 'text-copy-4', left: 120, top: 60 }),
          }),
        ],
      }),
    );
  });

  it('cuts only after the clipboard has retained the copied selection', async () => {
    const clipboard: ElementClipboard = {
      write: vi.fn().mockResolvedValue(false),
      read: vi.fn(),
    };
    const state = setup({ clipboard });

    await state.commands.cutSelection();
    expect(state.onTransaction).not.toHaveBeenCalled();
    expect(state.onSelectionChange).not.toHaveBeenCalled();

    vi.mocked(clipboard.write).mockResolvedValue(true);
    await state.commands.cutSelection();
    expect(state.onTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: [{ type: 'element.deleteMany', elementIds: ['a'] }],
      }),
    );
    expect(state.onSelectionChange).toHaveBeenCalledWith({ elementIds: [] });
  });

  it('ignores invalid elements returned by an injected clipboard', async () => {
    const clipboard: ElementClipboard = {
      write: vi.fn().mockResolvedValue(true),
      read: vi
        .fn()
        .mockResolvedValue([{ ...text('bad'), left: 'invalid' }] as unknown as PPTElement[]),
    };
    const state = setup({ clipboard });

    await expect(state.commands.pasteElements()).resolves.toBeUndefined();

    expect(state.onTransaction).not.toHaveBeenCalled();
    expect(state.onSelectionChange).not.toHaveBeenCalled();
  });

  it('does not steal native text editing shortcuts and maps canvas delete', () => {
    const commands = setup().commands;
    const editable = {
      key: 'Delete',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      repeat: false,
      target: { tagName: 'TEXTAREA' },
      preventDefault: vi.fn(),
    };
    expect(handleCanvasShortcut(editable, commands)).toBe(false);

    const canvasEvent = { ...editable, target: null, preventDefault: vi.fn() };
    expect(handleCanvasShortcut(canvasEvent, commands)).toBe(true);
    expect(canvasEvent.preventDefault).toHaveBeenCalledOnce();
  });
});
