/**
 * MiniMax Token Plan: `GET /v1/token_plan/remains` lists the plan's quota per
 * category (`general`, and `video` on a tier that includes video), each with a
 * short rolling window and a weekly one. A plan without a video bucket does
 * not include video.
 *
 * Field readings follow MiniMax's own CLI (MiniMax-AI/cli, src/utils/quota.ts
 * and src/output/quota-table.ts):
 * - `*_status`: 1 normal, 2 exhausted, 3 unlimited — except that both windows
 *   at 3 with both totals 0 means the plan has no bucket for the category.
 * - `*_usage_count` is ambiguous: older responses report remaining calls,
 *   newer ones may report calls used. With a remaining percentage, the reading
 *   that agrees with it is taken; with none, the remaining one.
 * - `remains_time` / `weekly_remains_time`: milliseconds until the window ends.
 */
import type { SlotCapability } from '@/lib/config/model-slots';
import type { PlanQuotaWindow, PlanStatus } from '@/lib/model-settings/plan-status';

/** The quota endpoint per plan: each site takes only its own accounts' keys. */
export const MINIMAX_REMAINS_URLS: Record<string, string> = {
  minimax: 'https://api.minimaxi.com/v1/token_plan/remains',
  'minimax-intl': 'https://api.minimax.io/v1/token_plan/remains',
};

interface Remain {
  model_name?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  current_interval_total_count?: unknown;
  current_interval_usage_count?: unknown;
  current_interval_status?: unknown;
  current_interval_remaining_percent?: unknown;
  current_weekly_total_count?: unknown;
  current_weekly_usage_count?: unknown;
  current_weekly_status?: unknown;
  current_weekly_remaining_percent?: unknown;
  weekly_end_time?: unknown;
}

const STATUS_EXHAUSTED = 2;
const STATUS_UNLIMITED = 3;
/** How far (in points) a count reading may sit from the reported percentage. */
const PERCENT_MATCH_TOLERANCE = 1;

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** An entry carrying both windows' status, the shape this reading knows. */
const KNOWN_STATUSES = new Set([1, STATUS_EXHAUSTED, STATUS_UNLIMITED]);

function readable(remain: Remain): boolean {
  return (
    KNOWN_STATUSES.has(num(remain.current_interval_status) ?? NaN) &&
    KNOWN_STATUSES.has(num(remain.current_weekly_status) ?? NaN)
  );
}

/** Neither window has a bucket: the plan does not include this category. */
function notIncluded(remain: Remain): boolean {
  return (
    num(remain.current_interval_total_count) === 0 &&
    num(remain.current_weekly_total_count) === 0 &&
    num(remain.current_interval_status) === STATUS_UNLIMITED &&
    num(remain.current_weekly_status) === STATUS_UNLIMITED
  );
}

/** Used and total calls, when the counts can be read unambiguously. */
function counts(
  reported: number | undefined,
  total: number | undefined,
  remainingPercent: number | undefined,
): { used: number; total: number } | undefined {
  if (reported === undefined || total === undefined || total <= 0) return undefined;
  if (reported < 0 || reported > total) return undefined;
  let remaining = reported;
  if (remainingPercent !== undefined) {
    const asRemaining = Math.abs((reported / total) * 100 - remainingPercent);
    const asUsed = Math.abs(((total - reported) / total) * 100 - remainingPercent);
    if (Math.min(asRemaining, asUsed) > PERCENT_MATCH_TOLERANCE) return undefined;
    if (asUsed < asRemaining) remaining = total - reported;
  }
  return { used: total - remaining, total };
}

function window(
  category: string | undefined,
  period: 'hours' | 'week',
  fields: {
    status?: number;
    total?: number;
    reported?: number;
    percent?: number;
    start?: number;
    end?: number;
  },
): PlanQuotaWindow {
  const base: PlanQuotaWindow = {
    ...(category ? { category } : {}),
    period,
    ...(period === 'hours' && fields.start !== undefined && fields.end !== undefined
      ? { hours: Math.round((fields.end - fields.start) / 3_600_000) }
      : {}),
    ...(fields.end !== undefined ? { resetsAt: new Date(fields.end).toISOString() } : {}),
  };
  if (fields.status === STATUS_UNLIMITED) return { ...base, unlimited: true };
  const counted = counts(fields.reported, fields.total, fields.percent);
  const remainingPercent =
    fields.status === STATUS_EXHAUSTED
      ? 0
      : (fields.percent ??
        (counted ? ((counted.total - counted.used) / counted.total) * 100 : undefined));
  return {
    ...base,
    ...(remainingPercent !== undefined ? { remainingPercent } : {}),
    ...(counted ?? {}),
  };
}

/** Read a `remains` answer; undefined when it is not one this reading knows. */
export function parseMinimaxRemains(body: unknown): PlanStatus | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const { model_remains: remains, base_resp: base } = body as {
    model_remains?: unknown;
    base_resp?: { status_code?: unknown };
  };
  if (base?.status_code !== 0 || !Array.isArray(remains)) return undefined;
  const entries = remains.filter(
    (entry): entry is Remain =>
      !!entry && typeof entry === 'object' && typeof (entry as Remain).model_name === 'string',
  );
  // Nothing this reading knows: no quota to show (it reads as unavailable).
  if (!entries.some(readable)) return undefined;

  const windows: PlanQuotaWindow[] = [];
  for (const remain of entries) {
    if (!readable(remain) || notIncluded(remain)) continue;
    // The `general` bucket meters the plan as a whole; `video` is the video capability.
    const name = remain.model_name as string;
    const category = name === 'general' ? undefined : name;
    windows.push(
      window(category, 'hours', {
        status: num(remain.current_interval_status),
        total: num(remain.current_interval_total_count),
        reported: num(remain.current_interval_usage_count),
        percent: num(remain.current_interval_remaining_percent),
        start: num(remain.start_time),
        end: num(remain.end_time),
      }),
      window(category, 'week', {
        status: num(remain.current_weekly_status),
        total: num(remain.current_weekly_total_count),
        reported: num(remain.current_weekly_usage_count),
        percent: num(remain.current_weekly_remaining_percent),
        end: num(remain.weekly_end_time),
      }),
    );
  }
  const quota = { status: 'available' as const, windows, balances: [] };
  // Only an answer this reading knows says anything about video: a readable
  // `general` bucket, and a `video` bucket (if any) that is readable too.
  // Anything else leaves the plan's capabilities as declared.
  const named = (name: string) => entries.find((remain) => remain.model_name === name);
  const general = named('general');
  const video = named('video');
  if (!general || !readable(general) || (video && !readable(video))) return { quota };
  // Only video has a bucket of its own; the `general` bucket does not tell
  // which of the other capabilities the plan includes.
  const unsupported: SlotCapability[] = video && !notIncluded(video) ? [] : ['video'];
  return { quota, unsupported };
}
