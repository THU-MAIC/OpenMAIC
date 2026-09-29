/**
 * Generation settings the server decides for the browser: how many scenes
 * (and narration clips) it may generate at once. Read once per page from
 * `GET /api/health`; `0` keeps generation serial, and so does a failed read,
 * which is tried again next time.
 */
let pending: Promise<number | null> | null = null;

async function readParallelSceneConcurrency(): Promise<number | null> {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      generation?: { parallelSceneConcurrency?: unknown };
    };
    const value = Number(body.generation?.parallelSceneConcurrency ?? 0);
    // Clamped server-side too; kept in range against a malformed answer.
    return Number.isFinite(value) ? Math.min(10, Math.max(0, Math.floor(value))) : 0;
  } catch {
    return null;
  }
}

export async function getParallelSceneConcurrency(): Promise<number> {
  pending ??= readParallelSceneConcurrency().then((value) => {
    if (value === null) pending = null;
    return value;
  });
  return (await pending) ?? 0;
}

/** Forget the cached value (tests). */
export function resetServerGenerationSettingsForTests(): void {
  pending = null;
}
