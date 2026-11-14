import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findReusableOwnerMaterialExtraction,
  getReadyOwnerMaterials,
  type OwnerMaterialRecord,
} from '@/lib/persistence/owner-materials';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import {
  awaitOwnerMaterialExtractions,
  extractOwnerMaterial,
  MaterialExtractionTimeoutError,
  orphanResultAgeMs,
  type MaterialExtractionDependencies,
} from '@/lib/server/materials/extraction';
import type { ParsedPdfContent } from '@/lib/types/pdf';

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: {} }),
}));
vi.mock('@/lib/persistence/owner-materials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/owner-materials')>()),
  findReusableOwnerMaterialExtraction: vi.fn(),
  getReadyOwnerMaterials: vi.fn(),
}));

function material(mime = 'application/pdf'): OwnerMaterialRecord {
  return {
    id: 'material',
    ownerId: 'owner',
    kind: 'source',
    derivedFrom: null,
    mime,
    bytes: 1,
    originalName: 'document',
    ossKey: 'material/document',
    assetId: null,
    sha256: 'digest',
    status: 'ready',
    extraction: { status: 'extracting', claimedAt: Date.now() },
    createdAt: Date.now(),
    deletedAt: null,
  };
}

function dependencies(providerId: string) {
  let signal: AbortSignal | undefined;
  let finish!: (parsed: ParsedPdfContent) => void;
  const byteStore = {
    get: vi.fn(async () => Buffer.from('document')),
    put: vi.fn(async () => {}),
    delete: vi.fn(),
    deletePrefix: vi.fn(),
    list: vi.fn(),
  };
  const analyze: MaterialExtractionDependencies['analyze'] = vi.fn((_input, context) => {
    signal = context.signal;
    return new Promise<ParsedPdfContent>((resolve, reject) => {
      finish = resolve;
      signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
    });
  });
  const value: MaterialExtractionDependencies = {
    byteStore,
    analyze,
    services: async () => ({
      document: { providerId, managed: true, userEndpoint: false, origin: 'configuration' },
    }),
  };
  return {
    value,
    byteStore,
    signal: () => signal,
    finish: () => finish({ text: 'complete', images: [] }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(findReusableOwnerMaterialExtraction).mockResolvedValue(null);
  vi.mocked(getReadyOwnerMaterials).mockReset();
});
afterEach(() => vi.useRealTimers());

describe('classic extraction fixed PDF budget', () => {
  it('allows self-hosted PDF work past five minutes and stores its complete result', async () => {
    const deps = dependencies('mineru');
    const parsing = extractOwnerMaterial(
      material(),
      'attempt',
      new AbortController().signal,
      deps.value,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.signal()).toBeDefined();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(deps.signal()?.aborted).toBe(false);
    expect(deps.byteStore.put).not.toHaveBeenCalled();
    deps.finish();
    await expect(parsing).resolves.toMatchObject({ status: 'ready', textChars: 8 });
    expect(deps.byteStore.put).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['mineru', 'application/pdf', 30 * 60_000],
    ['unpdf', 'application/pdf', 300_000],
    ['mineru-cloud', 'application/pdf', 300_000],
    ['mineru', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 300_000],
  ])('enforces the fixed budget for %s / %s', async (provider, mime, ms) => {
    const deps = dependencies(provider);
    const parsing = extractOwnerMaterial(
      material(mime),
      'attempt',
      new AbortController().signal,
      deps.value,
    );
    const rejected = expect(parsing).rejects.toBeInstanceOf(MaterialExtractionTimeoutError);
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(deps.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(deps.signal()?.reason.message).toContain(`${ms / 1000} s`);
    expect(deps.byteStore.put).not.toHaveBeenCalled();
  });

  it('honors an explicit deadline override', async () => {
    const deps = dependencies('mineru');
    const parsing = extractOwnerMaterial(material(), 'attempt', new AbortController().signal, {
      ...deps.value,
      deadlineMs: 50,
    });
    const rejected = expect(parsing).rejects.toBeInstanceOf(MaterialExtractionTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
  });

  it('does not time out a pending PDF while the worker is inside its longer budget', async () => {
    const record = material();
    record.extraction!.claimedAt = Date.now() - 10 * 60_000;
    vi.mocked(getReadyOwnerMaterials).mockResolvedValue([
      { ...record, extraction: { status: 'ready' } },
    ]);
    const waiting = awaitOwnerMaterialExtractions([record], undefined);
    await vi.advanceTimersByTimeAsync(500);
    await expect(waiting).resolves.toMatchObject([{ extraction: { status: 'ready' } }]);
  });

  it.each([
    ['application/pdf', 30 * 60_000],
    ['text/plain', 300_000],
  ])('still stops overdue %s waits after the budget and lease grace', async (mime, ms) => {
    const record = material(mime);
    record.extraction!.claimedAt = Date.now() - ms - 2 * agentRuntimeConfig.leaseTtlMs - 1;
    await expect(awaitOwnerMaterialExtractions([record], undefined)).rejects.toThrow(
      `${ms / 1000} s`,
    );
    expect(getReadyOwnerMaterials).not.toHaveBeenCalled();
    expect(orphanResultAgeMs()).toBeGreaterThan(30 * 60_000 + 2 * agentRuntimeConfig.leaseTtlMs);
  });
});
