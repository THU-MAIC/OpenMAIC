/**
 * Chat persistence on the learner RuntimeStore.
 *
 * The legacy Dexie table remains as a one-time migration source. Runtime
 * records are append-only, while the latest session-state record describes
 * the current message window and mutable chat metadata.
 */

import type { RuntimeSession } from '@openmaic/dsl';
import type { KVStore, RuntimeStore } from '@openmaic/storage';
import { HttpRuntimeStoreError } from '@openmaic/storage/runtime/http';
import { isEqual } from 'lodash';
import { nanoid } from 'nanoid';

import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';
import type { ChatSession } from '@/lib/types/chat';
import { db } from './database';
import {
  buildChatRecordInit,
  chatRuntimeCandidates,
  chatRuntimeIdentity,
  foldRecords,
  fromLegacyRecords,
  generationRuntimeSessionId,
  iso,
  newestRuntimeCandidate,
  normalizeSession,
  planChatSync,
  type ChatMessagePayload,
  type FoldedChat,
  type ChatRuntimeCandidate,
  type ChatRuntimeView,
  type ChatSessionStatePayload,
  type LegacyChatConversion,
  type SkippedLegacyChatRow,
} from './chat-storage-core';
import {
  chatStoragePartitionLockName,
  withChatStorageExclusiveLock,
  withChatStorageSharedLock,
} from './chat-storage-lock';

const RESTORE_MARKER_PREFIX = 'chat-restore-marker:';
const DELETION_MARKER_PREFIX = 'chat-deletion:';
const CHAT_DELETION_KIND = 'chat-deletion';
const MAX_CHAT_SYNC_ATTEMPTS = 8;
const MAX_CHAT_PLAN_STEPS_PER_ATTEMPT = 8;
const MAX_CHAT_RETRY_DELAY_MS = 500;

const defaultChatSyncSleep: ChatSyncSleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

interface LegacyChatStore {
  load(stageId: string): Promise<unknown>;
  clear(stageId: string): Promise<void>;
}

export interface ChatStorageOptions {
  store?: RuntimeStore;
  kv?: KVStore;
  learnerKey?: string;
  legacyStore?: LegacyChatStore;
  globalLockHeld?: boolean;
  snapshot?: ChatStorageSnapshot;
  /** Override retry delays in tests or non-browser runtimes. */
  sleep?: ChatSyncSleep;
}

export type ChatSyncSleep = (milliseconds: number) => Promise<void>;

interface ChatStorageRestoreOptions extends ChatStorageOptions {
  rollbackLegacyRows?: () => Promise<void>;
}

export interface ChatStorageReadOptions extends ChatStorageOptions {
  fallbackToLegacyOnError?: boolean;
  observe?: boolean;
  onSnapshot?: (snapshot: ChatStorageSnapshot) => void;
}

export interface ChatStorageSnapshot {
  sessions: ChatSession[];
  /** `undefined` means the runtime generation could not be read authoritatively. */
  restoreMarker?: string | null;
}

export * from './chat-storage-core';

const dexieLegacyStore: LegacyChatStore = {
  async load(stageId) {
    const staged = await db.chatRestoreStaging.where('stageId').equals(stageId).sortBy('createdAt');
    const records =
      staged.length > 0
        ? staged
        : await db.chatSessions.where('stageId').equals(stageId).sortBy('createdAt');
    return records;
  },
  async clear(stageId) {
    await db.transaction('rw', [db.chatSessions, db.chatRestoreStaging], async () => {
      await db.chatSessions.where('stageId').equals(stageId).delete();
      await db.chatRestoreStaging.where('stageId').equals(stageId).delete();
    });
  },
};

// Stage saves are debounced but can overlap. Keep each RuntimeStore partition
// sequential locally. The shared legacy table requires Web Locks across realms;
// injected legacy stores retain the isolated generation fallback used by
// concurrency tests and non-browser adapters.
const storeQueues = new WeakMap<RuntimeStore, Map<string, Promise<void>>>();
const observedChatSessionIds = new WeakMap<RuntimeStore, Map<string, Set<string>>>();
const observedChatSessions = new WeakMap<RuntimeStore, Map<string, Map<string, ChatSession>>>();
const skippedLegacyRowsByPartition = new WeakMap<
  RuntimeStore,
  Map<string, readonly SkippedLegacyChatRow[]>
>();

export class ChatStorageLockUnavailableError extends Error {}
export class ChatStorageSnapshotInvalidatedByRestoreError extends Error {}
export class ChatStorageSnapshotInvalidatedByDeletionError extends Error {}

function observedIds(store: RuntimeStore, key: string): Set<string> {
  return observedChatSessionIds.get(store)?.get(key) ?? new Set();
}

function rememberObservedIds(store: RuntimeStore, key: string, ids: Iterable<string>): void {
  let partitions = observedChatSessionIds.get(store);
  if (!partitions) {
    partitions = new Map();
    observedChatSessionIds.set(store, partitions);
  }
  partitions.set(key, new Set(ids));
}

function observedSessions(store: RuntimeStore, key: string): Map<string, ChatSession> | undefined {
  return observedChatSessions.get(store)?.get(key);
}

function rememberObservedSessions(
  store: RuntimeStore,
  key: string,
  sessions: readonly ChatSession[],
): void {
  let partitions = observedChatSessions.get(store);
  if (!partitions) {
    partitions = new Map();
    observedChatSessions.set(store, partitions);
  }
  partitions.set(
    key,
    new Map(sessions.map((session) => [session.id, structuredClone(normalizeSession(session))])),
  );
}

function skippedLegacyRows(
  store: RuntimeStore,
  key: string,
): readonly SkippedLegacyChatRow[] | undefined {
  return skippedLegacyRowsByPartition.get(store)?.get(key);
}

function rememberSkippedLegacyRows(
  store: RuntimeStore,
  key: string,
  rows: readonly SkippedLegacyChatRow[],
): void {
  const partitions = skippedLegacyRowsByPartition.get(store);
  if (rows.length === 0) {
    partitions?.delete(key);
    return;
  }
  if (partitions) {
    partitions.set(key, rows);
    return;
  }
  skippedLegacyRowsByPartition.set(store, new Map([[key, rows]]));
}

function matchesObservedSessions(
  store: RuntimeStore,
  key: string,
  sessions: readonly ChatSession[],
): boolean {
  const observed = observedSessions(store, key);
  if (!observed) return sessions.length === 0;
  if (observed.size !== sessions.length) return false;
  return sessions.every((session) => isEqual(observed.get(session.id), normalizeSession(session)));
}

function sessionMap(sessions: readonly ChatSession[]): Map<string, ChatSession> {
  return new Map(
    sessions.map((session) => [session.id, structuredClone(normalizeSession(session))]),
  );
}

function matchesSnapshot(snapshot: ChatStorageSnapshot, sessions: readonly ChatSession[]): boolean {
  const baseline = sessionMap(snapshot.sessions);
  if (baseline.size !== sessions.length) return false;
  return sessions.every((session) => isEqual(baseline.get(session.id), normalizeSession(session)));
}

function reportSnapshot(
  options: ChatStorageReadOptions,
  sessions: readonly ChatSession[],
  restoreMarker: string | null | undefined,
): void {
  options.onSnapshot?.({
    sessions: structuredClone([...sessions]),
    restoreMarker,
  });
}

function withPartitionLocks<T>(
  crossRealmKey: string,
  key: string,
  requiresCrossRealmLock: boolean,
  work: (isolatedWrites: boolean) => Promise<T>,
): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    const locks = navigator.locks;
    return locks.request<Promise<T>>(
      chatStoragePartitionLockName(crossRealmKey),
      () =>
        locks.request<Promise<T>>(chatStoragePartitionLockName(key), () =>
          work(false),
        ) as unknown as Promise<T>,
    ) as unknown as Promise<T>;
  }
  if (requiresCrossRealmLock) {
    throw new ChatStorageLockUnavailableError(
      'Chat storage requires the Web Locks API in this browser',
    );
  }
  return work(true);
}

function enqueue<T>(
  store: RuntimeStore,
  key: string,
  crossRealmKey: string,
  requiresCrossRealmLock: boolean,
  work: (isolatedWrites: boolean) => Promise<T>,
  globalLockHeld = false,
): Promise<T> {
  const enqueueInGlobalEpoch = (): Promise<T> => {
    let queues = storeQueues.get(store);
    if (!queues) {
      queues = new Map();
      storeQueues.set(store, queues);
    }
    const previous = queues.get(key) ?? Promise.resolve();
    const run = () => withPartitionLocks(crossRealmKey, key, requiresCrossRealmLock, work);
    const current = previous.catch(() => undefined).then(run);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, settled);
    void settled.finally(() => {
      if (queues?.get(key) === settled) queues.delete(key);
    });
    return current;
  };

  // Register in the local partition queue only after this operation's global
  // shared lock is granted. Otherwise a caller already holding a shared lock
  // can wait for a later operation queued behind maintenance, creating a
  // shared -> later shared -> exclusive -> shared inversion.
  return globalLockHeld ? enqueueInGlobalEpoch() : withChatStorageSharedLock(enqueueInGlobalEpoch);
}

async function context(options: ChatStorageOptions): Promise<{
  store: RuntimeStore;
  learnerKey: string;
  legacyStore: LegacyChatStore;
  requiresCrossRealmLock: boolean;
  sleep: ChatSyncSleep;
}> {
  const legacyStore = options.legacyStore ?? dexieLegacyStore;
  return {
    store: options.store ?? getRuntimeStore(),
    learnerKey: options.learnerKey ?? (await getLearnerKey(options.kv)),
    legacyStore,
    sleep: options.sleep ?? defaultChatSyncSleep,
    requiresCrossRealmLock: legacyStore === dexieLegacyStore,
  };
}

function restoreMarkerPrefix(stageId: string): string {
  return `${RESTORE_MARKER_PREFIX}${encodeURIComponent(stageId)}:`;
}

function deletionMarkerPrefix(stageId: string): string {
  return `${DELETION_MARKER_PREFIX}${encodeURIComponent(stageId)}:`;
}

function deletionMarkerId(stageId: string, learnerKey: string, chatSessionId: string): string {
  return `${deletionMarkerPrefix(stageId)}${encodeURIComponent(chatSessionId)}:${encodeURIComponent(learnerKey)}`;
}

function deletionMarkerChatId(view: ChatRuntimeView, stageId: string): string | undefined {
  if (view.runtimeSession.kind !== CHAT_DELETION_KIND) return undefined;
  const prefix = deletionMarkerPrefix(stageId);
  if (!view.runtimeSession.id.startsWith(prefix)) return undefined;
  const encodedChatId = view.runtimeSession.id.slice(prefix.length).split(':', 1)[0];
  if (!encodedChatId) return undefined;
  try {
    return decodeURIComponent(encodedChatId);
  } catch {
    return undefined;
  }
}

function deletionMarkersByChatId(
  views: readonly ChatRuntimeView[],
  stageId: string,
): Map<string, ChatRuntimeView[]> {
  const markers = new Map<string, ChatRuntimeView[]>();
  for (const view of views) {
    const chatSessionId = deletionMarkerChatId(view, stageId);
    if (!chatSessionId) continue;
    const current = markers.get(chatSessionId) ?? [];
    current.push(view);
    markers.set(chatSessionId, current);
  }
  return markers;
}

function currentRestoreMarker(
  views: readonly ChatRuntimeView[],
  stageId: string,
): string | undefined {
  // RuntimeStore already scopes `views` to one learner. Keep marker discovery
  // stage-scoped so a marker remains recognizable after mergeLearner re-keys
  // the session without rewriting its immutable id.
  const prefix = restoreMarkerPrefix(stageId);
  return views
    .filter(
      (view) =>
        view.runtimeSession.status === 'completed' && view.runtimeSession.id.startsWith(prefix),
    )
    .sort(
      (left, right) =>
        Date.parse(left.runtimeSession.createdAt) - Date.parse(right.runtimeSession.createdAt) ||
        left.runtimeSession.id.localeCompare(right.runtimeSession.id),
    )
    .at(-1)?.runtimeSession.id;
}

function restoreMarkerTargets(view: ChatRuntimeView | undefined): string[] {
  if (!view) return [];
  for (const record of view.records) {
    const payload = record.payload as { kind?: string; runtimeSessionIds?: unknown };
    if (payload.kind !== 'chat_restore_marker' || !Array.isArray(payload.runtimeSessionIds)) {
      continue;
    }
    return payload.runtimeSessionIds.filter(
      (runtimeSessionId): runtimeSessionId is string => typeof runtimeSessionId === 'string',
    );
  }
  return [];
}

async function createRestoreMarker(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
  runtimeSessionIds: readonly string[],
  afterCreatedAt?: string,
): Promise<RuntimeSession> {
  const now = new Date(
    Math.max(Date.now(), afterCreatedAt ? Date.parse(afterCreatedAt) + 1 : 0),
  ).toISOString();
  const marker = await store.createSession({
    id: `${restoreMarkerPrefix(stageId)}${encodeURIComponent(learnerKey)}:${nanoid()}`,
    kind: 'chat',
    stageId,
    learnerKey,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  try {
    await store.appendRecord({
      id: `${marker.id}:targets`,
      sessionId: marker.id,
      createdAt: now,
      payload: {
        role: 'system',
        content: '',
        kind: 'chat_restore_marker',
        runtimeSessionIds: [...runtimeSessionIds],
      },
    });
    await store.setSessionStatus(marker.id, 'completed', now);
    return { ...marker, status: 'completed' };
  } catch (error) {
    await store.deleteSession(marker.id).catch(() => {});
    throw error;
  }
}

async function finalizeRestoreMarker(store: RuntimeStore, marker: RuntimeSession): Promise<void> {
  const finalized = await createRestoreMarker(
    store,
    marker.stageId,
    marker.learnerKey,
    [],
    marker.createdAt,
  );
  try {
    await store.deleteSession(marker.id);
  } catch (error) {
    // The newer empty marker sorts after the target-bearing marker, so cleanup
    // is already logically complete even if retiring the older marker fails.
    const persisted = await store.getSession(finalized.id).catch(() => undefined);
    if (!persisted) throw error;
  }
}

function matchesChatPartition(
  session: RuntimeSession,
  id: string,
  stageId: string,
  learnerKey: string,
): boolean {
  return (
    session.id === id &&
    session.kind === 'chat' &&
    session.stageId === stageId &&
    session.learnerKey === learnerKey
  );
}

async function createOrGetRuntimeSession(
  store: RuntimeStore,
  init: Parameters<RuntimeStore['createSession']>[0],
): Promise<RuntimeSession> {
  try {
    return await store.createSession(init);
  } catch (error) {
    let raced: RuntimeSession | undefined;
    try {
      raced = await store.getSession(init.id);
    } catch {
      throw error;
    }
    if (!raced || !matchesChatPartition(raced, init.id, init.stageId, init.learnerKey)) {
      throw error;
    }
    return raced;
  }
}

async function ensureDeletionMarker(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
  chatSessionId: string,
  existingMarkers: readonly ChatRuntimeView[],
): Promise<void> {
  if (existingMarkers.some((view) => deletionMarkerChatId(view, stageId) === chatSessionId)) {
    return;
  }
  const id = deletionMarkerId(stageId, learnerKey, chatSessionId);
  const now = new Date().toISOString();
  try {
    await store.createSession({
      id,
      kind: CHAT_DELETION_KIND,
      stageId,
      learnerKey,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    const raced = await store.getSession(id).catch(() => undefined);
    if (
      !raced ||
      raced.kind !== CHAT_DELETION_KIND ||
      raced.stageId !== stageId ||
      raced.learnerKey !== learnerKey
    ) {
      throw error;
    }
  }
}

async function runtimeViews(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
): Promise<ChatRuntimeView[]> {
  const sessions = (await store.listSessions(stageId, learnerKey)).filter(
    (session) => session.kind === 'chat' || session.kind === CHAT_DELETION_KIND,
  );
  return Promise.all(
    sessions.map(async (runtimeSession) => {
      const records = await store.listRecords(runtimeSession.id);
      return { runtimeSession, records, folded: foldRecords(records) };
    }),
  );
}

async function appendPayload(
  store: RuntimeStore,
  runtimeId: string,
  payload: ChatMessagePayload | ChatSessionStatePayload,
  session: ChatSession,
  suffix: string,
): Promise<void> {
  await store.appendRecord(buildChatRecordInit(runtimeId, payload, session, suffix));
}

function isInactiveSessionAppendError(error: HttpRuntimeStoreError): boolean {
  if (error.code !== 'VALIDATION_FAILED') {
    return false;
  }
  return (
    (error.message.includes('cannot append to session ') &&
      error.message.includes('records may only be appended to an active session')) ||
    (error.message.includes(' is no longer active; ') &&
      error.message.includes('its current status is'))
  );
}

function isDeterministicChatSyncFailure(error: unknown): error is HttpRuntimeStoreError {
  return (
    error instanceof HttpRuntimeStoreError &&
    !isInactiveSessionAppendError(error) &&
    (error.status === 400 ||
      error.status === 401 ||
      error.status === 403 ||
      error.status === 413 ||
      error.code === 'VALIDATION_FAILED' ||
      (error.status === 409 && error.code === 'FUTURE_VERSION'))
  );
}

function normalizeLegacyConversion(records: unknown): LegacyChatConversion {
  return fromLegacyRecords(records);
}

function legacyRowLabels(rows: readonly SkippedLegacyChatRow[]): string {
  return rows
    .map((row) => (row.id === undefined ? `index ${row.index}` : JSON.stringify(row.id)))
    .join(', ');
}

function warnSkippedLegacyRows(stageId: string, rows: readonly SkippedLegacyChatRow[]): void {
  if (rows.length === 0) return;
  console.warn(
    `Skipped malformed legacy chat rows for stage ${JSON.stringify(stageId)}; retaining the legacy source: ${legacyRowLabels(rows)}`,
  );
}

function chatSyncValidationError(sessionId: string, error: HttpRuntimeStoreError): Error {
  return new Error(
    `Chat sync rejected for session ${JSON.stringify(sessionId)}: ${error.code} (HTTP ${error.status}): ${error.message}`,
    { cause: error },
  );
}

async function completeRuntimeCandidate(
  store: RuntimeStore,
  candidate: ChatRuntimeCandidate,
  session: ChatSession,
): Promise<boolean> {
  const runtimeId = candidate.runtimeSession.id;
  const runtimeSession = await store.getSession(runtimeId);
  if (!runtimeSession) return false;
  if (runtimeSession.status !== 'completed') {
    try {
      await store.setSessionStatus(runtimeId, 'completed', iso(session.updatedAt));
    } catch (error) {
      let latest: RuntimeSession | undefined;
      try {
        latest = await store.getSession(runtimeId);
      } catch {
        throw error;
      }
      if (latest) throw error;
      return false;
    }
  }
  return true;
}

async function retireRuntimeCandidates(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
  candidateIds: string[],
  successor: ChatSession,
  successorRuntimeId: string,
): Promise<void> {
  const ids = new Set(candidateIds);
  if (ids.size === 0) return;
  const successorIdentity = chatRuntimeIdentity(successorRuntimeId, stageId, successor.id);
  if (!successorIdentity) {
    throw new Error(`Invalid chat runtime successor ${JSON.stringify(successorRuntimeId)}`);
  }
  const currentViews = await runtimeViews(store, stageId, learnerKey);
  await Promise.all(
    currentViews.flatMap((view) => {
      if (!ids.has(view.runtimeSession.id) || view.runtimeSession.status !== 'completed') return [];
      const state = view.folded.state;
      const identity = chatRuntimeIdentity(view.runtimeSession.id, stageId, successor.id);
      if (
        state &&
        (state.updatedAt > successor.updatedAt ||
          (state.updatedAt === successor.updatedAt &&
            (!identity ||
              identity.generation > successorIdentity.generation ||
              (identity.generation === successorIdentity.generation &&
                view.runtimeSession.id.localeCompare(successorRuntimeId) > 0))))
      ) {
        return [];
      }
      return [store.deleteSession(view.runtimeSession.id)];
    }),
  );
}

async function syncOne(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
  session: ChatSession,
  existingViews: ChatRuntimeView[],
  isolatedWrites: boolean,
  observed: ChatSession | undefined,
  sleep: ChatSyncSleep,
): Promise<string> {
  let desired = normalizeSession(session);
  let views = existingViews;
  let retryError: unknown;
  let backoffBeforeAttempt = false;
  let refreshBeforeAttempt = false;

  retryLoop: for (let attempt = 0; attempt < MAX_CHAT_SYNC_ATTEMPTS; attempt += 1) {
    if (backoffBeforeAttempt) {
      await sleep(Math.min(100 * 2 ** Math.max(0, attempt - 1), MAX_CHAT_RETRY_DELAY_MS));
      backoffBeforeAttempt = false;
    }
    if (refreshBeforeAttempt) {
      views = await runtimeViews(store, stageId, learnerKey);
      refreshBeforeAttempt = false;
    }
    let reconcileSource = true;
    for (let planStep = 0; planStep < MAX_CHAT_PLAN_STEPS_PER_ATTEMPT; planStep += 1) {
      const candidates = chatRuntimeCandidates(views, stageId, desired.id);
      const source = newestRuntimeCandidate(candidates);
      if (
        reconcileSource &&
        source?.folded.session &&
        source.folded.session.updatedAt > desired.updatedAt
      ) {
        const localEditAdvanced =
          observed !== undefined &&
          desired.updatedAt > observed.updatedAt &&
          !isEqual(desired, observed);
        desired = localEditAdvanced
          ? { ...desired, updatedAt: source.folded.session.updatedAt + 1 }
          : source.folded.session;
      }

      const plan = planChatSync({ session: desired, stageId, learnerKey, isolatedWrites }, views);

      if (plan.kind === 'create-session') {
        const runtimeSession = await createOrGetRuntimeSession(store, plan.init);
        const records = await store.listRecords(runtimeSession.id);
        views = [
          ...views.filter((view) => view.runtimeSession.id !== runtimeSession.id),
          { runtimeSession, records, folded: foldRecords(records) },
        ];
        // The original single-pass branch did not re-resolve a raced session's
        // logical source after createOrGet; preserve that conflict behavior.
        reconcileSource = false;
        continue;
      }

      if (plan.kind === 'reuse-isolated') {
        const destinationId = plan.destination.runtimeSession.id;
        if (
          plan.completeDestination &&
          !(await completeRuntimeCandidate(store, plan.destination, desired))
        ) {
          views = await runtimeViews(store, stageId, learnerKey);
          continue retryLoop;
        }
        const completed = await Promise.all(
          plan.retired.map((candidate) => completeRuntimeCandidate(store, candidate, desired)),
        );
        if (completed.some((candidate) => !candidate)) {
          views = await runtimeViews(store, stageId, learnerKey);
          continue retryLoop;
        }
        await retireRuntimeCandidates(
          store,
          stageId,
          learnerKey,
          plan.retired.map((candidate) => candidate.runtimeSession.id),
          desired,
          destinationId,
        );
        return destinationId;
      }

      if (plan.kind === 'replace-isolated') {
        // A unique generation is safe across realms without a shared mutex:
        // every writer stores at most the normalized 200 messages plus state.
        const runtimeId = generationRuntimeSessionId(plan.baseRuntimeId, plan.generation, nanoid());
        try {
          await Promise.all(
            plan.candidates.map((candidate) => completeRuntimeCandidate(store, candidate, desired)),
          );
          let runtimeSession = await createOrGetRuntimeSession(store, {
            id: runtimeId,
            kind: 'chat',
            stageId,
            learnerKey,
            status: 'active',
            createdAt: iso(desired.createdAt),
            updatedAt: iso(desired.updatedAt),
          });
          for (const append of plan.appends) {
            await appendPayload(store, runtimeId, append.payload, desired, append.suffix);
          }
          if (plan.finalStatus) {
            await store.setSessionStatus(runtimeId, plan.finalStatus, iso(desired.updatedAt));
            runtimeSession = { ...runtimeSession, status: plan.finalStatus };
          }
          await retireRuntimeCandidates(
            store,
            stageId,
            learnerKey,
            plan.candidates.map((candidate) => candidate.runtimeSession.id),
            desired,
            runtimeId,
          );
          return runtimeSession.id;
        } catch (error) {
          retryError = error;
          try {
            await store.deleteSession(runtimeId);
            views = await runtimeViews(store, stageId, learnerKey);
          } catch {
            throw error;
          }
          if (isDeterministicChatSyncFailure(error)) {
            throw chatSyncValidationError(desired.id, error);
          }
          backoffBeforeAttempt = true;
          continue retryLoop;
        }
      }

      if (plan.kind === 'complete-and-refresh') {
        await completeRuntimeCandidate(store, plan.destination, desired);
        views = await runtimeViews(store, stageId, learnerKey);
        continue retryLoop;
      }

      if (plan.kind === 'start-generation') {
        await createOrGetRuntimeSession(store, plan.init);
        views = await runtimeViews(store, stageId, learnerKey);
        continue retryLoop;
      }

      const destination = plan.destination;
      const runtimeId = destination.runtimeSession.id;
      try {
        if (plan.preStatus) {
          await store.setSessionStatus(runtimeId, plan.preStatus, iso(desired.updatedAt));
        }
        for (const append of plan.appends) {
          await appendPayload(store, runtimeId, append.payload, desired, append.suffix);
        }
        if (plan.finalStatus) {
          await store.setSessionStatus(runtimeId, plan.finalStatus, iso(desired.updatedAt));
        }
        return runtimeId;
      } catch (error) {
        retryError = error;
        const deterministic = isDeterministicChatSyncFailure(error);
        let latest: RuntimeSession | undefined;
        try {
          latest = await store.getSession(runtimeId);
        } catch {
          throw error;
        }
        if (latest && !matchesChatPartition(latest, runtimeId, stageId, learnerKey)) {
          throw error;
        }
        if (latest?.status === 'active') {
          // A generation without a committed state is not externally visible.
          // Remove its partial records before retrying instead of exposing them
          // through a later state append or retaining an orphaned session.
          if (!destination.folded.state) {
            let latestFolded: FoldedChat;
            try {
              latestFolded = foldRecords(await store.listRecords(runtimeId));
            } catch {
              throw error;
            }
            if (latestFolded.state) {
              if (deterministic) throw chatSyncValidationError(desired.id, error);
              views = await runtimeViews(store, stageId, learnerKey);
              backoffBeforeAttempt = true;
              continue retryLoop;
            }
            try {
              await store.deleteSession(runtimeId);
            } catch {
              throw error;
            }
            if (deterministic) throw chatSyncValidationError(desired.id, error);
            views = await runtimeViews(store, stageId, learnerKey);
            backoffBeforeAttempt = true;
            continue retryLoop;
          }
          if (deterministic) throw chatSyncValidationError(desired.id, error);
          views = await runtimeViews(store, stageId, learnerKey);
          backoffBeforeAttempt = true;
          continue retryLoop;
        }
        if (deterministic) throw chatSyncValidationError(desired.id, error);
        views = await runtimeViews(store, stageId, learnerKey);
        backoffBeforeAttempt = true;
        continue retryLoop;
      }
    }
    retryError ??= new Error(
      `Exceeded chat sync plan-step limit for ${JSON.stringify(desired.id)}`,
    );
    backoffBeforeAttempt = true;
    refreshBeforeAttempt = true;
  }
  if (!isolatedWrites) {
    // A failed locked write may exhaust its retries immediately after
    // creating the next generation. Such state-less generations are never a
    // committed snapshot and no other partition writer can be active here.
    try {
      const unresolved = (await runtimeViews(store, stageId, learnerKey)).filter(
        (view) =>
          chatRuntimeIdentity(view.runtimeSession.id, stageId, desired.id) !== undefined &&
          !view.folded.state,
      );
      await Promise.all(unresolved.map((view) => store.deleteSession(view.runtimeSession.id)));
    } catch {
      // Preserve the append failure that made the save fail; cleanup remains
      // best-effort if the RuntimeStore itself is unavailable.
    }
  }
  throw (
    retryError ?? new Error(`Failed to resolve chat generation for ${JSON.stringify(desired.id)}`)
  );
}

async function syncSessions(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
  sessions: ChatSession[],
  deleteOmitted: boolean,
  isolatedWrites: boolean,
  knownSessionIds: ReadonlySet<string> = new Set(),
  observed: ReadonlyMap<string, ChatSession> = new Map(),
  existingViews?: ChatRuntimeView[],
  sleep: ChatSyncSleep = defaultChatSyncSleep,
): Promise<ChatSession[]> {
  const existing = existingViews ?? (await runtimeViews(store, stageId, learnerKey));
  const desiredRuntimeIds = new Map<string, string>();

  for (const session of sessions) {
    desiredRuntimeIds.set(
      session.id,
      await syncOne(
        store,
        stageId,
        learnerKey,
        session,
        existing,
        isolatedWrites,
        observed.get(session.id),
        sleep,
      ),
    );
  }
  if (deleteOmitted) {
    const omittedKnownIds = new Set(
      existing.flatMap((view) => {
        const chatSessionId = view.folded.session?.id;
        return chatSessionId &&
          knownSessionIds.has(chatSessionId) &&
          !desiredRuntimeIds.has(chatSessionId)
          ? [chatSessionId]
          : [];
      }),
    );
    await Promise.all(
      [...omittedKnownIds].map((chatSessionId) =>
        ensureDeletionMarker(store, stageId, learnerKey, chatSessionId, existing),
      ),
    );
    const afterSync = await runtimeViews(store, stageId, learnerKey);
    const afterSyncById = new Map(afterSync.map((view) => [view.runtimeSession.id, view]));
    await Promise.all(
      existing.flatMap((view) => {
        const chatSessionId = view.folded.session?.id;
        const desiredRuntimeId = chatSessionId ? desiredRuntimeIds.get(chatSessionId) : undefined;
        const current = afterSyncById.get(view.runtimeSession.id);
        // A full snapshot may have been captured in another tab before this
        // runtime session existed. Only treat omission as deletion for chat
        // IDs this RuntimeStore instance has actually observed; otherwise a
        // stale snapshot could erase a newer tab's session. State-less views
        // may still be in flight, so leave them to their writer's retry path.
        if (!chatSessionId) return [];
        if (!desiredRuntimeId) {
          return knownSessionIds.has(chatSessionId)
            ? [store.deleteSession(view.runtimeSession.id)]
            : [];
        }
        if (
          desiredRuntimeId === view.runtimeSession.id ||
          !current ||
          current.runtimeSession.status !== 'completed'
        ) {
          return [];
        }
        const successor = afterSyncById.get(desiredRuntimeId);
        const currentIdentity = chatRuntimeIdentity(
          current.runtimeSession.id,
          stageId,
          chatSessionId,
        );
        const successorIdentity = successor
          ? chatRuntimeIdentity(successor.runtimeSession.id, stageId, chatSessionId)
          : undefined;
        if (
          current.folded.state &&
          (!successor?.folded.state ||
            successor.folded.state.updatedAt < current.folded.state.updatedAt ||
            (successor.folded.state.updatedAt === current.folded.state.updatedAt &&
              (!currentIdentity ||
                !successorIdentity ||
                currentIdentity.generation > successorIdentity.generation ||
                (currentIdentity.generation === successorIdentity.generation &&
                  current.runtimeSession.id.localeCompare(successor.runtimeSession.id) > 0))))
        ) {
          return [];
        }
        return [store.deleteSession(view.runtimeSession.id)];
      }),
    );
  }
  return loadRuntimeSessions(store, stageId, learnerKey);
}

async function loadRuntimeSessions(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
): Promise<ChatSession[]> {
  const views = await runtimeViews(store, stageId, learnerKey);
  const deletedChatSessionIds = new Set(deletionMarkersByChatId(views, stageId).keys());
  const restoreMarker = currentRestoreMarker(views, stageId);
  const supersededRuntimeSessionIds = new Set(
    restoreMarkerTargets(views.find((view) => view.runtimeSession.id === restoreMarker)),
  );
  const newestByChatSession = new Map<string, ChatRuntimeView>();
  for (const view of views) {
    if (supersededRuntimeSessionIds.has(view.runtimeSession.id)) continue;
    const chatSession = view.folded.session;
    if (!chatSession) continue;
    // The marker is committed before destructive cleanup. It remains the
    // authoritative deletion intent if removing an old generation fails.
    if (deletedChatSessionIds.has(chatSession.id)) continue;
    const identity = chatRuntimeIdentity(view.runtimeSession.id, stageId, chatSession.id);
    if (!identity) continue;
    const current = newestByChatSession.get(chatSession.id);
    const currentGeneration = current
      ? chatRuntimeIdentity(current.runtimeSession.id, stageId, chatSession.id)!.generation
      : -1;
    if (
      !current ||
      chatSession.updatedAt > current.folded.session!.updatedAt ||
      (chatSession.updatedAt === current.folded.session!.updatedAt &&
        (identity.generation > currentGeneration ||
          (identity.generation === currentGeneration &&
            view.runtimeSession.id.localeCompare(current.runtimeSession.id) > 0)))
    ) {
      newestByChatSession.set(chatSession.id, view);
    }
  }
  return [...newestByChatSession.values()]
    .map((view) => view.folded.session!)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

/** Persist the complete chat-session set for a stage. */
export async function saveChatSessions(
  stageId: string,
  sessions: ChatSession[],
  options: ChatStorageOptions = {},
): Promise<void> {
  const resolved = await context(options);
  const queueKey = `${stageId}\0${resolved.learnerKey}`;
  const nextSessions = sessions ?? [];
  try {
    await enqueue(
      resolved.store,
      queueKey,
      stageId,
      resolved.requiresCrossRealmLock,
      async (isolatedWrites) => {
        let beforeSave = await runtimeViews(resolved.store, stageId, resolved.learnerKey);
        const restoreMarker = currentRestoreMarker(beforeSave, stageId) ?? null;
        const callerSnapshot = options.snapshot;
        if (
          callerSnapshot &&
          callerSnapshot.restoreMarker !== undefined &&
          callerSnapshot.restoreMarker !== restoreMarker
        ) {
          // Restore invalidates snapshots captured by already-mounted callers.
          // Unchanged stage autosaves are harmless no-ops; real chat mutations
          // fail loud until the caller reloads instead of overwriting backup data.
          if (matchesSnapshot(callerSnapshot, nextSessions)) return;
          throw new ChatStorageSnapshotInvalidatedByRestoreError(
            `Chat snapshot for stage ${JSON.stringify(stageId)} was invalidated by backup restore`,
          );
        }
        if (!callerSnapshot && restoreMarker !== null) {
          throw new ChatStorageSnapshotInvalidatedByRestoreError(
            `Chat snapshot for stage ${JSON.stringify(stageId)} must be reloaded after backup restore`,
          );
        }
        if (
          callerSnapshot?.restoreMarker === undefined &&
          callerSnapshot !== undefined &&
          matchesSnapshot(callerSnapshot, nextSessions)
        ) {
          return;
        }
        let effectiveNextSessions = nextSessions;
        if (
          callerSnapshot !== undefined &&
          callerSnapshot.restoreMarker === undefined &&
          !matchesSnapshot(callerSnapshot, nextSessions)
        ) {
          // The caller loaded no authoritative runtime snapshot. Once storage
          // recovers, preserve any still-staged legacy rows while merging the
          // caller's new chats. The per-partition clear guard below separately
          // protects a legacy source whose last load skipped malformed rows.
          const recoveredConversion = normalizeLegacyConversion(
            await resolved.legacyStore.load(stageId),
          );
          rememberSkippedLegacyRows(resolved.store, queueKey, recoveredConversion.skippedRows);
          const recoveredLegacy = recoveredConversion.sessions;
          if (recoveredLegacy.length > 0) {
            const recoveredById = new Map(recoveredLegacy.map((session) => [session.id, session]));
            for (const session of nextSessions) recoveredById.set(session.id, session);
            effectiveNextSessions = [...recoveredById.values()];
          }
        }
        if (callerSnapshot?.restoreMarker === undefined && restoreMarker !== null) {
          const markerView = beforeSave.find((view) => view.runtimeSession.id === restoreMarker);
          const targets = restoreMarkerTargets(markerView);
          await Promise.all(
            targets.map((runtimeSessionId) => resolved.store.deleteSession(runtimeSessionId)),
          );
          if (markerView && targets.length > 0) {
            await finalizeRestoreMarker(resolved.store, markerView.runtimeSession);
          }
          beforeSave = await runtimeViews(resolved.store, stageId, resolved.learnerKey);
        }
        const deletionMarkers = deletionMarkersByChatId(beforeSave, stageId);
        const callerBaseline = callerSnapshot ? sessionMap(callerSnapshot.sessions) : undefined;
        const ignoredStaleSessionIds = new Set<string>();
        const supersededMarkerViews: ChatRuntimeView[] = [];
        for (const session of nextSessions) {
          const markers = deletionMarkers.get(session.id);
          if (!markers?.length) continue;
          const baseline = callerBaseline?.get(session.id);
          if (baseline) {
            if (isEqual(baseline, normalizeSession(session))) {
              ignoredStaleSessionIds.add(session.id);
              continue;
            }
            throw new ChatStorageSnapshotInvalidatedByDeletionError(
              `Chat ${JSON.stringify(session.id)} was deleted by another caller`,
            );
          }
          if (!callerSnapshot) {
            throw new ChatStorageSnapshotInvalidatedByDeletionError(
              `Chat ${JSON.stringify(session.id)} must be reloaded after deletion`,
            );
          }
          // The caller did not observe the deleted chat, so this is a new
          // creation that deliberately reuses the id. Retire the tombstone.
          supersededMarkerViews.push(...markers);
        }
        if (ignoredStaleSessionIds.size > 0) {
          effectiveNextSessions = effectiveNextSessions.filter(
            (session) => !ignoredStaleSessionIds.has(session.id),
          );
        }
        const knownSessionIds = callerSnapshot
          ? new Set(callerSnapshot.sessions.map((session) => session.id))
          : observedIds(resolved.store, queueKey);
        const priorObservedSessions = callerSnapshot
          ? sessionMap(callerSnapshot.sessions)
          : observedSessions(resolved.store, queueKey);
        await syncSessions(
          resolved.store,
          stageId,
          resolved.learnerKey,
          effectiveNextSessions,
          true,
          isolatedWrites,
          knownSessionIds,
          priorObservedSessions,
          beforeSave,
          resolved.sleep,
        );
        // Keep the tombstone authoritative until the deliberately reused chat
        // id has been durably synced. If marker cleanup fails, this save fails
        // and readers continue to hide both stale and partially replaced data.
        await Promise.all(
          supersededMarkerViews.map((view) => resolved.store.deleteSession(view.runtimeSession.id)),
        );
        rememberObservedIds(
          resolved.store,
          queueKey,
          nextSessions.map((session) => session.id),
        );
        // saveChatSessions does not return a reconciled snapshot to its caller.
        // Keep conflict observations aligned with the state the caller really
        // saw, even when this save silently preserved a newer cross-tab value.
        rememberObservedSessions(resolved.store, queueKey, nextSessions);
        const unsafeToClear = skippedLegacyRows(resolved.store, queueKey);
        if (unsafeToClear) {
          warnSkippedLegacyRows(stageId, unsafeToClear);
        } else {
          await resolved.legacyStore.clear(stageId);
        }
      },
      options.globalLockHeld,
    );
  } catch (error) {
    // A stage autosave echoes the caller-visible chat snapshot even when the
    // user only changed document data. Without Web Locks, an unchanged echo is
    // a safe no-op; any chat creation, edit, or deletion must still fail loud.
    if (
      error instanceof ChatStorageLockUnavailableError &&
      (options.snapshot
        ? matchesSnapshot(options.snapshot, nextSessions)
        : matchesObservedSessions(resolved.store, queueKey, nextSessions))
    ) {
      return;
    }
    throw error;
  }
}

/** Load chat sessions, migrating legacy Dexie rows on first access. */
export async function loadChatSessions(
  stageId: string,
  options: ChatStorageReadOptions = {},
): Promise<ChatSession[]> {
  const resolved = await context(options);
  const queueKey = `${stageId}\0${resolved.learnerKey}`;
  let legacy: ChatSession[] = [];
  let runtimeReadSucceeded = false;
  let readRestoreMarker: string | null | undefined;
  try {
    return await enqueue(
      resolved.store,
      queueKey,
      stageId,
      resolved.requiresCrossRealmLock,
      async (isolatedWrites) => {
        // Read legacy rows only after entering the same partition queue/lock as
        // saves. Otherwise a delayed migration can replay a snapshot captured
        // before a concurrent save cleared it and resurrect deleted chats.
        const rawLegacy = await resolved.legacyStore.load(stageId);
        const conversion = normalizeLegacyConversion(rawLegacy);
        legacy = conversion.sessions;
        if (options.observe !== false) {
          rememberSkippedLegacyRows(resolved.store, queueKey, conversion.skippedRows);
        }
        // Rows the stricter serializer refuses stay in the legacy source (clear
        // is blocked on both load and save paths by the per-partition guard)
        // and are excluded from the snapshot until the shape is supported.
        warnSkippedLegacyRows(stageId, conversion.skippedRows);
        let beforeLoad = await runtimeViews(resolved.store, stageId, resolved.learnerKey);
        let restoreMarker = currentRestoreMarker(beforeLoad, stageId) ?? null;
        readRestoreMarker = restoreMarker;
        if (restoreMarker !== null) {
          const markerView = beforeLoad.find((view) => view.runtimeSession.id === restoreMarker);
          const targets = restoreMarkerTargets(markerView);
          if (markerView && targets.length > 0) {
            await Promise.all(
              targets.map((runtimeSessionId) => resolved.store.deleteSession(runtimeSessionId)),
            );
            await finalizeRestoreMarker(resolved.store, markerView.runtimeSession);
            beforeLoad = await runtimeViews(resolved.store, stageId, resolved.learnerKey);
            restoreMarker = currentRestoreMarker(beforeLoad, stageId) ?? null;
            readRestoreMarker = restoreMarker;
          }
        }
        if (legacy.length === 0) {
          const loaded = await loadRuntimeSessions(resolved.store, stageId, resolved.learnerKey);
          runtimeReadSucceeded = true;
          if (options.observe !== false) {
            rememberObservedIds(
              resolved.store,
              queueKey,
              loaded.map((session) => session.id),
            );
            rememberObservedSessions(resolved.store, queueKey, loaded);
          }
          reportSnapshot(options, loaded, restoreMarker);
          return loaded;
        }
        const migrated = await syncSessions(
          resolved.store,
          stageId,
          resolved.learnerKey,
          legacy,
          false,
          isolatedWrites,
          undefined,
          undefined,
          beforeLoad,
          resolved.sleep,
        );
        runtimeReadSucceeded = true;
        if (options.observe !== false) {
          rememberObservedIds(
            resolved.store,
            queueKey,
            migrated.map((session) => session.id),
          );
          rememberObservedSessions(resolved.store, queueKey, migrated);
        }
        if (conversion.skippedRows.length === 0) await resolved.legacyStore.clear(stageId);
        reportSnapshot(options, migrated, restoreMarker);
        return migrated;
      },
    );
  } catch (error) {
    if (error instanceof ChatStorageLockUnavailableError) {
      // No-lock environments cannot safely migrate or clear the shared legacy
      // table, but a read-only legacy snapshot keeps pre-cutover history
      // visible. Strict callers such as backup export still fail loud.
      if (options.fallbackToLegacyOnError === false) throw error;
      const conversion = normalizeLegacyConversion(await resolved.legacyStore.load(stageId));
      const readOnlyLegacy = conversion.sessions;
      rememberSkippedLegacyRows(resolved.store, queueKey, conversion.skippedRows);
      warnSkippedLegacyRows(stageId, conversion.skippedRows);
      if (readOnlyLegacy.length === 0) throw error;
      if (options.observe !== false) {
        rememberObservedIds(
          resolved.store,
          queueKey,
          readOnlyLegacy.map((session) => session.id),
        );
        rememberObservedSessions(resolved.store, queueKey, readOnlyLegacy);
      }
      reportSnapshot(options, readOnlyLegacy, undefined);
      console.warn(`Loaded legacy chat sessions without migration for stage ${stageId}:`, error);
      return readOnlyLegacy;
    }
    // A failed runtime read is not an authoritative empty snapshot. Forget the
    // prior observation so a later stage save cannot retire unseen data. A
    // legacy-clear failure happens after migration succeeded, so retain it.
    if (options.observe !== false && !runtimeReadSucceeded) {
      rememberObservedIds(resolved.store, queueKey, []);
      rememberObservedSessions(resolved.store, queueKey, []);
    } else if (options.observe !== false) {
      // The fallback returns only the legacy rows. Runtime-only sessions that
      // were discovered during sync were not exposed to the caller, so their
      // omission from the next UI snapshot must not be treated as deletion.
      rememberObservedIds(
        resolved.store,
        queueKey,
        legacy.map((session) => session.id),
      );
      rememberObservedSessions(resolved.store, queueKey, legacy);
    }
    if (options.fallbackToLegacyOnError === false) throw error;
    if (legacy.length === 0) throw error;
    reportSnapshot(options, legacy, runtimeReadSucceeded ? readRestoreMarker : undefined);
    console.warn(`Failed to migrate chat sessions for stage ${stageId}:`, error);
    return legacy;
  }
}

/** Remove this learner's runtime chat partition before restoring a backup. */
export async function clearRuntimeChatSessions(
  stageId: string,
  options: ChatStorageOptions = {},
): Promise<void> {
  const resolved = await context(options);
  const queueKey = `${stageId}\0${resolved.learnerKey}`;
  await enqueue(resolved.store, queueKey, stageId, resolved.requiresCrossRealmLock, async () => {
    await clearRuntimeChatSessionsUnlocked(resolved.store, stageId, resolved.learnerKey, queueKey);
  });
}

async function clearRuntimeChatSessionsUnlocked(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
  queueKey: string,
): Promise<void> {
  const views = await runtimeViews(store, stageId, learnerKey);
  await Promise.all(views.map((view) => store.deleteSession(view.runtimeSession.id)));
  rememberObservedIds(store, queueKey, []);
  rememberObservedSessions(store, queueKey, []);
}

/** Stage legacy backup rows and clear their runtime partitions under the same locks. */
export async function restoreChatSessionsFromBackup(
  stageIds: string[],
  restoreLegacyRows: () => Promise<void>,
  options: ChatStorageRestoreOptions = {},
): Promise<void> {
  const resolved = await context(options);
  const orderedStageIds = [...new Set(stageIds)].sort();
  const queueKeys = orderedStageIds.map((stageId) => `${stageId}\0${resolved.learnerKey}`);
  // Snapshot only work that predates this restore. A later save may be queued
  // behind an exclusive maintenance request; awaiting it while holding the
  // shared global lock would create a cycle (restore -> save -> maintenance -> restore).
  const existingQueues = storeQueues.get(resolved.store);
  const precedingWrites = queueKeys
    .map((queueKey) => existingQueues?.get(queueKey))
    .filter((pending): pending is Promise<void> => pending !== undefined);

  async function withStageLock(index: number, isolatedWrites = false): Promise<void> {
    if (index < orderedStageIds.length) {
      const stageId = orderedStageIds[index]!;
      const queueKey = queueKeys[index]!;
      await withPartitionLocks(stageId, queueKey, resolved.requiresCrossRealmLock, (isolated) =>
        withStageLock(index + 1, isolatedWrites || isolated),
      );
      return;
    }

    const existingByStage = new Map<string, ChatRuntimeView[]>();
    for (const stageId of orderedStageIds) {
      existingByStage.set(
        stageId,
        await runtimeViews(resolved.store, stageId, resolved.learnerKey),
      );
    }
    await restoreLegacyRows();
    const restoredByStage = new Map<string, ChatSession[]>();
    const invalidRestoreRows: string[] = [];
    for (const stageId of orderedStageIds) {
      const conversion = normalizeLegacyConversion(await resolved.legacyStore.load(stageId));
      restoredByStage.set(stageId, conversion.sessions);
      if (conversion.skippedRows.length > 0) {
        invalidRestoreRows.push(
          `${JSON.stringify(stageId)}: ${legacyRowLabels(conversion.skippedRows)}`,
        );
      }
    }
    if (invalidRestoreRows.length > 0) {
      await options.rollbackLegacyRows?.();
      throw new Error(
        `Cannot restore malformed legacy chat rows (${invalidRestoreRows.join('; ')})`,
      );
    }
    const restoreMarkers: RuntimeSession[] = [];
    try {
      for (const stageId of orderedStageIds) {
        restoreMarkers.push(
          await createRestoreMarker(
            resolved.store,
            stageId,
            resolved.learnerKey,
            (existingByStage.get(stageId) ?? []).map((view) => view.runtimeSession.id),
          ),
        );
      }
    } catch (error) {
      await Promise.allSettled(
        restoreMarkers.map((marker) => resolved.store.deleteSession(marker.id)),
      );
      await options.rollbackLegacyRows?.();
      throw error;
    }
    for (const stageId of orderedStageIds) {
      await Promise.all(
        (existingByStage.get(stageId) ?? []).map((view) =>
          resolved.store.deleteSession(view.runtimeSession.id),
        ),
      );
    }
    for (const stageId of orderedStageIds) {
      const marker = restoreMarkers.find((candidate) => candidate.stageId === stageId)!;
      await finalizeRestoreMarker(resolved.store, marker);
      const beforeMigration = await runtimeViews(resolved.store, stageId, resolved.learnerKey);
      const restored = restoredByStage.get(stageId)!;
      await syncSessions(
        resolved.store,
        stageId,
        resolved.learnerKey,
        restored,
        false,
        isolatedWrites,
        undefined,
        undefined,
        beforeMigration,
        resolved.sleep,
      );
      await resolved.legacyStore.clear(stageId);
    }
  }

  const restoreAfterPrecedingWrites = async (): Promise<void> => {
    await Promise.all(precedingWrites);
    await withStageLock(0);
  };

  if (options.globalLockHeld) {
    await restoreAfterPrecedingWrites();
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.locks) {
    // The queue snapshot and shared-lock request are synchronous with respect
    // to other JavaScript tasks. New saves either join this shared epoch and
    // coordinate on partition locks, or wait behind a later exclusive request.
    await withChatStorageSharedLock(restoreAfterPrecedingWrites);
    return;
  }
  if (resolved.requiresCrossRealmLock) {
    throw new ChatStorageLockUnavailableError(
      'Chat storage requires the Web Locks API in this browser',
    );
  }
  // Without Web Locks, serialize the whole restore against same-realm writers.
  await Promise.all(precedingWrites);
  await withChatStorageExclusiveLock(() => withStageLock(0));
}

/** Clear the legacy table during stage deletion; RuntimeStore cascades separately. */
export async function deleteChatSessions(stageId: string): Promise<void> {
  await dexieLegacyStore.clear(stageId);
}
