import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { PPTCodeElement } from '@openmaic/dsl';
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';
import {
  PgRuntimeStore,
  ensureSchema,
  type Queryable,
  type WithTransaction,
} from '@openmaic/storage/runtime/pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { createWhiteboardRuntimeService } from '@/lib/whiteboard/runtime/store';
import {
  WhiteboardRuntimeNoChangeError,
  type WhiteboardRuntimeOperationV1,
  type WhiteboardRuntimePayloadV1,
} from '@/lib/whiteboard/runtime/types';

const contractUrl = process.env.PG_CONTRACT_URL;

if (process.env.STORAGE_PG_CONTRACT_REQUIRED === '1' && !contractUrl) {
  throw new Error(
    'whiteboard RuntimeStore: STORAGE_PG_CONTRACT_REQUIRED=1 requires PG_CONTRACT_URL; ' +
      'refusing to skip the PostgreSQL app-domain suite',
  );
}

function transactionFor(pool: Pool): WithTransaction {
  return async (body) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client as Queryable);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the transaction body's original error.
      }
      throw error;
    } finally {
      client.release();
    }
  };
}

function operationPayload(
  operationId: string,
  operation: WhiteboardRuntimeOperationV1,
): WhiteboardRuntimePayloadV1 {
  return { payloadVersion: 1, operationId, operation };
}

function codeElement(): PPTCodeElement {
  return {
    id: 'code-1',
    type: 'code',
    language: 'typescript',
    lines: [
      { id: 'L1', content: 'const one = 1;' },
      { id: 'L2', content: 'const two = 2;' },
      { id: 'L3', content: '' },
    ],
    fileName: 'example.ts',
    showLineNumbers: true,
    fontSize: 14,
    left: 100,
    top: 120,
    width: 500,
    height: 300,
    rotate: 0,
  };
}

async function runDestructiveScenario(store: RuntimeStore) {
  const runtime = createWhiteboardRuntimeService({
    store,
    resolveLearnerKey: () => 'learner-1',
    now: () => '2026-08-21T00:00:00.000Z',
    withMaintenanceLock: (work) => work(),
  });
  const states = [];
  states.push(
    await runtime.append({
      stageId: 'stage-1',
      expectedLastSeq: null,
      payload: operationPayload('add:code', { kind: 'element_added', element: codeElement() }),
    }),
  );
  const edited = operationPayload('edit:code', {
    kind: 'code_lines_edited',
    elementId: 'code-1',
    edit: {
      kind: 'replace_lines',
      lineIds: ['L3', 'L1'],
      lines: [
        { id: 'host-A', content: '' },
        { id: 'host-B', content: 'replacement' },
      ],
    },
  });
  states.push(await runtime.append({ stageId: 'stage-1', expectedLastSeq: 0, payload: edited }));
  states.push(
    await runtime.append({
      stageId: 'stage-1',
      expectedLastSeq: 1,
      payload: operationPayload('add:text', {
        kind: 'element_added',
        element: {
          id: 'text-1',
          type: 'text',
          left: 10,
          top: 20,
          width: 200,
          height: 60,
          rotate: 0,
          content: 'delete me',
          defaultFontName: 'Inter',
          defaultColor: '#000000',
        },
      }),
    }),
  );
  states.push(
    await runtime.append({
      stageId: 'stage-1',
      expectedLastSeq: 2,
      payload: operationPayload('delete:text', {
        kind: 'element_deleted',
        elementId: 'text-1',
      }),
    }),
  );
  const clear = operationPayload('clear:all', { kind: 'elements_cleared' });
  states.push(await runtime.append({ stageId: 'stage-1', expectedLastSeq: 3, payload: clear }));
  const editReplay = await runtime.append({
    stageId: 'stage-1',
    expectedLastSeq: 0,
    payload: edited,
  });
  const noChange = await runtime
    .append({
      stageId: 'stage-1',
      expectedLastSeq: 4,
      payload: operationPayload('clear:empty', { kind: 'elements_cleared' }),
    })
    .catch((error: unknown) => error);
  expect(noChange).toBeInstanceOf(WhiteboardRuntimeNoChangeError);

  return {
    states,
    editReplay,
    noChange: {
      code: (noChange as WhiteboardRuntimeNoChangeError).code,
      reason: (noChange as WhiteboardRuntimeNoChangeError).reason,
      state: (noChange as WhiteboardRuntimeNoChangeError).state,
    },
    records: await store.listRecords('whiteboard:stage-1:learner-1'),
  };
}

async function rejectMalformedWhiteboardRecord(store: RuntimeStore) {
  const sessionId = 'whiteboard:stage-1:learner-1';
  const before = await store.listRecords(sessionId);
  const outcome = await store
    .appendRecord(
      {
        id: 'invalid:authority-extra',
        sessionId,
        createdAt: '2026-08-21T00:00:00.000Z',
        payload: {
          payloadVersion: 1,
          operationId: 'invalid:authority-extra',
          operation: { kind: 'elements_cleared', stageId: 'model-owned-stage' },
        },
      },
      { expectedLastSeq: 4 },
    )
    .then(
      () => ({ accepted: true as const }),
      (error: unknown) => ({ accepted: false as const, error }),
    );

  expect(outcome.accepted).toBe(false);
  if (outcome.accepted) throw new Error('malformed whiteboard payload was accepted');
  expect(outcome.error).toBeInstanceOf(Error);
  const after = await store.listRecords(sessionId);
  expect(after).toEqual(before);
  expect(after).toHaveLength(5);
  expect(after.at(-1)?.seq).toBe(4);
  return {
    name: (outcome.error as Error).name,
    message: (outcome.error as Error).message,
  };
}

describe.skipIf(!contractUrl)('whiteboard app-domain contract with PostgreSQL 16', () => {
  let pool: Pool;
  let pgStore: PgRuntimeStore;

  beforeAll(async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    pool = new Pool({ connectionString: contractUrl, max: 8 });
    await ensureSchema(pool as Queryable);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE runtime_records, runtime_sessions');
    pgStore = new PgRuntimeStore(pool as Queryable, {
      withTransaction: transactionFor(pool),
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    });
  });

  afterAll(async () => {
    await pool.end();
    vi.unstubAllGlobals();
  });

  it('matches BrowserRuntimeStore for delete/edit/clear, replay, and zero-append no-op', async () => {
    const browserStore = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      dbName: 'whiteboard-pg-comparison',
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    });
    const browser = await runDestructiveScenario(browserStore);
    const postgres = await runDestructiveScenario(pgStore);

    expect(postgres).toEqual(browser);
    expect(postgres.records).toHaveLength(5);
    expect(postgres.states.at(-1)).toMatchObject({
      committedSeq: 4,
      state: { lastSeq: 4, whiteboard: { elements: [] } },
    });
    expect(postgres.editReplay).toMatchObject({
      committedSeq: 1,
      replayed: true,
      state: { lastSeq: 4, whiteboard: { elements: [] } },
    });
    expect(postgres.noChange).toMatchObject({
      code: 'WHITEBOARD_RUNTIME_NO_CHANGE',
      reason: 'whiteboard_empty',
      state: { lastSeq: 4, whiteboard: { elements: [] } },
    });

    const browserRejection = await rejectMalformedWhiteboardRecord(browserStore);
    const postgresRejection = await rejectMalformedWhiteboardRecord(pgStore);
    expect(postgresRejection).toEqual(browserRejection);
  });
});
