import { describe, expect, it, vi } from 'vitest';
import { runAgentLoop, type AgentLoopStoreState } from '@/lib/chat/agent-loop';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const state: AgentLoopStoreState = {
  stage: null,
  scenes: [],
  currentSceneId: null,
  mode: 'playback',
  whiteboardOpen: false,
};

describe('agent loop async store state', () => {
  it('awaits the fresh state before starting the request', async () => {
    const pending = deferred<AgentLoopStoreState>();
    const fetchChat = vi.fn(async () => new Response(''));
    const running = runAgentLoop(
      { config: { agentIds: [] }, apiKey: '' },
      {
        getStoreState: () => pending.promise,
        getMessages: () => [],
        fetchChat,
        onEvent: vi.fn(),
        onIterationEnd: async () => null,
      },
      new AbortController().signal,
    );

    await Promise.resolve();
    expect(fetchChat).not.toHaveBeenCalled();
    pending.resolve(state);
    await expect(running).resolves.toMatchObject({ reason: 'no_done' });
    expect(fetchChat).toHaveBeenCalledWith(
      expect.objectContaining({ storeState: state }),
      expect.any(AbortSignal),
    );
  });

  it('does not fetch after teardown aborts a pending state read', async () => {
    const pending = deferred<AgentLoopStoreState>();
    const controller = new AbortController();
    const fetchChat = vi.fn(async () => new Response(''));
    const running = runAgentLoop(
      { config: { agentIds: [] }, apiKey: '' },
      {
        getStoreState: () => pending.promise,
        getMessages: () => [],
        fetchChat,
        onEvent: vi.fn(),
        onIterationEnd: async () => null,
      },
      controller.signal,
    );

    controller.abort();

    await expect(
      Promise.race([
        running,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('abort remained blocked on store state')), 50),
        ),
      ]),
    ).resolves.toMatchObject({ reason: 'aborted' });
    expect(fetchChat).not.toHaveBeenCalled();
  });
});
