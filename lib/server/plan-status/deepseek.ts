/**
 * DeepSeek is pay-as-you-go: `GET /user/balance` reports the balance per
 * currency (`total_balance` covers granted and topped-up credit). There are
 * no windows and no reset time, and nothing about capabilities.
 */
import type { PlanBalance, PlanStatus } from '@/lib/model-settings/plan-status';

export const DEEPSEEK_BALANCE_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/user/balance',
};

export function parseDeepseekBalance(body: unknown): PlanStatus | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const infos = (body as { balance_infos?: unknown }).balance_infos;
  if (!Array.isArray(infos)) return undefined;
  const balances: PlanBalance[] = [];
  for (const info of infos) {
    if (!info || typeof info !== 'object') continue;
    const { currency, total_balance: amount } = info as {
      currency?: unknown;
      total_balance?: unknown;
    };
    if (typeof currency === 'string' && typeof amount === 'string') {
      balances.push({ currency, amount });
    }
  }
  if (!balances.length) return undefined;
  return { quota: { status: 'available', windows: [], balances } };
}
