/**
 * Playback persistence on the learner RuntimeStore.
 *
 * Consumed discussions are monotonic session facts. Appends are intentionally
 * at-least-once; reads fold valid records into a set, making duplicate facts
 * harmless without cursor-style conflict machinery.
 */
import type { RuntimeRecord, RuntimeSession } from '@openmaic/dsl';
import { BrowserKVStore, type KVStore, type RuntimeStore } from '@openmaic/storage';

import { loadCursorValue, saveCursorValue, type PlaybackLegacyStore } from '@/lib/playback/cursor';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';

export interface PlaybackRuntimeDeps {
  store?: RuntimeStore;
  kv?: KVStore;
  learnerKey?: string;
  legacyStore?: PlaybackLegacyStore;
  now?: () => string;
  mintRecordId?: () => string;
}

export interface RecordConsumedDiscussionInput {
  stageId: string;
  sceneId: string;
  discussionId: string;
}

let defaultKv: KVStore | undefined;

function resolveKv(kv?: KVStore): KVStore {
  if (kv) return kv;
  if (typeof window === 'undefined') {
    throw new Error('Playback legacy migration is client-only');
  }
  return (defaultKv ??= new BrowserKVStore());
}

interface DiscussionConsumedPayload {
  payloadVersion: 1;
  event: 'discussionConsumed';
  discussionId: string;
}

function idSegment(value: string): string {
  return encodeURIComponent(value);
}

export function playbackSessionId(stageId: string, learnerKey: string): string {
  return ['playback', idSegment(stageId), idSegment(learnerKey)].join(':');
}

function mintId(): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `playback-record:${suffix}`;
}

function asDiscussionConsumed(record: RuntimeRecord): DiscussionConsumedPayload | undefined {
  if (!record.payload || typeof record.payload !== 'object') return undefined;
  const payload = record.payload as Partial<DiscussionConsumedPayload>;
  if (
    payload.payloadVersion !== 1 ||
    payload.event !== 'discussionConsumed' ||
    typeof payload.discussionId !== 'string'
  ) {
    return undefined;
  }
  return payload as DiscussionConsumedPayload;
}

function assertPlaybackPartition(
  session: RuntimeSession,
  stageId: string,
  learnerKey: string,
): void {
  if (
    session.kind !== 'playback' ||
    session.stageId !== stageId ||
    session.learnerKey !== learnerKey
  ) {
    throw new Error(
      `Playback session ${JSON.stringify(session.id)} does not belong to stage ` +
        `${JSON.stringify(stageId)} and learner ${JSON.stringify(learnerKey)}`,
    );
  }
}

/**
 * Every playback session in the learner's partition, oldest first. A learner
 * merge (`mergeLearner`) deliberately preserves same-kind sessions from both
 * keys, so reads must fold ALL of them; the oldest is the canonical target
 * for future appends.
 */
async function listPlaybackSessions(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
): Promise<RuntimeSession[]> {
  const sessions = await store.listSessions(stageId, learnerKey);
  return sessions
    .filter((session) => session.kind === 'playback')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

async function findPlaybackSession(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
): Promise<RuntimeSession | undefined> {
  return (await listPlaybackSessions(store, stageId, learnerKey))[0];
}

/** Fold every valid discussion fact across ALL playback sessions. */
async function foldConsumedDiscussions(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
): Promise<Set<string>> {
  const sessions = await listPlaybackSessions(store, stageId, learnerKey);
  const consumed = new Set<string>();
  for (const session of sessions) {
    const records = await store.listRecords(session.id);
    for (const record of records) {
      const payload = asDiscussionConsumed(record);
      if (payload) consumed.add(payload.discussionId);
    }
  }
  return consumed;
}

async function ensurePlaybackSession(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
  timestamp: string,
): Promise<RuntimeSession> {
  const existing = await findPlaybackSession(store, stageId, learnerKey);
  if (existing) return existing;

  const id = playbackSessionId(stageId, learnerKey);
  try {
    return await store.createSession({
      id,
      kind: 'playback',
      stageId,
      learnerKey,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  } catch (error) {
    // Without Web Locks another tab may win the deterministic create after
    // our list. Re-list the partition and use that winner.
    const winner = await findPlaybackSession(store, stageId, learnerKey);
    if (!winner) throw error;
    return winner;
  }
}

async function appendConsumedDiscussion(
  input: RecordConsumedDiscussionInput,
  store: RuntimeStore,
  learnerKey: string,
  now: () => string,
  mintRecordId: () => string,
): Promise<void> {
  const timestamp = now();
  const session = await ensurePlaybackSession(store, input.stageId, learnerKey, timestamp);
  assertPlaybackPartition(session, input.stageId, learnerKey);
  await store.appendRecord({
    id: mintRecordId(),
    sessionId: session.id,
    sceneId: input.sceneId,
    createdAt: timestamp,
    payload: {
      payloadVersion: 1,
      event: 'discussionConsumed',
      discussionId: input.discussionId,
    },
  });
}

async function defaultLegacyStore(): Promise<PlaybackLegacyStore> {
  if (typeof window === 'undefined') {
    throw new Error('Legacy playback migration is client-only');
  }
  const { db } = await import('@/lib/utils/database');
  return {
    async get(stageId) {
      const row: unknown = await db.playbackState.get(stageId);
      return row as Awaited<ReturnType<PlaybackLegacyStore['get']>>;
    },
    async delete(stageId) {
      await db.playbackState.delete(stageId);
    },
  };
}

async function resolveLegacyStore(legacyStore?: PlaybackLegacyStore): Promise<PlaybackLegacyStore> {
  return legacyStore ?? defaultLegacyStore();
}

/**
 * Migrate both halves of one legacy Dexie row before deleting it. This is
 * exported for the cursor's lazy read path; application code should use the
 * two public load APIs instead.
 */
export async function migrateLegacyPlaybackState(
  stageId: string,
  deps: PlaybackRuntimeDeps = {},
): Promise<void> {
  const legacyStore = await resolveLegacyStore(deps.legacyStore);
  const legacy = await legacyStore.get(stageId);
  if (!legacy) return;

  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const kv = resolveKv(deps.kv);
  const now = deps.now ?? (() => new Date().toISOString());
  const mintRecordId = deps.mintRecordId ?? mintId;

  if (!(await loadCursorValue(stageId, kv)) && legacy.sceneId) {
    const updatedAt = new Date(legacy.updatedAt).toISOString();
    await saveCursorValue(
      stageId,
      { sceneId: legacy.sceneId, actionIndex: legacy.actionIndex, updatedAt },
      kv,
    );
  }

  // Append only the facts not yet durable, so a migration interrupted after a
  // partial append resumes exactly where it failed instead of dropping the
  // tail (the legacy row survives until every fact landed).
  if (legacy.sceneId) {
    const durable = await foldConsumedDiscussions(store, stageId, learnerKey);
    for (const discussionId of new Set(legacy.consumedDiscussions)) {
      if (durable.has(discussionId)) continue;
      await appendConsumedDiscussion(
        { stageId, sceneId: legacy.sceneId, discussionId },
        store,
        learnerKey,
        now,
        mintRecordId,
      );
    }
  }

  await legacyStore.delete(stageId);
}

/** Load and fold every valid discussion-consumed fact for this learner. */
export async function loadConsumedDiscussions(
  stageId: string,
  deps: PlaybackRuntimeDeps = {},
): Promise<Set<string>> {
  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  await migrateLegacyPlaybackState(stageId, { ...deps, store, learnerKey });
  return foldConsumedDiscussions(store, stageId, learnerKey);
}

/**
 * Append one fact without allowing background persistence failures into UI
 * flow. Returns whether the fact is durable so callers can retry a transient
 * failure on a later progress tick (at-least-once).
 */
export async function recordConsumedDiscussion(
  input: RecordConsumedDiscussionInput,
  deps: PlaybackRuntimeDeps = {},
): Promise<boolean> {
  try {
    const store = deps.store ?? getRuntimeStore();
    const learnerKey = deps.learnerKey ?? (await getLearnerKey());
    await appendConsumedDiscussion(
      input,
      store,
      learnerKey,
      deps.now ?? (() => new Date().toISOString()),
      deps.mintRecordId ?? mintId,
    );
    return true;
  } catch (error) {
    console.warn(
      `Failed to record consumed playback discussion for stage ${input.stageId}:`,
      error,
    );
    return false;
  }
}
