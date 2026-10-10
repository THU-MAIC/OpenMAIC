import { AsyncLocalStorage } from 'node:async_hooks';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import type { PendingOperation } from '@/lib/persistence/owner-bound-document-store';

/**
 * The owner-bound store carries the operation its transaction gates in the
 * caller's async context. That context must not cost an `AsyncLocalStorage`
 * per store: a server builds a store per request, and every storage that has
 * run stays registered with `async_hooks`, so per-store storages make each
 * later promise slower for the life of the process.
 */

const storages = vi.hoisted(() => ({ constructed: 0 }));

vi.mock('node:async_hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:async_hooks')>();
  class CountingAsyncLocalStorage<T> extends actual.AsyncLocalStorage<T> {
    constructor() {
      super();
      storages.constructed += 1;
    }
  }
  return { ...actual, AsyncLocalStorage: CountingAsyncLocalStorage };
});

const { createOwnerBoundDocumentStore, OperationScope } =
  await import('@/lib/persistence/owner-bound-document-store');

/** A pool that records which course each transaction's ownership gate asked for. */
function recordingPool() {
  const gatedStageIds: string[] = [];
  return {
    gatedStageIds,
    async connect() {
      return {
        async query(text: string, params?: unknown[]) {
          if (text.includes('FROM stage_meta WHERE stage_id = $1')) {
            gatedStageIds.push(params?.[0] as string);
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

function op(stageId: string): PendingOperation {
  return { stageId, mode: 'read' };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function collectGarbage(): () => void {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  // The context above already holds `gc`; restore the flag for the rest of the worker.
  setFlagsFromString('--no-expose-gc');
  return gc;
}

describe('owner-bound store operation scope', () => {
  it('builds no AsyncLocalStorage per store, and each store gates its own operation', async () => {
    const before = storages.constructed;
    const pools = Array.from({ length: 500 }, () => recordingPool());
    const stores = pools.map((pool) =>
      createOwnerBoundDocumentStore({
        pool,
        ownerId: 'owner-1',
        validateScene: (scene) => scene as never,
        validateStage: (stage) => stage as never,
        createHooks: { name: 'none' },
      }),
    );

    // An unclaimed course reads as missing; the gate still ran first.
    const loaded = await Promise.all(
      stores.map((store, index) => store.loadDocument(`stage-${index}`)),
    );

    expect(loaded.every((doc) => doc === null)).toBe(true);
    expect(storages.constructed).toBe(before);
    pools.forEach((pool, index) => {
      expect(pool.gatedStageIds).toEqual([`stage-${index}`]);
    });
  });

  it('keeps nested operations of different stores apart', async () => {
    const a = new OperationScope();
    const b = new OperationScope();
    const seen: Record<string, unknown> = {};

    await a.run(op('a-outer'), async () => {
      await tick();
      seen.aOuter = a.current()?.stageId;
      seen.bOutsideB = b.current();
      await b.run(op('b'), async () => {
        await tick();
        seen.aInsideB = a.current()?.stageId;
        seen.bInsideB = b.current()?.stageId;
        await a.run(op('a-inner'), async () => {
          await tick();
          seen.aInnermost = a.current()?.stageId;
          seen.bUnderInnerA = b.current()?.stageId;
        });
        seen.aAfterInner = a.current()?.stageId;
      });
      seen.aAfterB = a.current()?.stageId;
      seen.bAfterB = b.current();
    });

    expect(seen).toEqual({
      aOuter: 'a-outer',
      bOutsideB: undefined,
      aInsideB: 'a-outer',
      bInsideB: 'b',
      aInnermost: 'a-inner',
      bUnderInnerA: 'b',
      aAfterInner: 'a-outer',
      aAfterB: 'a-outer',
      bAfterB: undefined,
    });
    expect(a.current()).toBeUndefined();
  });

  it('gives concurrent operations on one store each their own', async () => {
    const scope = new OperationScope();
    const seen = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        scope.run(op(`stage-${index}`), async () => {
          await new Promise((resolve) => setTimeout(resolve, (index * 7) % 5));
          const first = scope.current()?.stageId;
          await tick();
          return [first, scope.current()?.stageId];
        }),
      ),
    );

    seen.forEach((pair, index) => {
      expect(pair).toEqual([`stage-${index}`, `stage-${index}`]);
    });
  });

  it('keeps no replaced operation alive in a context that outlives it', async () => {
    const scopes = [new OperationScope(), new OperationScope()];
    const operations: WeakRef<PendingOperation>[] = [];
    const HOPS = 200;

    // Fire-and-forget work that re-enters the same stores from the context
    // of the previous hop, then keeps the context of the last one.
    const lastContext = await new Promise<<T>(fn: () => T) => T>((resolve) => {
      const hop = (index: number) => {
        const operation = op(`stage-${index}`);
        operations.push(new WeakRef(operation));
        void scopes[index % 2].run(operation, async () => {
          if (index === HOPS) resolve(AsyncLocalStorage.snapshot());
          else setTimeout(() => hop(index + 1), 0);
        });
      };
      hop(0);
    });

    const gc = collectGarbage();
    for (let round = 0; round < 3; round += 1) {
      await tick();
      gc();
    }

    expect(lastContext(() => scopes[0].current()?.stageId)).toBe(`stage-${HOPS}`);
    expect(lastContext(() => scopes[1].current()?.stageId)).toBe(`stage-${HOPS - 1}`);
    const retained = operations
      .slice(0, HOPS - 1)
      .filter((operation) => operation.deref() !== undefined);
    expect(retained).toHaveLength(0);
  });
});
