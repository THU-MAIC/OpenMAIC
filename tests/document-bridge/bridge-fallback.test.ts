import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveDocument: vi.fn(),
  loadDocument: vi.fn(),
  getUser: vi.fn(),
  getEntry: vi.fn(),
  putEntry: vi.fn(),
  report: vi.fn(),
  parityReport: vi.fn(),
}));

vi.mock('@openmaic/storage', () => ({
  BrowserDocumentStore: class {
    saveDocument = mocks.saveDocument;
    loadDocument = mocks.loadDocument;
  },
}));

vi.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { getUser: mocks.getUser } },
}));

vi.mock('@/lib/document-bridge/ledger', () => ({
  getBridgeEntry: mocks.getEntry,
  putBridgeEntry: mocks.putEntry,
}));

vi.mock('@/lib/document-bridge/diagnostics', () => ({
  reportBridgeDiagnostic: mocks.report,
  reportDocumentParityDiagnostic: mocks.parityReport,
}));

vi.mock('@/lib/dsl-extensions/validate', () => ({
  validateStageExtended: () => ({ valid: true }),
  validateSceneExtended: () => ({ valid: true }),
}));

import { bridgeLegacyDocument, compareLegacyDocument } from '@/lib/document-bridge/bridge';

function snapshot(id: string) {
  return {
    stage: { id, name: 'Bridge test', createdAt: 1, updatedAt: 2 },
    scenes: [],
  } as never;
}

describe('DocumentStore bridge fallback guarantee', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE = '1';
    process.env.NEXT_PUBLIC_DOCUMENT_STORE_PARITY_CHECK = '1';
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-a' } } });
    mocks.getEntry.mockResolvedValue(undefined);
    mocks.putEntry.mockResolvedValue(undefined);
    mocks.saveDocument.mockResolvedValue(undefined);
    mocks.loadDocument.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE;
    delete process.env.NEXT_PUBLIC_DOCUMENT_STORE_PARITY_CHECK;
  });

  it('copies a loaded legacy document and records success', async () => {
    await expect(bridgeLegacyDocument(snapshot('course-success'))).resolves.toBe('migrated');

    expect(mocks.saveDocument).toHaveBeenCalledOnce();
    expect(mocks.putEntry).toHaveBeenCalledTimes(2);
    expect(mocks.putEntry.mock.calls[0][1]).toMatchObject({ status: 'in_progress' });
    expect(mocks.putEntry.mock.calls[1][1]).toMatchObject({ status: 'migrated' });
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });

  it('swallows a DocumentStore validation failure and records fallback state', async () => {
    mocks.saveDocument.mockRejectedValueOnce(new Error('invalid scene /content'));

    await expect(bridgeLegacyDocument(snapshot('course-invalid'))).resolves.toBe('skipped');

    expect(mocks.putEntry.mock.calls.at(-1)?.[1]).toMatchObject({
      status: 'failed',
      errorCode: 'validation',
    });
    expect(mocks.report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', errorCode: 'validation' }),
    );
  });

  it('does nothing while the kill switch is off', async () => {
    process.env.NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE = '0';

    await expect(bridgeLegacyDocument(snapshot('course-disabled'))).resolves.toBe('skipped');

    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.saveDocument).not.toHaveBeenCalled();
  });

  it('reports a semantic match without identifying the course', async () => {
    const legacy = snapshot('course-match');
    mocks.loadDocument.mockResolvedValue({ stage: legacy.stage, scenes: [] });

    await expect(compareLegacyDocument(legacy)).resolves.toBe('match');

    expect(mocks.parityReport).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'match' }));
    expect(mocks.parityReport.mock.calls[0][0]).not.toHaveProperty('courseId');
  });

  it('reports a missing isolated document without changing the legacy result', async () => {
    await expect(compareLegacyDocument(snapshot('course-missing'))).resolves.toBe(
      'missing_document',
    );

    expect(mocks.parityReport).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'missing_document', courseId: 'course-missing' }),
    );
  });

  it('reports a semantic mismatch', async () => {
    const legacy = snapshot('course-mismatch');
    mocks.loadDocument.mockResolvedValue({
      stage: { ...legacy.stage, name: 'Changed after bridge' },
      scenes: [],
    });

    await expect(compareLegacyDocument(legacy)).resolves.toBe('mismatch');

    expect(mocks.parityReport).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'mismatch', courseId: 'course-mismatch' }),
    );
  });

  it('reports an IndexedDB read failure but never throws into the course read path', async () => {
    mocks.loadDocument.mockRejectedValueOnce(new Error('IndexedDB transaction failed'));

    await expect(compareLegacyDocument(snapshot('course-read-failure'))).resolves.toBe('skipped');

    expect(mocks.parityReport).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'read_failure', errorCode: 'indexeddb' }),
    );
  });

  it('does not read DocumentStore when the parity flag is off', async () => {
    process.env.NEXT_PUBLIC_DOCUMENT_STORE_PARITY_CHECK = '0';

    await expect(compareLegacyDocument(snapshot('course-parity-disabled'))).resolves.toBe(
      'skipped',
    );

    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.loadDocument).not.toHaveBeenCalled();
  });
});
