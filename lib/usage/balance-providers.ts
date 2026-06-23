/**
 * Built-in balance/quota queries for providers that expose a key-authenticated
 * balance endpoint. Ported from cc-switch `src-tauri/src/services/balance.rs`.
 *
 * Extensibility (per plan): a provider is a `{ id, label, match, endpoint, parse }`
 * entry in `BALANCE_PROVIDERS`. Adding a vendor = add one entry. The pluggable
 * user-script track (cc-switch's third mechanism) is intentionally NOT included
 * this phase — running arbitrary JS in the Next.js server (node:vm) is not a
 * safe sandbox boundary; revisit with a worker/subprocess isolate later.
 */

/** Normalized balance result, mirroring cc-switch `UsageData`. */
export interface BalanceResult {
  supported: boolean;
  planName?: string;
  remaining?: number;
  total?: number;
  used?: number;
  unit?: string;
  isValid?: boolean;
  invalidMessage?: string;
}

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// ── Parsers (pure; HTTP shape → BalanceResult) ──────────────────────────────

/** DeepSeek `GET /user/balance` → `{ is_available, balance_infos:[{currency,total_balance}] }`. */
export function parseDeepSeek(body: Record<string, unknown>): BalanceResult {
  const isAvailable = body.is_available !== false;
  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const first = (infos[0] ?? {}) as Record<string, unknown>;
  const currency = (first.currency as string) ?? 'CNY';
  return {
    supported: true,
    planName: currency,
    remaining: toNum(first.total_balance),
    unit: currency,
    isValid: isAvailable,
    invalidMessage: isAvailable ? undefined : 'Insufficient balance',
  };
}

/** SiliconFlow `GET /v1/user/info` → `{ data: { totalBalance } }`. */
export function parseSiliconFlow(body: Record<string, unknown>): BalanceResult {
  const data = (body.data ?? {}) as Record<string, unknown>;
  return {
    supported: true,
    planName: 'SiliconFlow',
    remaining: toNum(data.totalBalance),
    unit: 'CNY',
    isValid: true,
  };
}

/** StepFun `GET /v1/accounts` → `{ balance }`. */
export function parseStepFun(body: Record<string, unknown>): BalanceResult {
  return {
    supported: true,
    planName: 'StepFun',
    remaining: toNum(body.balance) ?? 0,
    unit: 'CNY',
    isValid: true,
  };
}

/** OpenRouter `GET /api/v1/credits` → `{ data: { total_credits, total_usage } }`. */
export function parseOpenRouter(body: Record<string, unknown>): BalanceResult {
  const data = (body.data ?? body) as Record<string, unknown>;
  const total = toNum(data.total_credits) ?? 0;
  const used = toNum(data.total_usage) ?? 0;
  const remaining = total - used;
  return {
    supported: true,
    planName: 'OpenRouter',
    remaining,
    total,
    used,
    unit: 'USD',
    isValid: remaining > 0,
    invalidMessage: remaining > 0 ? undefined : 'No credits remaining',
  };
}

/**
 * one-api / new-api / MAIC-style gateways expose OpenAI's legacy billing API:
 *   GET /v1/dashboard/billing/subscription → { hard_limit_usd }
 *   GET /v1/dashboard/billing/usage        → { total_usage }  (in cents)
 * remaining = hard_limit_usd - total_usage/100.
 */
export function parseOneApiBilling(
  subscription: Record<string, unknown>,
  usage: Record<string, unknown>,
): BalanceResult {
  const total = toNum(subscription.hard_limit_usd) ?? 0;
  const usedCents = toNum(usage.total_usage) ?? 0;
  const used = usedCents / 100;
  const remaining = total - used;
  return {
    supported: true,
    planName: 'Token Plan',
    remaining,
    total,
    used,
    unit: 'USD',
    isValid: remaining > 0,
    invalidMessage: remaining > 0 ? undefined : 'No balance remaining',
  };
}

// ── Provider registry (detection + fetch) ───────────────────────────────────

interface BalanceProviderDef {
  id: string;
  label: string;
  pattern: RegExp;
  /** Runs the HTTP query and returns a normalized result. */
  query: (apiKey: string, baseUrl: string) => Promise<BalanceResult>;
}

const TIMEOUT_MS = 15_000;

async function getJson(url: string, apiKey: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new BalanceAuthError(res.status);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/** Thrown on 401/403 so the route can return an isValid:false auth error. */
export class BalanceAuthError extends Error {
  constructor(public readonly status: number) {
    super(`Authentication failed (HTTP ${status})`);
    this.name = 'BalanceAuthError';
  }
}

export const BALANCE_PROVIDERS: BalanceProviderDef[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    pattern: /api\.deepseek\.com/i,
    query: async (key) => parseDeepSeek(await getJson('https://api.deepseek.com/user/balance', key)),
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    pattern: /api\.siliconflow\.(cn|com)/i,
    query: async (key, baseUrl) => {
      const host = /\.com/i.test(baseUrl) ? 'api.siliconflow.com' : 'api.siliconflow.cn';
      return parseSiliconFlow(await getJson(`https://${host}/v1/user/info`, key));
    },
  },
  {
    id: 'stepfun',
    label: 'StepFun',
    pattern: /api\.stepfun\.(ai|com)/i,
    query: async (key) => parseStepFun(await getJson('https://api.stepfun.com/v1/accounts', key)),
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    pattern: /openrouter\.ai/i,
    query: async (key) =>
      parseOpenRouter(await getJson('https://openrouter.ai/api/v1/credits', key)),
  },
];

/** Returns the matching built-in balance provider for a base URL, if any. */
export function detectBalanceProvider(baseUrl: string): BalanceProviderDef | undefined {
  return BALANCE_PROVIDERS.find((p) => p.pattern.test(baseUrl));
}

/**
 * Queries balance for a base URL. Tries a detected built-in provider first, then
 * falls back to the OpenAI-legacy billing endpoints (one-api/new-api/MAIC). When
 * neither applies, returns `{ supported: false }` so the UI shows a console hint.
 */
export async function queryBalance(baseUrl: string, apiKey: string): Promise<BalanceResult> {
  const provider = detectBalanceProvider(baseUrl);
  if (provider) {
    try {
      return await provider.query(apiKey, baseUrl);
    } catch (e) {
      if (e instanceof BalanceAuthError) {
        return { supported: true, isValid: false, invalidMessage: e.message };
      }
      throw e;
    }
  }

  // Fallback: OpenAI legacy billing endpoints (one-api / new-api / MAIC gateway).
  const root = baseUrl.trim().replace(/\/+$/, '');
  try {
    const sub = await getJson(`${root}/dashboard/billing/subscription`, apiKey);
    const usage = await getJson(`${root}/dashboard/billing/usage`, apiKey).catch(() => ({}));
    return parseOneApiBilling(sub, usage);
  } catch (e) {
    if (e instanceof BalanceAuthError) {
      return { supported: true, isValid: false, invalidMessage: e.message };
    }
    return { supported: false };
  }
}
