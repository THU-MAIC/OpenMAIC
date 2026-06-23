import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { readUsageRecords, type UsageRecord } from '@/lib/server/usage-storage';

const log = createLogger('UsageAPI');

interface Bucket {
  key: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  totalCostUsd: number;
}

function emptyBucket(key: string): Bucket {
  return {
    key,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  };
}

function addTo(bucket: Bucket, r: UsageRecord): void {
  bucket.requests += 1;
  bucket.inputTokens += r.inputTokens;
  bucket.outputTokens += r.outputTokens;
  bucket.cacheReadTokens += r.cacheReadTokens;
  bucket.cacheCreationTokens += r.cacheCreationTokens;
  bucket.totalTokens +=
    r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens;
  bucket.totalCostUsd += r.totalCostUsd;
}

function dayKey(createdAt: number): string {
  return new Date(createdAt).toISOString().slice(0, 10);
}

/**
 * GET /api/usage
 *
 * Aggregates the deployment-wide usage log (data/usage/*.jsonl) by model, by
 * day, and by source. Optional `?months=YYYY-MM,YYYY-MM` limits the range.
 */
export async function GET(req: NextRequest) {
  try {
    const monthsParam = req.nextUrl.searchParams.get('months');
    const months = monthsParam ? monthsParam.split(',').map((s) => s.trim()) : undefined;

    const records = await readUsageRecords({ months });

    const byModel = new Map<string, Bucket>();
    const byDay = new Map<string, Bucket>();
    const bySource = new Map<string, Bucket>();
    const totals = emptyBucket('total');
    let costIncomplete = false;

    for (const r of records) {
      addTo(totals, r);
      if (r.costNull) costIncomplete = true;

      const mk = r.modelString || r.modelId;
      if (!byModel.has(mk)) byModel.set(mk, emptyBucket(mk));
      addTo(byModel.get(mk)!, r);

      const dk = dayKey(r.createdAt);
      if (!byDay.has(dk)) byDay.set(dk, emptyBucket(dk));
      addTo(byDay.get(dk)!, r);

      const sk = r.source || 'unknown';
      if (!bySource.has(sk)) bySource.set(sk, emptyBucket(sk));
      addTo(bySource.get(sk)!, r);
    }

    return apiSuccess({
      totals,
      byModel: [...byModel.values()].sort((a, b) => b.totalCostUsd - a.totalCostUsd),
      byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
      bySource: [...bySource.values()].sort((a, b) => b.totalTokens - a.totalTokens),
      // True if any record had an unknown model price — the cost total understates reality.
      costIncomplete,
    });
  } catch (error) {
    log.error('Usage aggregation failed:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to read usage',
    );
  }
}
