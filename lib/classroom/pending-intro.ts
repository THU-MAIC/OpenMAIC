/**
 * When navigating to a classroom, we stash intro TTS metadata in sessionStorage
 * so the classroom page can start intro generation before IndexedDB hydration finishes.
 */

export const PENDING_INTRO_SESSION_KEY = 'slate_pending_intro';

export type PendingIntroPayload = {
  stageId: string;
  name: string;
  description?: string;
  /** BCP-47; defaults in IntroStreamingPlayer if omitted */
  language?: string;
};

const bootstrapCache = new Map<string, PendingIntroPayload>();

export function setPendingIntroPayload(payload: PendingIntroPayload): void {
  try {
    sessionStorage.setItem(
      PENDING_INTRO_SESSION_KEY,
      JSON.stringify({
        stageId: payload.stageId,
        name: payload.name,
        description: payload.description ?? '',
        language: payload.language ?? 'zh-CN',
      }),
    );
  } catch {
    /* ignore */
  }
}

/**
 * Returns pending intro metadata for this classroom once per navigation (sessionStorage
 * is consumed on first read). A module cache survives React Strict Mode double-mounts.
 */
export function takeIntroBootstrapForClassroom(classroomId: string): PendingIntroPayload | null {
  if (typeof window === 'undefined') return null;
  const cached = bootstrapCache.get(classroomId);
  if (cached) return cached;

  try {
    const raw = sessionStorage.getItem(PENDING_INTRO_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingIntroPayload;
    if (parsed.stageId !== classroomId) return null;
    sessionStorage.removeItem(PENDING_INTRO_SESSION_KEY);
    bootstrapCache.set(classroomId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** When switching classrooms in-session, drop cached bootstrap for the previous id. */
export function evictIntroBootstrapCache(classroomId: string): void {
  bootstrapCache.delete(classroomId);
}
