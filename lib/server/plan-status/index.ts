/**
 * Ask a token plan's vendor about the account behind a key: its quota, and
 * the capabilities its tier does not include where the vendor says. Each
 * vendor's endpoint and reading live in its own module; a plan without one
 * answers `unavailable`. The endpoints are fixed official URLs per plan, never
 * a caller's, and every call is a read.
 */
import { TOKEN_PLAN_PRESETS } from '@/lib/config/token-plan-presets';
import { tokenPlanPresetId } from '@/lib/config/preset-ids';
import type { PlanStatus } from '@/lib/model-settings/plan-status';
import { createLogger } from '@/lib/logger';
import { mediaProviderFetch } from '@/lib/server/media-provider-fetch';

import { DEEPSEEK_BALANCE_URLS, parseDeepseekBalance } from './deepseek';
import { KIMI_USAGE_URLS, parseKimiUsages } from './kimi';
import { MINIMAX_REMAINS_URLS, parseMinimaxRemains } from './minimax';

const log = createLogger('PlanStatus');

const TIMEOUT_MS = 8_000;

interface StatusSource {
  urls: Record<string, string>;
  parse: (body: unknown) => PlanStatus | undefined;
  /** Whether the answer can say which capabilities the plan lacks. */
  reportsCapabilities: boolean;
}

const SOURCES: StatusSource[] = [
  { urls: MINIMAX_REMAINS_URLS, parse: parseMinimaxRemains, reportsCapabilities: true },
  { urls: KIMI_USAGE_URLS, parse: parseKimiUsages, reportsCapabilities: false },
  { urls: DEEPSEEK_BALANCE_URLS, parse: parseDeepseekBalance, reportsCapabilities: false },
];

const UNAVAILABLE: PlanStatus = { quota: { status: 'unavailable' } };

/** The token plan behind a provider preset id, if it is one. */
function planIdOf(presetId: string): string | undefined {
  return TOKEN_PLAN_PRESETS.find((plan) => tokenPlanPresetId(plan.id) === presetId)?.id;
}

function sourceOf(presetId: string): { planId: string; source: StatusSource } | undefined {
  const planId = planIdOf(presetId);
  const source = planId ? SOURCES.find((entry) => Object.hasOwn(entry.urls, planId)) : undefined;
  return planId && source ? { planId, source } : undefined;
}

/** Whether the vendor of a provider preset can be asked about its plan. */
export function hasPlanStatus(presetId: string): boolean {
  return !!sourceOf(presetId);
}

/** Whether the vendor's answer says which capabilities a key's plan lacks. */
export function reportsPlanCapabilities(presetId: string): boolean {
  return !!sourceOf(presetId)?.source.reportsCapabilities;
}

/**
 * The vendor's answer for a key. Never throws: a plan without a query, a
 * refused key, a timeout or an answer this reading does not know all come
 * back `unavailable` without `unsupported`, so the plan's declared
 * capabilities stand.
 */
export async function fetchPlanStatus(presetId: string, apiKey: string): Promise<PlanStatus> {
  const found = sourceOf(presetId);
  if (!found || !apiKey) return UNAVAILABLE;
  const { planId, source } = found;
  try {
    const response = await mediaProviderFetch(source.urls[planId], {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      log.warn(`Plan status for ${planId}: HTTP ${response.status}`);
      return UNAVAILABLE;
    }
    const status = source.parse(await response.json());
    if (!status) log.warn(`Plan status for ${planId}: unrecognised answer`);
    return status ?? UNAVAILABLE;
  } catch (error) {
    log.warn(`Plan status for ${planId} failed:`, error instanceof Error ? error.name : 'error');
    return UNAVAILABLE;
  }
}
