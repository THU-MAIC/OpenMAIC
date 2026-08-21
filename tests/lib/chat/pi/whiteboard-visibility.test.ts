import { describe, expect, it, vi } from 'vitest';

import {
  queryWhiteboardVisibility,
  settleWhiteboardVisibility,
} from '@/lib/chat/pi/whiteboard-visibility';

describe('Native whiteboard visibility correlation', () => {
  it('settles only an exact learner and Stage match', async () => {
    let queryId = '';
    const pending = queryWhiteboardVisibility({
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      timeoutMs: 1_000,
      dispatch: async (id) => {
        queryId = id;
      },
    });
    await vi.waitFor(() => expect(queryId).not.toBe(''));

    expect(
      settleWhiteboardVisibility({
        queryId,
        stageId: 'wrong-stage',
        learnerKey: 'learner-1',
        visibility: 'closed',
      }),
    ).toBe(false);
    expect(
      settleWhiteboardVisibility({
        queryId,
        stageId: 'stage-1',
        learnerKey: 'wrong-learner',
        visibility: 'closed',
      }),
    ).toBe(false);
    expect(
      settleWhiteboardVisibility({
        queryId,
        stageId: 'stage-1',
        learnerKey: 'learner-1',
        visibility: 'open',
      }),
    ).toBe(true);
    await expect(pending).resolves.toBe('open');
    expect(
      settleWhiteboardVisibility({
        queryId,
        stageId: 'stage-1',
        learnerKey: 'learner-1',
        visibility: 'closed',
      }),
    ).toBe(false);
  });

  it('degrades dispatch rejection and timeout to unknown', async () => {
    await expect(
      queryWhiteboardVisibility({
        stageId: 'stage-1',
        learnerKey: 'learner-1',
        timeoutMs: 1_000,
        dispatch: async () => {
          throw new Error('writer closed');
        },
      }),
    ).resolves.toBe('unknown');

    await expect(
      queryWhiteboardVisibility({
        stageId: 'stage-1',
        learnerKey: 'learner-1',
        timeoutMs: 1,
        dispatch: async () => {},
      }),
    ).resolves.toBe('unknown');
  });

  it('cleans up and preserves caller cancellation', async () => {
    const controller = new AbortController();
    const pending = queryWhiteboardVisibility({
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      signal: controller.signal,
      timeoutMs: 1_000,
      dispatch: async () => {},
    });
    controller.abort('cancelled');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
