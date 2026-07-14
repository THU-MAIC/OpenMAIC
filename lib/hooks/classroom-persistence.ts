import type { Stage, Scene } from '@/lib/types/stage';

export interface PersistClassroomResult {
  success: boolean;
  url?: string;
  error?: string;
}

async function sendPersist(stage: Stage, scenes: Scene[]): Promise<PersistClassroomResult> {
  try {
    const response = await fetch('/api/classroom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage, scenes }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.success === false) {
      return { success: false, error: data.error || `HTTP ${response.status}` };
    }

    return { success: true, url: data.url };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// serialize writes per stage id so a slow first-scene POST can't land after the
// completion POST and clobber the full deck with a stale one-scene snapshot (#53)
const persistChains = new Map<string, Promise<PersistClassroomResult>>();

export function persistClassroomToServer(
  stage: Stage,
  scenes: Scene[],
): Promise<PersistClassroomResult> {
  const prev = persistChains.get(stage.id) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => sendPersist(stage, scenes));
  persistChains.set(stage.id, next);
  void next.finally(() => {
    if (persistChains.get(stage.id) === next) persistChains.delete(stage.id);
  });
  return next;
}
