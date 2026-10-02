export const INTERACTIVE_REPAIR_HANDOFF_EVENT = 'openmaic:interactive-repair-handoff';

const INTERACTIVE_REPAIR_HANDOFF_KEY = 'openmaic:workbench:interactive-repair-handoff';
const HANDOFF_VERSION = 1;
const COURSE_ID_MAX = 128;
const SCENE_ID_MAX = 128;
const ERROR_MAX = 1200;

export interface InteractiveRepairHandoff {
  readonly courseId: string;
  readonly sceneId: string;
  readonly error: string;
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

/**
 * One-shot bridge from a classroom runtime error into the Pro workspace.
 * The payload stays in this browser tab and is never sent by staging it.
 */
export function stageInteractiveRepairHandoff(input: InteractiveRepairHandoff): boolean {
  const store = storage();
  if (!store) return false;

  const payload = {
    version: HANDOFF_VERSION,
    courseId: bounded(input.courseId, COURSE_ID_MAX),
    sceneId: bounded(input.sceneId, SCENE_ID_MAX),
    error: bounded(input.error, ERROR_MAX),
  };
  if (!payload.courseId || !payload.sceneId || !payload.error) return false;

  try {
    store.setItem(INTERACTIVE_REPAIR_HANDOFF_KEY, JSON.stringify(payload));
    window.dispatchEvent(new Event(INTERACTIVE_REPAIR_HANDOFF_EVENT));
    return true;
  } catch {
    return false;
  }
}

/**
 * Consume only when the workspace is showing the intended course. A transient
 * course mismatch leaves the handoff intact for the target pane to claim.
 */
export function consumeInteractiveRepairHandoff(
  courseId: string | null,
): Omit<InteractiveRepairHandoff, 'courseId'> | null {
  if (!courseId) return null;
  const store = storage();
  if (!store) return null;

  let raw: string | null;
  try {
    raw = store.getItem(INTERACTIVE_REPAIR_HANDOFF_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<InteractiveRepairHandoff> & { version?: unknown };
    if (
      parsed.version !== HANDOFF_VERSION ||
      typeof parsed.courseId !== 'string' ||
      typeof parsed.sceneId !== 'string' ||
      typeof parsed.error !== 'string'
    ) {
      store.removeItem(INTERACTIVE_REPAIR_HANDOFF_KEY);
      return null;
    }
    if (parsed.courseId !== courseId) return null;

    store.removeItem(INTERACTIVE_REPAIR_HANDOFF_KEY);
    const sceneId = bounded(parsed.sceneId, SCENE_ID_MAX);
    const error = bounded(parsed.error, ERROR_MAX);
    return sceneId && error ? { sceneId, error } : null;
  } catch {
    try {
      store.removeItem(INTERACTIVE_REPAIR_HANDOFF_KEY);
    } catch {}
    return null;
  }
}
