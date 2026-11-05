import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { checkpointFailure, checkpointStep } from '@/lib/server/sandbox/checkpoint-errors';
import { checkpointChunks } from '@/lib/server/sandbox/checkpoint-storage';
import { sandboxConflict, sandboxInvalid } from '@/lib/sandbox/errors';

it('retains the failed stage and a safe actionable category without raw errors', async () => {
  const error = await checkpointStep('snapshot', async () => {
    throw sandboxInvalid('PRIVATE CONTENT', 'PBL_SOURCE_SIZE');
  }).catch((error) => error);
  expect(checkpointFailure(error)).toEqual({ reason: 'source-limit', retryable: false });
  expect(error.stage).toBe('snapshot');
  expect(JSON.stringify(error)).not.toContain('PRIVATE');
  expect(checkpointFailure(new Error('PRIVATE URL'))).toEqual({
    reason: 'unavailable',
    retryable: true,
  });
});

it('keeps a busy writer outside the archive-failure policy', async () => {
  const busy = sandboxConflict('Running command', 'WORKSPACE_COMMAND_ACTIVE');
  await expect(
    checkpointStep('snapshot', async () => {
      throw busy;
    }),
  ).rejects.toBe(busy);
});

it('stops consuming a stuck export when its deadline aborts', async () => {
  const controller = new AbortController();
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  };
  const next = checkpointChunks(source, 1024, controller.signal).next();
  const rejected = expect(next).rejects.toThrow('deadline');
  controller.abort(new DOMException('deadline', 'TimeoutError'));
  await rejected;
});
