import { describe, expect, it } from 'vitest';

import { buildLectureNotes } from '@/lib/chat/lecture-notes';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';

function scene(actions: Action[]): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Scene 1',
    order: 1,
    content: { type: 'slide', canvas: {} },
    actions,
    createdAt: 10,
    updatedAt: 20,
  } as unknown as Scene;
}

describe('buildLectureNotes', () => {
  it('keeps action index and type metadata on transcript lines', () => {
    const notes = buildLectureNotes([
      scene([
        { id: 's1', type: 'speech', text: 'First line' } as Action,
        { id: 'wb1', type: 'wb_open' } as Action,
        { id: 'spot1', type: 'spotlight', elementId: 'box' } as Action,
        { id: 's2', type: 'speech', text: 'Second line' } as Action,
      ]),
    ]);

    expect(notes).toHaveLength(1);
    expect(notes[0].items).toEqual([
      {
        kind: 'speech',
        text: 'First line',
        actionIndex: 0,
        actionId: 's1',
        actionType: 'speech',
      },
      {
        kind: 'action',
        type: 'spotlight',
        actionIndex: 2,
        actionId: 'spot1',
        actionType: 'spotlight',
        label: undefined,
      },
      {
        kind: 'speech',
        text: 'Second line',
        actionIndex: 3,
        actionId: 's2',
        actionType: 'speech',
      },
    ]);
  });

  it('preserves discussion labels and original action indices', () => {
    const notes = buildLectureNotes([
      scene([
        { id: 's1', type: 'speech', text: 'Before discussion' } as Action,
        { id: 'd1', type: 'discussion', topic: 'Why does this matter?' } as Action,
      ]),
    ]);

    expect(notes[0].items[1]).toEqual({
      kind: 'action',
      type: 'discussion',
      label: 'Why does this matter?',
      actionIndex: 1,
      actionId: 'd1',
      actionType: 'discussion',
    });
  });
});
