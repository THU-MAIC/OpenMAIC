/**
 * Tell a run's client when a library source's extraction settles, whether or
 * not the agent waits for it (RFC #1716 §7).
 *
 * Extraction runs on the owner worker, outside the run. The run learns of a
 * source it cares about -- one this run started, or one a wait found still in
 * progress -- and watches it while the run lasts: every interval it reads
 * the watched sources' status, and each one that is done, failed or gone is
 * reported once, as the run's own `library_changed` (`extraction_settled`),
 * so the client's material lists refetch even when the agent moved on
 * without waiting. A wait that sees a watched source settle reports it
 * through the same watcher, so a settlement is reported once either way; a
 * source the run never watched is never reported.
 *
 * No owner event stream: one primary-key read of the watched ids per
 * interval, only while there is something to watch, and nothing after the
 * run ends.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

export interface ExtractionWatcher {
  /** Start watching sources whose extraction has not settled. */
  watch(materialIds: readonly string[]): void;
  /** These sources were seen settled elsewhere: report the watched ones now. */
  settled(materialIds: readonly string[]): void;
  /** Stop for good: the run ended. */
  stop(): void;
}

export interface ExtractionWatcherOptions {
  /** Which of `materialIds` are settled; by default {@link readSettledSources} on this deployment. */
  readSettled?: (materialIds: readonly string[]) => Promise<string[]>;
  onSettled: (materialIds: string[]) => void;
  intervalMs?: number;
}

export const EXTRACTION_WATCH_INTERVAL_MS = 2_000;

/** The default read: one statement over the watched ids. */
export async function readSettledSources(
  queryable: Queryable,
  materialIds: readonly string[],
): Promise<string[]> {
  const found = await queryable.query<{ id: string; settled: boolean }>(
    `SELECT id, ((extraction->>'status') IN ('done', 'failed') OR deleted_at IS NOT NULL)
              AS settled
       FROM owner_material WHERE id = ANY($1::text[])`,
    [[...materialIds]],
  );
  const present = new Map(found.rows.map((row) => [row.id, row.settled]));
  // A source that is gone has settled as far as a list is concerned.
  return materialIds.filter((id) => present.get(id) !== false);
}

export function startExtractionWatcher(options: ExtractionWatcherOptions): ExtractionWatcher {
  const intervalMs = options.intervalMs ?? EXTRACTION_WATCH_INTERVAL_MS;
  const readSettled =
    options.readSettled ??
    (async (ids: readonly string[]) => {
      const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
      return readSettledSources(
        (await getServerPersistenceProvider(process.env.DATABASE_URL ?? '')).pool,
        ids,
      );
    });
  const watched = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let stopped = false;

  const report = (ids: readonly string[]) => {
    const settled = ids.filter((id) => watched.delete(id));
    if (watched.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (settled.length > 0) options.onSettled(settled);
  };

  const poll = async () => {
    if (polling || stopped || watched.size === 0) return;
    polling = true;
    try {
      const settled = await readSettled([...watched]);
      if (!stopped) report(settled);
    } catch (error) {
      // The next interval tries again; a list refetch is only a convenience.
      console.warn('[extraction-watcher] status read failed', error);
    } finally {
      polling = false;
    }
  };

  return {
    watch(materialIds) {
      if (stopped) return;
      for (const id of materialIds) watched.add(id);
      if (watched.size > 0 && !timer) {
        timer = setInterval(() => void poll(), intervalMs);
        // Never what keeps a process alive.
        timer.unref?.();
      }
    },
    settled(materialIds) {
      if (!stopped) report(materialIds);
    },
    stop() {
      stopped = true;
      watched.clear();
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
