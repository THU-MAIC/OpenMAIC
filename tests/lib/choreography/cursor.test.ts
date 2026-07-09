import { describe, expect, test } from 'vitest';
import { resolvePlaybackCursor, EMPTY_SCENE_DWELL } from '@/lib/choreography';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';

const a = (id: string): Action => ({ id, type: 'speech', text: id }) as Action;
const sc = (id: string, actions: Action[]): Scene =>
  ({
    id,
    stageId: 's',
    type: 'slide',
    title: id,
    order: 1,
    content: { type: 'slide', canvas: {} },
    actions,
  }) as unknown as Scene;

describe('resolvePlaybackCursor', () => {
  test('returns the action at the cursor within a scene', () => {
    const scenes = [sc('S0', [a('a0'), a('a1')])];
    expect(resolvePlaybackCursor(scenes, 0, 0)).toMatchObject({
      action: { id: 'a0' },
      sceneId: 'S0',
      sceneIndex: 0,
      actionIndex: 0,
    });
    expect(resolvePlaybackCursor(scenes, 0, 1)).toMatchObject({
      action: { id: 'a1' },
      sceneId: 'S0',
      actionIndex: 1,
    });
  });

  test('advances past an exhausted scene to the next scene', () => {
    const scenes = [sc('S0', [a('a0')]), sc('S1', [a('b0')])];
    expect(resolvePlaybackCursor(scenes, 0, 1)).toMatchObject({
      action: { id: 'b0' },
      sceneId: 'S1',
      sceneIndex: 1,
      actionIndex: 0,
    });
  });

  test('returns null when all scenes are consumed', () => {
    expect(resolvePlaybackCursor([sc('S0', [a('a0')])], 0, 1)).toBeNull();
    expect(resolvePlaybackCursor([], 0, 0)).toBeNull();
  });

  test('a zero-action scene yields ONE synthetic dwell beat (not skipped)', () => {
    const scenes = [sc('S0', [])];
    expect(resolvePlaybackCursor(scenes, 0, 0)).toMatchObject({
      action: EMPTY_SCENE_DWELL,
      sceneId: 'S0',
      sceneIndex: 0,
      actionIndex: 0,
    });
    // After the dwell beat is consumed (actionIndex advanced), the scene is done.
    expect(resolvePlaybackCursor(scenes, 0, 1)).toBeNull();
  });

  test('the dwell beat is an empty-text speech (routes to the reading-timer dwell)', () => {
    expect(EMPTY_SCENE_DWELL).toMatchObject({ type: 'speech', text: '' });
  });

  test('a zero-action scene shows, then playback continues to the next scene', () => {
    const scenes = [sc('S0', []), sc('S1', [a('b0')])];
    expect(resolvePlaybackCursor(scenes, 0, 0)).toMatchObject({
      action: EMPTY_SCENE_DWELL,
      sceneId: 'S0',
    });
    expect(resolvePlaybackCursor(scenes, 0, 1)).toMatchObject({
      action: { id: 'b0' },
      sceneId: 'S1',
      sceneIndex: 1,
      actionIndex: 0,
    });
  });

  test('a zero-action scene in the middle still dwells when reached from the prior scene', () => {
    const scenes = [sc('S0', [a('a0')]), sc('S1', []), sc('S2', [a('c0')])];
    // Finished S0 (actionIndex past its single action) → advance into empty S1 → dwell.
    expect(resolvePlaybackCursor(scenes, 0, 1)).toMatchObject({
      action: EMPTY_SCENE_DWELL,
      sceneId: 'S1',
      sceneIndex: 1,
      actionIndex: 0,
    });
    // After S1's dwell → C0 on S2.
    expect(resolvePlaybackCursor(scenes, 1, 1)).toMatchObject({
      action: { id: 'c0' },
      sceneId: 'S2',
      sceneIndex: 2,
    });
  });
});
