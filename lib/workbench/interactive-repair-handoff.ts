export const INTERACTIVE_REPAIR_HANDOFF_EVENT = 'openmaic:interactive-repair-handoff';

const INTERACTIVE_REPAIR_HANDOFF_KEY = 'openmaic:workbench:interactive-repair-handoff';
const CONSUMED_NONCES_KEY = 'openmaic:workbench:interactive-repair-consumed';
const HANDOFF_VERSION = 2;
export const INTERACTIVE_REPAIR_HANDOFF_TTL_MS = 60_000;
const COURSE_ID_MAX = 128;
const SCENE_ID_MAX = 128;
const ERROR_MAX = 1200;
const MAX_CONSUMED_NONCES = 32;

export interface InteractiveRepairHandoff {
  readonly courseId: string;
  readonly sceneId: string;
  readonly error: string;
}

interface StoredHandoff extends InteractiveRepairHandoff {
  readonly version: number;
  readonly nonce: string;
  readonly createdAt: number;
}

interface ConsumedNonce {
  readonly nonce: string;
  readonly expiresAt: number;
}

function bounded(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Only nonce identifiers are shared across tabs; error text stays in sessionStorage. */
function sharedStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function consumedNonces(store: Storage, now: number): ConsumedNonce[] {
  try {
    const raw = store.getItem(CONSUMED_NONCES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is ConsumedNonce =>
          typeof item?.nonce === 'string' &&
          typeof item?.expiresAt === 'number' &&
          item.expiresAt > now,
      )
      .slice(-MAX_CONSUMED_NONCES);
  } catch {
    return [];
  }
}

function nonce(): string {
  if (typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One-shot bridge from a classroom runtime error into the Pro workspace.
 * The payload stays in this browser tab and is never sent by staging it.
 */
export function stageInteractiveRepairHandoff(input: InteractiveRepairHandoff): boolean {
  const store = storage();
  if (!store) return false;

  const courseId = bounded(input.courseId, COURSE_ID_MAX);
  const sceneId = bounded(input.sceneId, SCENE_ID_MAX);
  const error = bounded(input.error, ERROR_MAX);
  if (!courseId || !sceneId || !error) return false;

  try {
    const payload: StoredHandoff = {
      version: HANDOFF_VERSION,
      nonce: nonce(),
      createdAt: Date.now(),
      courseId,
      sceneId,
      error,
    };
    store.setItem(INTERACTIVE_REPAIR_HANDOFF_KEY, JSON.stringify(payload));
    window.dispatchEvent(new Event(INTERACTIVE_REPAIR_HANDOFF_EVENT));
    return true;
  } catch {
    return false;
  }
}

/**
 * Consume only when the writable workspace shows the intended course. A
 * transient course mismatch leaves the handoff for the target pane, but an
 * expired or already-consumed request is always discarded.
 */
export function consumeInteractiveRepairHandoff(
  courseId: string | null,
): Omit<InteractiveRepairHandoff, 'courseId'> | null {
  if (!courseId) return null;
  const store = storage();
  if (!store) return null;

  try {
    const raw = store.getItem(INTERACTIVE_REPAIR_HANDOFF_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const value = parsed as Partial<StoredHandoff> | null;
    const now = Date.now();
    if (
      !value ||
      value.version !== HANDOFF_VERSION ||
      typeof value.courseId !== 'string' ||
      typeof value.sceneId !== 'string' ||
      typeof value.error !== 'string' ||
      typeof value.nonce !== 'string' ||
      !value.nonce ||
      typeof value.createdAt !== 'number' ||
      !Number.isFinite(value.createdAt) ||
      value.createdAt > now ||
      now - value.createdAt > INTERACTIVE_REPAIR_HANDOFF_TTL_MS
    ) {
      store.removeItem(INTERACTIVE_REPAIR_HANDOFF_KEY);
      return null;
    }

    const shared = sharedStorage();
    const alreadyConsumed = shared ? consumedNonces(shared, now) : [];
    if (alreadyConsumed.some((item) => item.nonce === value.nonce)) {
      store.removeItem(INTERACTIVE_REPAIR_HANDOFF_KEY);
      return null;
    }
    if (value.courseId !== courseId) return null;

    const sceneId = bounded(value.sceneId, SCENE_ID_MAX);
    const error = bounded(value.error, ERROR_MAX);
    store.removeItem(INTERACTIVE_REPAIR_HANDOFF_KEY);
    if (!sceneId || !error) return null;

    // Duplicate-tab copies have separate sessionStorage but share this short,
    // bounded nonce tombstone. No diagnostic content enters localStorage.
    try {
      shared?.setItem(
        CONSUMED_NONCES_KEY,
        JSON.stringify(
          [
            ...alreadyConsumed,
            { nonce: value.nonce, expiresAt: now + INTERACTIVE_REPAIR_HANDOFF_TTL_MS },
          ].slice(-MAX_CONSUMED_NONCES),
        ),
      );
    } catch {
      // In private-storage modes, expiry and per-tab one-shot still apply.
    }
    return { sceneId, error };
  } catch {
    try {
      store.removeItem(INTERACTIVE_REPAIR_HANDOFF_KEY);
    } catch {}
    return null;
  }
}
