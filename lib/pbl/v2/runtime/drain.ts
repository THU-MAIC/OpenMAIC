/**
 * Client-only PBL event drainer (#869).
 *
 * Drains both bounded project outboxes, `runtimeEvents` and
 * `engagementEvents`, into the active PBL runtime session. Each ledger has an
 * independent device-scoped watermark per `(stageId, sceneId, learnerKey)`.
 * If a saved watermark points to an event that has already fallen out of the
 * in-project ring buffer, the visible ledger is drained again. This is
 * intentionally at-least-once: downstream folds must deduplicate by event id
 * instead of assuming RuntimeStore record ids are unique.
 *
 * The project outboxes are bounded rings (500 events). If more than 500
 * runtime or engagement events are appended between drains, the evicted gap is
 * unrecoverable from this outbox. That latent-loss window is acceptable during
 * dual-write because `projectV2` remains the source of truth; the read flip
 * will backfill runtime state from a `projectV2` snapshot.
 *
 * Server code must not import this module without injecting its own
 * `RuntimeStore` and `KVStore`: the defaults lazily touch IndexedDB and
 * localStorage through the browser storage backends.
 */
import { BrowserKVStore, type KVStore, type RuntimeStore } from '@openmaic/storage';

import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';
import type { PBLEngagementEvent, PBLProjectV2, PBLRuntimeEvent } from '@/lib/pbl/v2/types';

const PBL_DRAIN_TIMEOUT_MS = 10_000;
const WATERMARK_SCOPE = 'device';

let defaultKv: KVStore | undefined;
const inFlightPblSessions = new Map<string, Promise<string>>();

interface PBLRuntimeDrainWatermark {
  lastRuntimeEventId?: string;
  lastEngagementEventId?: string;
}

export interface DrainProjectRuntimeArgs {
  stageId: string;
  sceneId: string;
  project: PBLProjectV2;
  store?: RuntimeStore;
  kv?: KVStore;
  learnerKey?: string;
}

function getDefaultKv(): KVStore {
  return (defaultKv ??= new BrowserKVStore());
}

function watermarkKey(stageId: string, sceneId: string, learnerKey: string): string {
  return `runtime.pblDrain.${stageId}.${sceneId}.${learnerKey}`;
}

function deterministicPBLSessionId(stageId: string, learnerKey: string): string {
  return `pbl-${stageId}-${learnerKey}`;
}

/** Reject after `ms`, clearing the timer once the raced promise settles. */
async function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeWatermark(value: unknown): PBLRuntimeDrainWatermark {
  if (!value || typeof value !== 'object') return {};
  const maybe = value as {
    lastRuntimeEventId?: unknown;
    lastEngagementEventId?: unknown;
  };
  const watermark: PBLRuntimeDrainWatermark = {};
  if (typeof maybe.lastRuntimeEventId === 'string') {
    watermark.lastRuntimeEventId = maybe.lastRuntimeEventId;
  }
  if (typeof maybe.lastEngagementEventId === 'string') {
    watermark.lastEngagementEventId = maybe.lastEngagementEventId;
  }
  return watermark;
}

async function readWatermark(kv: KVStore, key: string): Promise<PBLRuntimeDrainWatermark> {
  try {
    return normalizeWatermark(await kv.get<PBLRuntimeDrainWatermark>(key, WATERMARK_SCOPE));
  } catch (error) {
    console.warn(
      `Ignoring unreadable PBL drain watermark ${key}; redraining visible events:`,
      error,
    );
    return {};
  }
}

function undrainedEvents<TEvent extends { id: string }>(
  events: readonly TEvent[],
  lastEventId: string | undefined,
): TEvent[] {
  if (!lastEventId) return [...events];
  const drainedIndex = events.findIndex((event) => event.id === lastEventId);
  if (drainedIndex < 0) {
    // The in-project ledger is a bounded outbox, not the archive. If the
    // saved watermark points to an event that has fallen out of the ring buffer
    // (or the watermark is otherwise stale), we redrain the visible ledger.
    // This is intentionally at-least-once: downstream folds must deduplicate by
    // event id instead of treating the RuntimeStore as a unique-id index.
    return [...events];
  }
  return events.slice(drainedIndex + 1);
}

async function ensurePBLSession(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
): Promise<string> {
  const inFlightKey = `${stageId}:${learnerKey}`;
  const inFlight = inFlightPblSessions.get(inFlightKey);
  if (inFlight) return inFlight;

  const sessionPromise = ensurePBLSessionUnmemoized(store, stageId, learnerKey);
  inFlightPblSessions.set(inFlightKey, sessionPromise);
  try {
    return await sessionPromise;
  } finally {
    inFlightPblSessions.delete(inFlightKey);
  }
}

async function ensurePBLSessionUnmemoized(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
): Promise<string> {
  const sessions = await store.listSessions(stageId, learnerKey);
  const active = sessions.find((session) => session.kind === 'pbl' && session.status === 'active');
  if (active) return active.id;

  const now = new Date().toISOString();
  try {
    const created = await store.createSession({
      id: deterministicPBLSessionId(stageId, learnerKey),
      kind: 'pbl',
      stageId,
      learnerKey,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    return created.id;
  } catch (error) {
    if (!/already exists/i.test(String(error instanceof Error ? error.message : error))) {
      throw error;
    }
    const relisted = await store.listSessions(stageId, learnerKey);
    const racedActive = relisted.find(
      (session) => session.kind === 'pbl' && session.status === 'active',
    );
    if (racedActive) return racedActive.id;
    throw error;
  }
}

function subAnchorFor(event: PBLRuntimeEvent): string | undefined {
  return event.microtaskId ?? event.milestoneId;
}

function subAnchorForEngagement(event: PBLEngagementEvent): string | undefined {
  return event.microtaskId;
}

type DrainablePBLEvent =
  | {
      ledger: 'runtime';
      event: PBLRuntimeEvent;
      index: number;
    }
  | {
      ledger: 'engagement';
      event: PBLEngagementEvent;
      index: number;
    };

function orderedDrainEvents(
  runtimeEvents: readonly PBLRuntimeEvent[],
  engagementEvents: readonly PBLEngagementEvent[],
): DrainablePBLEvent[] {
  return [
    ...runtimeEvents.map((event, index) => ({ ledger: 'runtime' as const, event, index })),
    ...engagementEvents.map((event, index) => ({ ledger: 'engagement' as const, event, index })),
  ].sort((a, b) => {
    const byTimestamp = a.event.ts.localeCompare(b.event.ts);
    if (byTimestamp !== 0) return byTimestamp;
    // Preserve original order inside each ledger; for simultaneous events
    // across ledgers, runtime facts precede engagement analytics.
    if (a.ledger !== b.ledger) return a.ledger === 'runtime' ? -1 : 1;
    return a.index - b.index;
  });
}

async function persistWatermark(
  kv: KVStore,
  key: string,
  watermark: PBLRuntimeDrainWatermark,
): Promise<void> {
  await kv.set(key, watermark, WATERMARK_SCOPE);
}

export async function clearStageDrainWatermarks(
  stageId: string,
  kv: KVStore = getDefaultKv(),
): Promise<void> {
  const keys = await kv.keys(`runtime.pblDrain.${stageId}.`, WATERMARK_SCOPE);
  await Promise.all(keys.map((key) => kv.remove(key, WATERMARK_SCOPE)));
}

async function drainProjectRuntimeWork({
  stageId,
  sceneId,
  project,
  store: injectedStore,
  kv: injectedKv,
  learnerKey: injectedLearnerKey,
}: DrainProjectRuntimeArgs): Promise<void> {
  const kv = injectedKv ?? getDefaultKv();
  const learnerKey = injectedLearnerKey ?? (await getLearnerKey(kv));
  const store = injectedStore ?? getRuntimeStore();
  const key = watermarkKey(stageId, sceneId, learnerKey);
  const watermark = await readWatermark(kv, key);
  const runtimeEvents = undrainedEvents(project.runtimeEvents ?? [], watermark.lastRuntimeEventId);
  const engagementEvents = undrainedEvents(
    project.engagementEvents ?? [],
    watermark.lastEngagementEventId,
  );
  let nextWatermark: PBLRuntimeDrainWatermark = { ...watermark };

  if (runtimeEvents.length === 0 && engagementEvents.length === 0) {
    await persistWatermark(kv, key, nextWatermark);
    return;
  }

  const sessionId = await ensurePBLSession(store, stageId, learnerKey);

  try {
    for (const item of orderedDrainEvents(runtimeEvents, engagementEvents)) {
      if (item.ledger === 'runtime') {
        await store.appendRecord({
          id: item.event.id,
          sessionId,
          sceneId,
          subAnchor: subAnchorFor(item.event),
          createdAt: item.event.ts,
          payload: item.event,
        });
        nextWatermark = { ...nextWatermark, lastRuntimeEventId: item.event.id };
      } else {
        await store.appendRecord({
          id: item.event.id,
          sessionId,
          sceneId,
          subAnchor: subAnchorForEngagement(item.event),
          createdAt: item.event.ts,
          payload: item.event,
        });
        nextWatermark = { ...nextWatermark, lastEngagementEventId: item.event.id };
      }
    }
  } catch (error) {
    await persistWatermark(kv, key, nextWatermark);
    throw error;
  }

  await persistWatermark(kv, key, nextWatermark);
}

export async function drainProjectRuntime(args: DrainProjectRuntimeArgs): Promise<void> {
  try {
    const work = drainProjectRuntimeWork(args);
    // A rejection landing after the timeout already won the race would have no
    // listener left. Swallow that branch; the await below still reports it if it
    // lands before the timeout.
    work.catch(() => {});
    await withTimeout(work, PBL_DRAIN_TIMEOUT_MS);
  } catch (error) {
    console.warn(`Failed to drain PBL events for stage ${args.stageId}:`, error);
  }
}
