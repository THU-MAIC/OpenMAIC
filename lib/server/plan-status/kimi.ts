/**
 * Kimi Code plan: `GET {coding base}/usages` reports the share used of each
 * allowance (`used_ratio`) with its reset time. Field names follow Kimi's own
 * client (MoonshotAI/kimi-code, packages/oauth/src/managed-usage.ts). The
 * `limits[].detail` counts are left out: their unit is not documented.
 * `limit_month_code` is the coding share of the monthly total, not a window of
 * its own. The answer says nothing about capabilities.
 */
import type { PlanQuotaWindow, PlanStatus } from '@/lib/model-settings/plan-status';

export const KIMI_USAGE_URLS: Record<string, string> = {
  kimi: 'https://api.kimi.com/coding/v1/usages',
  'kimi-intl': 'https://api.kimi.ai/coding/v1/usages',
};

const WINDOWS: ReadonlyArray<[string, Pick<PlanQuotaWindow, 'period' | 'hours'>]> = [
  ['limit_5h', { period: 'hours', hours: 5 }],
  ['limit_7d', { period: 'week' }],
  ['limit_month_total', { period: 'month' }],
];

function ratio(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

export function parseKimiUsages(body: unknown): PlanStatus | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const usages = (body as { usages?: unknown }).usages;
  if (!usages || typeof usages !== 'object') return undefined;
  const windows: PlanQuotaWindow[] = [];
  for (const [key, shape] of WINDOWS) {
    const entry = (usages as Record<string, unknown>)[key];
    if (!entry || typeof entry !== 'object') continue;
    const used = ratio((entry as { used_ratio?: unknown }).used_ratio);
    if (used === undefined) continue;
    const reset = (entry as { reset_time?: unknown }).reset_time;
    windows.push({
      ...shape,
      remainingPercent: Math.round(Math.max(0, Math.min(1, 1 - used)) * 10_000) / 100,
      ...(typeof reset === 'string' && reset ? { resetsAt: reset } : {}),
    });
  }
  if (!windows.length) return undefined;
  return { quota: { status: 'available', windows, balances: [] } };
}
