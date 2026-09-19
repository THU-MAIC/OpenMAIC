/**
 * Device-scoped playback cursor persistence.
 *
 * The cursor is mutable resume state, not a learner-runtime fact. It therefore
 * lives in the KV `device` scope and remains last-write-wins. Legacy Dexie
 * migration is delegated lazily so importing this module never opens either
 * browser store.
 */
import { BrowserKVStore, type KVStore } from '@openmaic/storage';

export interface PlaybackCursor {
  sceneId: string;
  actionIndex: number;
  updatedAt: string;
}

export interface LegacyPlaybackState {
  stageId: string;
  sceneIndex: number;
  actionIndex: number;
  consumedDiscussions: string[];
  sceneId?: string;
  updatedAt: number;
}

export interface PlaybackLegacyStore {
  get(stageId: string): Promise<LegacyPlaybackState | undefined>;
  delete(stageId: string): Promise<void>;
}

export interface PlaybackCursorDeps {
  kv?: KVStore;
  legacyStore?: PlaybackLegacyStore;
}

const CURSOR_KEY_PREFIX = 'playback-cursor:';

let defaultKv: KVStore | undefined;

function cursorKey(stageId: string): string {
  return `${CURSOR_KEY_PREFIX}${stageId}`;
}

function resolveKv(kv?: KVStore): KVStore {
  if (kv) return kv;
  if (typeof window === 'undefined') {
    throw new Error('Playback cursor persistence is client-only');
  }
  return (defaultKv ??= new BrowserKVStore());
}

function isPlaybackCursor(value: unknown): value is PlaybackCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Partial<PlaybackCursor>;
  return (
    typeof cursor.sceneId === 'string' &&
    Number.isInteger(cursor.actionIndex) &&
    typeof cursor.updatedAt === 'string'
  );
}

/** Internal raw read used by the all-or-nothing legacy migration. */
export async function loadCursorValue(
  stageId: string,
  kv: KVStore,
): Promise<PlaybackCursor | null> {
  const value = await kv.get<unknown>(cursorKey(stageId), 'device');
  return isPlaybackCursor(value) ? value : null;
}

/** Internal raw write used by the all-or-nothing legacy migration. */
export function saveCursorValue(
  stageId: string,
  cursor: PlaybackCursor,
  kv: KVStore,
): Promise<void> {
  return kv.set(cursorKey(stageId), cursor, 'device');
}

async function defaultLegacyStore(): Promise<PlaybackLegacyStore> {
  if (typeof window === 'undefined') {
    throw new Error('Legacy playback migration is client-only');
  }
  const { db } = await import('@/lib/utils/database');
  return {
    async get(stageId) {
      const row: unknown = await db.playbackState.get(stageId);
      return row as LegacyPlaybackState | undefined;
    },
    async delete(stageId) {
      await db.playbackState.delete(stageId);
    },
  };
}

/**
 * One-time lazy migration of a legacy Dexie playback row. Only the cursor
 * half carries over: consumed-discussion state is volatile by decision
 * (see #869 — playback learner state is front-end ephemeral UX; a re-shown
 * discussion card auto-skips, so durability buys nothing).
 */
async function migrateLegacyCursor(
  stageId: string,
  kv: KVStore,
  legacyStore?: PlaybackLegacyStore,
): Promise<void> {
  const store = legacyStore ?? (await defaultLegacyStore());
  const legacy = await store.get(stageId);
  if (!legacy) return;
  if (!(await loadCursorValue(stageId, kv)) && legacy.sceneId) {
    // Re-check at the last moment: a concurrent tab may have saved a newer
    // cursor between the read above and this write, and the legacy row is
    // deleted below, so an overwrite here would be unrecoverable. The
    // remaining sub-millisecond window is acceptable for LWW device state.
    if (await loadCursorValue(stageId, kv)) {
      await store.delete(stageId);
      return;
    }
    // A corrupt legacy timestamp must not wedge migration: throwing here
    // would leave the row in place and re-throw on every load, silently
    // disabling resume for the stage. Fall back to "now" and move on.
    const migratedAt = Number.isFinite(new Date(legacy.updatedAt).getTime())
      ? new Date(legacy.updatedAt).toISOString()
      : new Date().toISOString();
    await saveCursorValue(
      stageId,
      {
        sceneId: legacy.sceneId,
        actionIndex: legacy.actionIndex,
        updatedAt: migratedAt,
      },
      kv,
    );
  }
  await store.delete(stageId);
}

/** Load the latest device cursor, migrating the legacy row's cursor half first. */
export async function loadCursor(
  stageId: string,
  deps: PlaybackCursorDeps = {},
): Promise<PlaybackCursor | null> {
  const kv = resolveKv(deps.kv);
  await migrateLegacyCursor(stageId, kv, deps.legacyStore);
  return loadCursorValue(stageId, kv);
}

/** Overwrite the device cursor. Callers own any desired debounce. */
export async function saveCursor(
  stageId: string,
  cursor: PlaybackCursor,
  deps: Pick<PlaybackCursorDeps, 'kv'> = {},
): Promise<void> {
  await saveCursorValue(stageId, cursor, resolveKv(deps.kv));
}

/** Remove the device cursor without touching append-only runtime facts. */
export async function clearCursor(
  stageId: string,
  deps: Pick<PlaybackCursorDeps, 'kv'> = {},
): Promise<void> {
  await resolveKv(deps.kv).remove(cursorKey(stageId), 'device');
}
