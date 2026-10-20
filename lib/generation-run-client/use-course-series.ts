/**
 * A series' own `partCount`, for the badge a card shows for a run that is
 * one part of a course series: `run.series` (off its own snapshot) has only
 * the series id and this run's order, not how many parts the series has in
 * total, so a card showing "Part 2 of 5" needs this one extra read. Many
 * cards can name the same series (one per part already listed); this module
 * caches by series id so they share a single fetch instead of one each.
 */
import { useEffect, useState } from 'react';

import { fetchCourseSeries } from './api';

const cache = new Map<string, number>();
const inflight = new Map<string, Promise<number | null>>();

function load(seriesId: string): Promise<number | null> {
  const cached = cache.get(seriesId);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inflight.get(seriesId);
  if (pending) return pending;

  const request = fetchCourseSeries(seriesId)
    .then((series) => {
      if (series) cache.set(seriesId, series.partCount);
      return series?.partCount ?? null;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(seriesId);
    });
  inflight.set(seriesId, request);
  return request;
}

/** The series' total part count, once loaded; null while loading or on a failed/missing series. */
export function useCourseSeriesPartCount(seriesId: string | null): number | null {
  const cached = seriesId ? cache.get(seriesId) ?? null : null;
  const [loaded, setLoaded] = useState<{ seriesId: string | null; partCount: number | null }>({
    seriesId,
    partCount: cached,
  });

  useEffect(() => {
    if (!seriesId || cache.get(seriesId) !== undefined) return;
    let cancelled = false;
    void load(seriesId).then((value) => {
      if (!cancelled) setLoaded({ seriesId, partCount: value });
    });
    return () => {
      cancelled = true;
    };
  }, [seriesId]);

  // A value loaded for a different (or no longer current) series id is stale.
  if (loaded.seriesId === seriesId && loaded.partCount !== null) return loaded.partCount;
  return cached;
}
