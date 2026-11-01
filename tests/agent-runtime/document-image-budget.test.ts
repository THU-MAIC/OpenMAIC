import { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';

import type { DocumentArtifact, DocumentExtractorProvider } from '@/lib/document/types';
import * as parser from '@/lib/server/material-extraction/document-image-parser';
import {
  ownerDocumentOutcome,
  resolveDerivativeRefsAsync,
} from '@/lib/server/material-extraction/document-images';

vi.mock('node:worker_threads', () => ({
  Worker: vi.fn(function () {
    throw new Error('Over-budget text must never start a worker');
  }),
}));

const provider = { id: 'test-doc', version: '1' } as unknown as DocumentExtractorProvider;
const artifact = (text: string): DocumentArtifact => ({
  metadata: {},
  blocks: [{ id: 'body', type: 'markdown', text }],
  assets: [],
  diagnostics: [{ severity: 'warning', message: 'Provider diagnostic' }],
});
const oversized = [
  ['UTF-8 bytes', '界'.repeat(1_400_000)],
  ['HTML tag starts', '<span>x</span>'.repeat(50_001)],
] as const;

afterEach(() => {
  expect(Worker).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it.each(oversized)('publishes unchanged text when %s exceed the budget', async (_kind, body) => {
  const text = body + '\n\n![kept](images/fig.png) ![missing](images/missing.png)';
  const outcome = await ownerDocumentOutcome(artifact(text), provider);
  expect(outcome.text).toBe(text);
  expect(outcome.imageRefs).toEqual([]);
  expect(outcome.stats).toMatchObject({
    chars: text.length,
    diagnostics: [
      'Provider diagnostic',
      'Document image rewriting skipped: input exceeds parser budget',
    ],
  });
});

it.each(oversized)('reads unchanged legacy text when %s exceed the budget', async (kind, body) => {
  const text = '\uFEFF' + body + '\n\n![kept](openmaic-derivative:img-1)';
  const worker = vi.spyOn(parser, 'runDocumentImageWorker');
  for (const id of ['first-reader', 'second-reader']) {
    expect(
      await resolveDerivativeRefsAsync(text, [{ key: 'img-1', id }], `budget-legacy:${kind}`),
    ).toBe(text);
  }
  // No empty plan is cached to turn a skipped parse into a successful parse.
  expect(worker).toHaveBeenCalledTimes(2);
});

it('preserves over-budget text when invalid published positions require a legacy plan', async () => {
  const text = oversized[0][1] + '\n\n![kept](openmaic-derivative:img-1)';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(
    await resolveDerivativeRefsAsync(text, [{ key: 'img-1', id: 'own-image' }], 'budget-invalid', [
      { start: 0, end: 1, key: 'img-1' },
    ]),
  ).toBe(text);
});

it.each([false, true])(
  'does not hide an actual parse/queue failure (retryable=%s)',
  async (retryable) => {
    const error = new parser.DocumentImageParseError(
      Object.assign(new Error(retryable ? 'queue full' : 'worker failed'), { retryable }),
    );
    vi.spyOn(parser, 'runDocumentImageWorker').mockRejectedValue(error);
    await expect(ownerDocumentOutcome(artifact('![x](images/fig.png)'), provider)).rejects.toBe(
      error,
    );
    await expect(
      resolveDerivativeRefsAsync(
        '![x](openmaic-derivative:img-1)',
        [{ key: 'img-1', id: 'own-image' }],
        `budget-error:${retryable}`,
      ),
    ).rejects.toBe(error);
  },
);

it('honors cancellation rather than returning over-budget text', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    resolveDerivativeRefsAsync(
      oversized[0][1],
      [{ key: 'img-1', id: 'own-image' }],
      'budget-aborted',
      undefined,
      controller.signal,
    ),
  ).rejects.toThrow('aborted');
});

it('does not swallow cancellation arriving while budget rejection settles', async () => {
  const controller = new AbortController();
  const reading = resolveDerivativeRefsAsync(
    oversized[0][1],
    [{ key: 'img-1', id: 'own-image' }],
    'budget-abort-race',
    undefined,
    controller.signal,
  );
  controller.abort();
  await expect(reading).rejects.toBeInstanceOf(parser.DocumentImageInputBudgetError);
});

it('keeps parser admission rejecting over-budget requests with a distinct error type', async () => {
  for (const [, text] of oversized) {
    await expect(parser.runDocumentImageWorker({ kind: 'plan', text })).rejects.toBeInstanceOf(
      parser.DocumentImageInputBudgetError,
    );
  }
});
