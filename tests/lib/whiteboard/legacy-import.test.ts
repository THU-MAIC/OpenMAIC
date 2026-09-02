import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserRuntimeStore, type MaicDocument, type RuntimeStore } from '@openmaic/storage';
import type { Whiteboard } from '@openmaic/dsl';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppStage } from '@/lib/document-store/persistence-types';
import {
  configureDocumentStorage,
  resetDocumentStorageForTests,
} from '@/lib/document-store/config';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { configureRuntimeStorage, resetRuntimeStorageForTests } from '@/lib/runtime/config';
import type { AppScene } from '@/lib/types/stage';
import {
  createLegacyWhiteboardImporterForTests,
  isLegacyWhiteboardAutoImportEligible,
} from '@/lib/whiteboard/runtime/legacy-import';
import {
  createWhiteboardRuntimeService,
  whiteboardRuntimeSessionId,
} from '@/lib/whiteboard/runtime/store';

beforeAll(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

function board(id = 'legacy-board'): Whiteboard {
  return { id, viewportSize: 1000, viewportRatio: 0.5625, elements: [] };
}

function document(whiteboard?: Whiteboard[]): MaicDocument<AppScene, AppStage> {
  return {
    stage: {
      id: 'stage-1',
      name: 'Stage',
      createdAt: 1,
      updatedAt: 1,
      ...(whiteboard === undefined ? {} : { whiteboard }),
    },
    scenes: [],
  };
}

function harness() {
  const store = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  const service = createWhiteboardRuntimeService({
    store,
    resolveLearnerKey: () => 'learner-1',
    now: () => '2026-08-06T00:00:00.000Z',
    withMaintenanceLock: (work) => work(),
  });
  return { store, service };
}

async function productionSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) return productionSourceFiles(resolved);
      return /\.[cm]?[jt]sx?$/u.test(entry.name) ? [resolved] : [];
    }),
  );
  return files.flat();
}

function resolveLocalImport(repoRoot: string, importer: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return path.resolve(repoRoot, specifier.slice(2));
  if (specifier.startsWith('.')) return path.resolve(path.dirname(importer), specifier);
  return null;
}

describe('dormant Legacy whiteboard import seam', () => {
  it('has no production importer activation', async () => {
    const repoRoot = process.cwd();
    const target = path.resolve(repoRoot, 'lib/whiteboard/runtime/legacy-import');
    const roots = ['app', 'components', 'lib'].map((root) => path.resolve(repoRoot, root));
    const files = (await Promise.all(roots.map(productionSourceFiles))).flat();
    const callers: string[] = [];

    for (const file of files) {
      if (file === `${target}.ts`) continue;
      const source = await readFile(file, 'utf8');
      const specifiers = source.matchAll(
        /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/gu,
      );
      for (const match of specifiers) {
        const resolved = resolveLocalImport(repoRoot, file, match[1]!);
        if (resolved?.replace(/\.[cm]?[jt]sx?$/u, '') === target) {
          callers.push(path.relative(repoRoot, file));
        }
      }
    }

    expect(callers).toEqual([]);
  });

  it('imports one eligible local board exactly once across concurrent attempts', async () => {
    const { store, service } = harness();
    const loadDocument = vi.fn().mockResolvedValue(document([board()]));
    let tail = Promise.resolve();
    const withDocumentLock = async <T>(_stageId: string, work: () => Promise<T>): Promise<T> => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    };
    const run = createLegacyWhiteboardImporterForTests({
      service,
      provenanceEligible: () => true,
      loadDocument,
      withDocumentLock,
    });
    const results = await Promise.all([run('stage-1'), run('stage-1')]);
    expect(results).toContainEqual({ status: 'imported', replayed: false, committedSeq: 0 });
    expect(results).toContainEqual({ status: 'not_imported', reason: 'runtime_authoritative' });
    expect(loadDocument).toHaveBeenCalledOnce();
    const records = await store.listRecords(whiteboardRuntimeSessionId('stage-1', 'learner-1'));
    expect(records).toHaveLength(1);
    expect((await service.read('stage-1')).whiteboard?.id).toBe('legacy-board');
  });

  it('imports an inverted legacy viewportRatio as 9/16 (height/width)', async () => {
    const { service } = harness();
    const run = createLegacyWhiteboardImporterForTests({
      service,
      provenanceEligible: () => true,
      loadDocument: async () =>
        document([
          {
            id: 'legacy-board',
            viewportSize: 1000,
            viewportRatio: 16 / 9,
            elements: [],
          },
        ]),
    });
    await expect(run('stage-1')).resolves.toMatchObject({ status: 'imported' });
    // The old stage API wrote the 16:9 landscape as width/height; the import
    // must project the sheet at 9/16 so it renders 1000 x 562.5, not portrait.
    expect((await service.read('stage-1')).whiteboard?.viewportRatio).toBe(9 / 16);
  });

  it('reports exact replay when commit response loss is followed by one failed recovery read', async () => {
    const backing = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    });
    let committed = false;
    let failFirstRecoveryRead = true;
    const lossy = new Proxy(backing, {
      get(target, property) {
        if (property === 'appendRecord') {
          return async (...args: Parameters<RuntimeStore['appendRecord']>) => {
            await target.appendRecord(...args);
            committed = true;
            throw new Error('append response lost');
          };
        }
        if (property === 'listRecords') {
          return async (...args: Parameters<RuntimeStore['listRecords']>) => {
            if (committed && failFirstRecoveryRead) {
              failFirstRecoveryRead = false;
              throw new Error('first recovery read unavailable');
            }
            return target.listRecords(...args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RuntimeStore;
    const service = createWhiteboardRuntimeService({
      store: lossy,
      resolveLearnerKey: () => 'learner-1',
      now: () => '2026-08-06T00:00:00.000Z',
      withMaintenanceLock: (work) => work(),
    });
    const run = createLegacyWhiteboardImporterForTests({
      service,
      provenanceEligible: () => true,
      loadDocument: async () => document([board()]),
    });

    await expect(run('stage-1')).resolves.toEqual({
      status: 'imported',
      replayed: true,
      committedSeq: 0,
    });
    expect(
      await backing.listRecords(whiteboardRuntimeSessionId('stage-1', 'learner-1')),
    ).toHaveLength(1);
  });

  it('never reads Legacy state once RuntimeStore has a domain record', async () => {
    const { service } = harness();
    const first = createLegacyWhiteboardImporterForTests({
      service,
      provenanceEligible: () => true,
      loadDocument: async () => document([board()]),
    });
    await first('stage-1');
    const loadDocument = vi.fn().mockResolvedValue(document([board('other')]));
    const again = createLegacyWhiteboardImporterForTests({
      service,
      provenanceEligible: () => true,
      loadDocument,
    });
    await expect(again('stage-1')).resolves.toEqual({
      status: 'not_imported',
      reason: 'runtime_authoritative',
    });
    expect(loadDocument).not.toHaveBeenCalled();
  });

  it('allows an empty session shell to import', async () => {
    const { store, service } = harness();
    await store.createSession({
      id: whiteboardRuntimeSessionId('stage-1', 'learner-1'),
      kind: 'whiteboard',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
    });
    const run = createLegacyWhiteboardImporterForTests({
      service,
      provenanceEligible: () => true,
      loadDocument: async () => document([board()]),
    });
    await expect(run('stage-1')).resolves.toMatchObject({ status: 'imported' });
  });

  it('fails closed before document reads for shared or unknown provenance', async () => {
    const { service } = harness();
    const loadDocument = vi.fn().mockResolvedValue(document([board()]));
    const withDocumentLock = vi.fn();
    const run = createLegacyWhiteboardImporterForTests({
      service,
      provenanceEligible: () => false,
      loadDocument,
      withDocumentLock,
    });
    await expect(run('stage-1')).resolves.toEqual({
      status: 'not_imported',
      reason: 'provenance_ineligible',
    });
    expect(loadDocument).not.toHaveBeenCalled();
    expect(withDocumentLock).not.toHaveBeenCalled();
  });

  it('takes the source snapshot and append inside the per-stage document lock', async () => {
    const { service } = harness();
    let locked = false;
    const guardedService = {
      read: service.read,
      append: vi.fn(async (input: Parameters<typeof service.append>[0]) => {
        expect(locked).toBe(true);
        return service.append(input);
      }),
      reconcileOperation: service.reconcileOperation,
    };
    const loadDocument = vi.fn(async () => {
      expect(locked).toBe(true);
      return document([board()]);
    });
    const run = createLegacyWhiteboardImporterForTests({
      service: guardedService,
      provenanceEligible: () => true,
      loadDocument,
      withDocumentLock: async (stageId, work) => {
        expect(stageId).toBe('stage-1');
        locked = true;
        try {
          return await work();
        } finally {
          locked = false;
        }
      },
    });

    await expect(run('stage-1')).resolves.toMatchObject({ status: 'imported' });
    expect(loadDocument).toHaveBeenCalledOnce();
    expect(guardedService.append).toHaveBeenCalledOnce();
    expect(locked).toBe(false);
  });

  it.each([
    ['missing', document(), 'legacy_missing'],
    ['multiple', document([board('one'), board('two')]), 'legacy_ambiguous'],
    [
      'malformed',
      document([
        {
          id: 'bad',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [{ type: 'bad' }],
        } as never,
      ]),
      'legacy_malformed',
    ],
  ])('skips %s Legacy data without creating Runtime state', async (_label, source, reason) => {
    const { store, service } = harness();
    const run = createLegacyWhiteboardImporterForTests({
      service,
      provenanceEligible: () => true,
      loadDocument: async () => source,
    });
    await expect(run('stage-1')).resolves.toEqual({ status: 'not_imported', reason });
    expect(await store.listSessions('stage-1', 'learner-1')).toEqual([]);
  });

  it('ignores Scene.whiteboards and reports document read failure without content', async () => {
    const { service } = harness();
    const sceneOnly = {
      ...document(),
      scenes: [{ id: 'scene-1', whiteboards: [board('scene-board')] } as never],
    };
    const ignoreScene = createLegacyWhiteboardImporterForTests({
      service,
      provenanceEligible: () => true,
      loadDocument: async () => sceneOnly,
    });
    await expect(ignoreScene('stage-1')).resolves.toEqual({
      status: 'not_imported',
      reason: 'legacy_missing',
    });

    const failing = createLegacyWhiteboardImporterForTests({
      service,
      provenanceEligible: () => true,
      loadDocument: async () => {
        throw new Error('document contains private learner material');
      },
    });
    await expect(failing('stage-2')).resolves.toEqual({
      status: 'uncertain',
      reason: 'document_read_failed',
    });
  });

  it('derives the same import identity from property-order-equivalent snapshots', async () => {
    const first = harness();
    const second = harness();
    const reordered = {
      elements: [],
      viewportRatio: 0.5625,
      viewportSize: 1000,
      id: 'legacy-board',
    } as Whiteboard;
    const runFirst = createLegacyWhiteboardImporterForTests({
      service: first.service,
      provenanceEligible: () => true,
      loadDocument: async () => document([board()]),
    });
    const runSecond = createLegacyWhiteboardImporterForTests({
      service: second.service,
      provenanceEligible: () => true,
      loadDocument: async () => document([reordered]),
    });
    await runFirst('stage-1');
    await runSecond('stage-1');
    const firstRecord = (
      await first.store.listRecords(whiteboardRuntimeSessionId('stage-1', 'learner-1'))
    )[0]!;
    const secondRecord = (
      await second.store.listRecords(whiteboardRuntimeSessionId('stage-1', 'learner-1'))
    )[0]!;
    expect(firstRecord.id).toBe(secondRecord.id);
    expect(firstRecord.payload).toEqual(secondRecord.payload);
  });

  it('lets a concurrently committed RuntimeStore board win without overwriting it', async () => {
    const { service } = harness();
    const run = createLegacyWhiteboardImporterForTests({
      service,
      provenanceEligible: () => true,
      loadDocument: async () => {
        await service.append({
          stageId: 'stage-1',
          expectedLastSeq: null,
          payload: {
            payloadVersion: 1,
            operationId: 'concurrent-winner',
            operation: {
              kind: 'legacy_snapshot_imported',
              source: {
                kind: 'stage.whiteboard',
                fingerprint: `sha256:${'9'.repeat(64)}`,
              },
              whiteboard: board('runtime-winner'),
            },
          },
        });
        return document([board('legacy-loser')]);
      },
    });

    await expect(run('stage-1')).resolves.toEqual({
      status: 'not_imported',
      reason: 'runtime_won',
    });
    expect((await service.read('stage-1')).whiteboard?.id).toBe('runtime-winner');
  });

  it('disables automatic import whenever server persistence is requested', () => {
    const previous = process.env.NEXT_PUBLIC_PERSISTENCE;
    process.env.NEXT_PUBLIC_PERSISTENCE = '1';
    try {
      expect(isLegacyWhiteboardAutoImportEligible()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_PERSISTENCE;
      else process.env.NEXT_PUBLIC_PERSISTENCE = previous;
    }
  });

  it('disables automatic import for any explicit storage configuration', () => {
    configureRuntimeStorage({ learnerKey: () => 'configured' });
    expect(isLegacyWhiteboardAutoImportEligible()).toBe(false);
    resetRuntimeStorageForTests();

    configureDocumentStorage({ store: {} as never });
    expect(isLegacyWhiteboardAutoImportEligible()).toBe(false);
    resetDocumentStorageForTests();
  });
});
