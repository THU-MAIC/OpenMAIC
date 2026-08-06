import { describe, expect, it, vi } from 'vitest';
import type { PPTChartElement, PPTElement, PPTTextElement } from '@openmaic/dsl';
import type { EditIntent, Selection } from '@openmaic/renderer/editing';
import { createRendererCanvasCommands } from '@/components/edit/surfaces/slide/renderer-canvas-commands';
import { applyRendererEditIntents } from '@/components/edit/surfaces/slide/renderer-edit-intents';
import type { SlideContent } from '@/lib/types/stage';

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
    defaultFontName: 'Inter',
    defaultColor: '#111111',
    ...overrides,
  };
}

function chart(id: string, overrides: Partial<PPTChartElement> = {}): PPTChartElement {
  return {
    id,
    type: 'chart',
    left: 0,
    top: 0,
    width: 300,
    height: 220,
    rotate: 0,
    chartType: 'bar',
    data: { labels: ['A', 'B'], legends: ['Series 1'], series: [[24, 36]] },
    themeColors: ['#5b8def'],
    ...overrides,
  };
}

function content(elements: PPTElement[]): SlideContent {
  return {
    type: 'slide',
    canvas: {
      id: 'slide-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements,
    },
  } as SlideContent;
}

function setup({
  elements = [text('a'), text('b'), text('c')],
  selection = { elementIds: ['a'], primaryId: 'a' },
  hiddenElementIds = [],
}: {
  elements?: PPTElement[];
  selection?: Selection;
  hiddenElementIds?: readonly string[];
} = {}) {
  const onIntents = vi.fn<(intents: EditIntent[]) => void>();
  const onSelectionChange = vi.fn<(selection: Selection) => void>();
  const commands = createRendererCanvasCommands({
    content: content(elements),
    selection,
    hiddenElementIds,
    onIntents,
    onSelectionChange,
    createGroupId: () => 'group-new',
  });
  return { commands, onIntents, onSelectionChange };
}

describe('createRendererCanvasCommands', () => {
  it('selectAll selects only visible unlocked elements without committing', () => {
    const { commands, onIntents, onSelectionChange } = setup({
      elements: [text('a'), text('b', { lock: true }), text('c')],
      selection: { elementIds: [] },
      hiddenElementIds: ['c'],
    });

    commands.selectAll();

    expect(onSelectionChange).toHaveBeenCalledWith({ elementIds: ['a'], primaryId: 'a' });
    expect(onIntents).not.toHaveBeenCalled();
  });

  it('deleteSelection emits one delete batch and clears selection', () => {
    const { commands, onIntents, onSelectionChange } = setup({
      selection: { elementIds: ['a', 'b'], primaryId: 'b' },
    });

    commands.deleteSelection();

    expect(onIntents).toHaveBeenCalledTimes(1);
    expect(onIntents).toHaveBeenCalledWith([{ type: 'element.delete', ids: ['a', 'b'] }]);
    expect(onSelectionChange).toHaveBeenCalledWith({ elementIds: [] });
  });

  it('closes a partial host selection over its complete group before destructive commands', () => {
    const elements = [text('g1', { groupId: 'G' }), text('g2', { groupId: 'G' }), text('x')];
    const { commands, onIntents } = setup({
      elements,
      selection: { elementIds: ['g1'], primaryId: 'g1' },
    });

    commands.deleteSelection();

    expect(onIntents).toHaveBeenCalledWith([{ type: 'element.delete', ids: ['g1', 'g2'] }]);
  });

  it('lockSelection locks every selected element in one intent and clears selection', () => {
    const { commands, onIntents, onSelectionChange } = setup({
      selection: { elementIds: ['a', 'b'], primaryId: 'a' },
    });

    commands.lockSelection();

    expect(onIntents).toHaveBeenCalledWith([
      {
        type: 'element.updateMany',
        updates: [
          { id: 'a', props: { lock: true } },
          { id: 'b', props: { lock: true } },
        ],
      },
    ]);
    expect(onSelectionChange).toHaveBeenCalledWith({ elementIds: [] });
  });

  it('applies delete, lock, group, and z-order commands to chart elements', () => {
    const elements = [chart('chart'), text('label')];

    const deleteSetup = setup({ elements, selection: { elementIds: ['chart'], primaryId: 'chart' } });
    deleteSetup.commands.deleteSelection();
    expect(deleteSetup.onIntents).toHaveBeenCalledWith([
      { type: 'element.delete', ids: ['chart'] },
    ]);

    const lockSetup = setup({ elements, selection: { elementIds: ['chart'], primaryId: 'chart' } });
    lockSetup.commands.lockSelection();
    expect(lockSetup.onIntents).toHaveBeenCalledWith([
      { type: 'element.updateMany', updates: [{ id: 'chart', props: { lock: true } }] },
    ]);

    const groupSetup = setup({
      elements,
      selection: { elementIds: ['chart', 'label'], primaryId: 'chart' },
    });
    groupSetup.commands.toggleGroup();
    expect(groupSetup.onIntents).toHaveBeenCalledWith([
      {
        type: 'element.updateMany',
        updates: [
          { id: 'chart', props: { groupId: 'group-new' } },
          { id: 'label', props: { groupId: 'group-new' } },
        ],
      },
    ]);

    const reorderSetup = setup({ elements: [text('behind'), ...elements] });
    reorderSetup.commands.reorderTarget('chart', 'front');
    expect(reorderSetup.onIntents).toHaveBeenCalledWith([
      { type: 'element.reorder', id: 'chart', command: 'front' },
    ]);
  });

  it('unlockTarget unlocks and selects the complete target group', () => {
    const group = [
      text('g1', { groupId: 'G', lock: true }),
      text('g2', { groupId: 'G', lock: true }),
      text('x'),
    ];
    const { commands, onIntents, onSelectionChange } = setup({
      elements: group,
      selection: { elementIds: [] },
    });

    commands.unlockTarget('g2');

    expect(onIntents).toHaveBeenCalledWith([
      {
        type: 'element.updateMany',
        updates: [
          { id: 'g1', props: { lock: false } },
          { id: 'g2', props: { lock: false } },
        ],
      },
    ]);
    expect(onSelectionChange).toHaveBeenCalledWith({
      elementIds: ['g1', 'g2'],
      primaryId: 'g2',
    });
  });

  it('toggleGroup groups a multi-selection and ungroups an existing group', () => {
    const grouped = [text('g1', { groupId: 'G' }), text('g2', { groupId: 'G' }), text('x')];
    const groupSetup = setup({ selection: { elementIds: ['a', 'b'], primaryId: 'b' } });
    groupSetup.commands.toggleGroup();
    expect(groupSetup.onIntents).toHaveBeenCalledWith([
      {
        type: 'element.updateMany',
        updates: [
          { id: 'a', props: { groupId: 'group-new' } },
          { id: 'b', props: { groupId: 'group-new' } },
        ],
      },
    ]);

    const ungroupSetup = setup({
      elements: grouped,
      selection: { elementIds: ['g1', 'g2'], primaryId: 'g2' },
    });
    ungroupSetup.commands.toggleGroup();
    expect(ungroupSetup.onIntents).toHaveBeenCalledWith([
      { type: 'element.removeProps', id: 'g1', props: ['groupId'] },
      { type: 'element.removeProps', id: 'g2', props: ['groupId'] },
    ]);
    expect(ungroupSetup.onSelectionChange).toHaveBeenCalledWith({
      elementIds: ['g2'],
      primaryId: 'g2',
    });
  });

  it('toggleGroup compacts non-adjacent members into the legacy contiguous z-order block', () => {
    const elements = [text('a'), text('between'), text('c'), text('top')];
    const { commands, onIntents } = setup({
      elements,
      selection: { elementIds: ['a', 'c'], primaryId: 'c' },
    });

    commands.toggleGroup();

    const intents = onIntents.mock.calls[0][0];
    const next = applyRendererEditIntents(content(elements), intents);
    expect(next.canvas.elements.map((element) => element.id)).toEqual(['between', 'a', 'c', 'top']);
    expect(next.canvas.elements.filter((element) => element.groupId === 'group-new')).toHaveLength(
      2,
    );
    expect(onIntents).toHaveBeenCalledTimes(1);
  });

  it('reorderTarget moves a group as one block across an adjacent group', () => {
    const elements = [
      text('a1', { groupId: 'A' }),
      text('a2', { groupId: 'A' }),
      text('b1', { groupId: 'B' }),
      text('b2', { groupId: 'B' }),
    ];
    const { commands, onIntents } = setup({
      elements,
      selection: { elementIds: ['a1', 'a2'], primaryId: 'a1' },
    });

    commands.reorderTarget('a1', 'forward');

    expect(onIntents).toHaveBeenCalledWith([
      { type: 'element.reorder', id: 'a2', command: 'forward' },
      { type: 'element.reorder', id: 'a1', command: 'forward' },
      { type: 'element.reorder', id: 'a2', command: 'forward' },
      { type: 'element.reorder', id: 'a1', command: 'forward' },
    ]);
    const intents = onIntents.mock.calls[0][0];
    const next = applyRendererEditIntents(content(elements), intents);
    expect(next.canvas.elements.map((element) => element.id)).toEqual(['b1', 'b2', 'a1', 'a2']);
  });

  it('alignSelection emits one align intent for existing selected ids', () => {
    const { commands, onIntents } = setup({
      selection: { elementIds: ['a', 'missing', 'b'], primaryId: 'a' },
    });

    commands.alignSelection('middle');

    expect(onIntents).toHaveBeenCalledWith([
      { type: 'element.align', ids: ['a', 'b'], command: 'middle' },
    ]);
  });

  it('skips destructive no-op commands when the effective selection is empty', () => {
    const { commands, onIntents, onSelectionChange } = setup({
      selection: { elementIds: ['missing'], primaryId: 'missing' },
    });

    commands.deleteSelection();
    commands.lockSelection();
    commands.toggleGroup();
    commands.alignSelection('left');
    commands.reorderTarget('missing', 'front');

    expect(onIntents).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});
