import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn() }));
vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';

afterEach(() => vi.clearAllMocks());

describe('failed model transport cleanup', () => {
  it.each(['error-part', 'iterator-error', 'invalid-finish'])(
    'aborts an open HTTP stream after %s without waiting for caller cancellation',
    async (failure) => {
      let closed = false;
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: provider error\n\n');
        response.on('close', () => {
          closed = true;
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test listener');
      const caller = new AbortController();
      let transportSignal: AbortSignal | undefined;
      mocks.streamLLM.mockImplementation(async (options) => {
        transportSignal = options.abortSignal;
        const response = await fetch(`http://127.0.0.1:${address.port}`, {
          signal: transportSignal,
        });
        const reader = response.body!.getReader();
        return {
          fullStream: (async function* () {
            await reader.read();
            if (failure === 'iterator-error') throw new Error('Provider stream failed');
            yield failure === 'error-part'
              ? { type: 'error', error: new Error('Provider stream failed') }
              : { type: 'finish', finishReason: 'error' };
          })(),
        };
      });
      try {
        const stream = await createCallLlmStreamFn({
          languageModel: {} as never,
          abortSignal: caller.signal,
        })({} as never, { messages: [], tools: [] });
        expect((await stream.result()).stopReason).toBe('error');
        expect(caller.signal.aborted).toBe(false);
        expect(transportSignal?.aborted).toBe(true);
        await vi.waitFor(() => expect(closed).toBe(true));
        caller.abort('late cancellation');
        expect((await stream.result()).stopReason).toBe('error');
      } finally {
        caller.abort();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    },
  );
});
