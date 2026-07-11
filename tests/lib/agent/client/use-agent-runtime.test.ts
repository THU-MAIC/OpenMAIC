import { describe, it, expect } from 'vitest';
import { mergeAssistantParts, type PiPart } from '@/lib/agent/client/merge-assistant-parts';

const NO_RESULTS = new Map<string, { result: unknown; isError: boolean }>();

describe('mergeAssistantParts (chronological)', () => {
  it('renders wrap-up text BELOW the tool card (turn order preserved)', () => {
    const turns: PiPart[][] = [
      [
        {
          type: 'toolCall',
          id: 't1',
          name: 'regenerate_scene_actions',
          arguments: { sceneId: 's' },
        },
      ],
      [{ type: 'text', text: '已为你重新生成讲解。' }],
    ];
    const parts = mergeAssistantParts({ turns, toolResults: NO_RESULTS, error: '' });
    expect(parts.map((p) => p.type)).toEqual(['tool-call', 'text']);
  });

  it('keeps in-turn ordering (text before tool call within the same turn)', () => {
    const turns: PiPart[][] = [
      [
        { type: 'text', text: '我来重新生成。' },
        { type: 'toolCall', id: 't1', name: 'regenerate_scene_actions', arguments: {} },
      ],
    ];
    const parts = mergeAssistantParts({ turns, toolResults: NO_RESULTS, error: '' });
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool-call']);
  });

  it('keeps the tool card when a later turn is empty', () => {
    const turns: PiPart[][] = [
      [{ type: 'toolCall', id: 't1', name: 'regenerate_scene_actions', arguments: {} }],
      [],
    ];
    const parts = mergeAssistantParts({ turns, toolResults: NO_RESULTS, error: '' });
    expect(
      parts.some((p) => p.type === 'tool-call' && p.toolName === 'regenerate_scene_actions'),
    ).toBe(true);
  });

  it('attaches tool results by toolCallId', () => {
    const turns: PiPart[][] = [[{ type: 'toolCall', id: 't1', name: 'x', arguments: {} }]];
    const results = new Map([
      ['t1', { result: { details: { sceneId: 's', actions: [1] } }, isError: false }],
    ]);
    const parts = mergeAssistantParts({ turns, toolResults: results, error: '' });
    expect(parts[0]).toMatchObject({
      type: 'tool-call',
      result: { details: { sceneId: 's', actions: [1] } },
    });
  });

  it('appends a run-level error as trailing text', () => {
    const turns: PiPart[][] = [[{ type: 'toolCall', id: 't1', name: 'x', arguments: {} }]];
    const parts = mergeAssistantParts({ turns, toolResults: NO_RESULTS, error: 'boom' });
    expect(parts.map((p) => p.type)).toEqual(['tool-call', 'text']);
    expect(parts[1]).toEqual({ type: 'text', text: 'boom' });
  });

  it('drops empty text and falls back to a single empty part', () => {
    expect(
      mergeAssistantParts({
        turns: [[{ type: 'text', text: '' }]],
        toolResults: NO_RESULTS,
        error: '',
      }),
    ).toEqual([{ type: 'text', text: '' }]);
    expect(mergeAssistantParts({ turns: [], toolResults: NO_RESULTS, error: '' })).toEqual([
      { type: 'text', text: '' },
    ]);
  });
});

// ── Destructive empty-apply guard (mirrors handleEvent's tool_execution_end) ─
function simulateToolExecutionEnd(details: {
  sceneId?: string;
  actions?: unknown;
}): Array<[string, { actions: unknown }]> {
  const calls: Array<[string, { actions: unknown }]> = [];
  const updateScene = (id: string, patch: { actions: unknown }) => calls.push([id, patch]);
  if (details.sceneId && Array.isArray(details.actions) && details.actions.length > 0) {
    updateScene(details.sceneId, { actions: details.actions });
  }
  return calls;
}

describe('tool_execution_end empty-actions guard', () => {
  it('does NOT call updateScene when actions is an empty array', () => {
    expect(simulateToolExecutionEnd({ sceneId: 's1', actions: [] })).toHaveLength(0);
  });

  it('DOES call updateScene when actions has at least one entry', () => {
    const calls = simulateToolExecutionEnd({
      sceneId: 's1',
      actions: [{ type: 'speech', id: 'a1' }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('s1');
  });

  it('does NOT call updateScene when actions is missing (undefined)', () => {
    expect(simulateToolExecutionEnd({ sceneId: 's1', actions: undefined })).toHaveLength(0);
  });

  it('does NOT call updateScene when sceneId is missing', () => {
    expect(simulateToolExecutionEnd({ sceneId: undefined, actions: [{ id: 'a1' }] })).toHaveLength(
      0,
    );
  });
});
