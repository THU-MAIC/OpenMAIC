import { describe, expect, it } from 'vitest';
import {
  detectBalanceProvider,
  parseDeepSeek,
  parseSiliconFlow,
  parseOpenRouter,
  parseOneApiBilling,
  type BalanceResult,
} from '@/lib/usage/balance-providers';

describe('detectBalanceProvider', () => {
  it('matches DeepSeek', () => {
    expect(detectBalanceProvider('https://api.deepseek.com')?.id).toBe('deepseek');
  });
  it('matches SiliconFlow .cn and .com', () => {
    expect(detectBalanceProvider('https://api.siliconflow.cn/v1')?.id).toBe('siliconflow');
    expect(detectBalanceProvider('https://api.siliconflow.com/v1')?.id).toBe('siliconflow');
  });
  it('matches OpenRouter', () => {
    expect(detectBalanceProvider('https://openrouter.ai/api/v1')?.id).toBe('openrouter');
  });
  it('returns undefined for an unknown host', () => {
    expect(detectBalanceProvider('https://maas-test.maic.chat/v1')).toBeUndefined();
  });
});

describe('balance parsers', () => {
  it('parses DeepSeek balance_infos', () => {
    const r: BalanceResult = parseDeepSeek({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '110.00' }],
    });
    expect(r.supported).toBe(true);
    expect(r.remaining).toBeCloseTo(110);
    expect(r.unit).toBe('CNY');
    expect(r.isValid).toBe(true);
  });

  it('parses SiliconFlow data.totalBalance', () => {
    const r = parseSiliconFlow({ code: 20000, data: { totalBalance: '88.88' } });
    expect(r.remaining).toBeCloseTo(88.88);
  });

  it('parses OpenRouter credits = total - usage', () => {
    const r = parseOpenRouter({ data: { total_credits: 10, total_usage: 3 } });
    expect(r.remaining).toBeCloseTo(7);
    expect(r.total).toBeCloseTo(10);
    expect(r.used).toBeCloseTo(3);
  });

  it('parses one-api billing subscription + usage', () => {
    const r = parseOneApiBilling(
      { hard_limit_usd: 100 },
      { total_usage: 2500 }, // usage endpoint reports cents
    );
    // remaining = hard_limit - usage(美元)。total_usage in cents → 25 USD used.
    expect(r.total).toBeCloseTo(100);
    expect(r.used).toBeCloseTo(25);
    expect(r.remaining).toBeCloseTo(75);
  });

  it('reports quota without remaining when usage endpoint is unavailable', () => {
    const r = parseOneApiBilling({ hard_limit_usd: 100 }, null);
    expect(r.total).toBeCloseTo(100);
    expect(r.used).toBeUndefined();
    expect(r.remaining).toBeUndefined();
    expect(r.isValid).toBeUndefined();
  });

  it('marks invalid balance when remaining <= 0', () => {
    const r = parseOpenRouter({ data: { total_credits: 5, total_usage: 5 } });
    expect(r.isValid).toBe(false);
  });
});
