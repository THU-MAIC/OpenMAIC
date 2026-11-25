import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseDeepseekBalance } from '@/lib/server/plan-status/deepseek';
import { parseKimiUsages } from '@/lib/server/plan-status/kimi';
import { parseMinimaxRemains } from '@/lib/server/plan-status/minimax';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/media-provider-fetch', () => ({ mediaProviderFetch: fetchMock }));

/** An international Go plan, as `GET /v1/token_plan/remains` answered it. */
const GO_PLAN = {
  model_remains: [
    {
      start_time: 1795455282678,
      end_time: 1795473282678,
      remains_time: 17999993,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      model_name: 'general',
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      weekly_start_time: 1795027746557,
      weekly_end_time: 1795632546557,
      weekly_remains_time: 177263872,
      current_interval_status: 1,
      current_interval_remaining_percent: 100,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 97,
    },
  ],
  base_resp: { status_code: 0, status_msg: 'success' },
};

const counted = (
  model_name: string,
  fields: Record<string, number> = {},
): Record<string, unknown> => ({
  model_name,
  start_time: 0,
  end_time: 5 * 3_600_000,
  current_interval_total_count: 100,
  current_interval_usage_count: 40,
  current_interval_status: 1,
  current_weekly_total_count: 500,
  current_weekly_usage_count: 100,
  current_weekly_status: 1,
  weekly_end_time: 7 * 86_400_000,
  ...fields,
});

describe('MiniMax remains', () => {
  it('reads a plan without a video bucket as one without video', () => {
    const status = parseMinimaxRemains(GO_PLAN)!;
    expect(status.unsupported).toEqual(['video']);
    expect(status.quota).toEqual({
      status: 'available',
      balances: [],
      windows: [
        {
          period: 'hours',
          hours: 5,
          remainingPercent: 100,
          resetsAt: new Date(1795473282678).toISOString(),
        },
        {
          period: 'week',
          remainingPercent: 97,
          resetsAt: new Date(1795632546557).toISOString(),
        },
      ],
    });
  });

  it('keeps video when the plan has a video bucket, even one used up', () => {
    const status = parseMinimaxRemains({
      model_remains: [counted('general'), counted('video', { current_interval_status: 2 })],
      base_resp: { status_code: 0 },
    })!;
    expect(status.unsupported).toEqual([]);
    const video = status.quota.status === 'available' ? status.quota.windows[2] : undefined;
    expect(video).toMatchObject({ category: 'video', period: 'hours', remainingPercent: 0 });
  });

  it('reads a video bucket with both windows unlimited and no totals as not included', () => {
    const status = parseMinimaxRemains({
      model_remains: [
        counted('general'),
        counted('video', {
          current_interval_total_count: 0,
          current_weekly_total_count: 0,
          current_interval_status: 3,
          current_weekly_status: 3,
        }),
      ],
      base_resp: { status_code: 0 },
    })!;
    expect(status.unsupported).toEqual(['video']);
    if (status.quota.status !== 'available') throw new Error('expected a quota');
    expect(status.quota.windows.map((window) => window.category)).toEqual([undefined, undefined]);
  });

  it('reads counts the way the remaining percentage agrees with', () => {
    const asUsed = parseMinimaxRemains({
      model_remains: [counted('general', { current_interval_remaining_percent: 60 })],
      base_resp: { status_code: 0 },
    })!;
    const asRemaining = parseMinimaxRemains({
      model_remains: [counted('general', { current_interval_remaining_percent: 40 })],
      base_resp: { status_code: 0 },
    })!;
    const first = (status: typeof asUsed) =>
      status.quota.status === 'available' ? status.quota.windows[0] : undefined;
    expect(first(asUsed)).toMatchObject({ used: 40, total: 100, remainingPercent: 60 });
    expect(first(asRemaining)).toMatchObject({ used: 60, total: 100, remainingPercent: 40 });
    // No percentage: the counts are remaining calls, as older answers report them.
    const legacy = parseMinimaxRemains({
      model_remains: [counted('general')],
      base_resp: { status_code: 0 },
    })!;
    expect(first(legacy)).toMatchObject({ used: 60, total: 100, remainingPercent: 40 });
  });

  it('applies the weekly boost to the weekly share left, as the CLI does', () => {
    const windows = (fields: Record<string, number>) => {
      const status = parseMinimaxRemains({
        model_remains: [
          counted('general', {
            current_interval_remaining_percent: 60,
            current_weekly_remaining_percent: 80,
            ...fields,
          }),
        ],
        base_resp: { status_code: 0 },
      })!;
      return status.quota.status === 'available' ? status.quota.windows : [];
    };
    // 80% of the base left with a 1.5x boost: 120% left. The short window is not boosted,
    // and the counts are still read against the base share.
    const [short, weekly] = windows({ weekly_boost_permille: 1500 });
    expect(short).toMatchObject({ period: 'hours', remainingPercent: 60 });
    expect(weekly).toMatchObject({ period: 'week', remainingPercent: 120, used: 100, total: 500 });
    // No boost field: the base share as reported.
    expect(windows({})[1]).toMatchObject({ remainingPercent: 80 });
    // An exhausted window stays exhausted, whatever the boost.
    expect(windows({ weekly_boost_permille: 1500, current_weekly_status: 2 })[1]).toMatchObject({
      remainingPercent: 0,
    });
  });

  it('says nothing about video when the answer is not one it knows', () => {
    const answer = (model_remains: unknown[]) =>
      parseMinimaxRemains({ model_remains, base_resp: { status_code: 0 } });
    // Nothing it can read: no quota to show (unavailable) and nothing about video.
    expect(answer([{ model_name: 'future' }])).toBeUndefined();
    expect(answer([{ model_name: 'general' }])).toBeUndefined();
    expect(
      answer([counted('general', { current_interval_status: 99, current_weekly_status: 99 })]),
    ).toBeUndefined();
    // A readable general bucket beside a video bucket it cannot read: the quota
    // shows, video stays as declared.
    const partial = answer([counted('general'), { model_name: 'video' }])!;
    expect(partial.unsupported).toBeUndefined();
    expect(partial.quota.status).toBe('available');
    // A general bucket with a status it does not know beside a readable one.
    expect(
      answer([counted('general', { current_weekly_status: 99 }), counted('video')])!.unsupported,
    ).toBeUndefined();
  });

  it('does not read an error or an unknown answer', () => {
    expect(parseMinimaxRemains({ base_resp: { status_code: 1004 } })).toBeUndefined();
    expect(
      parseMinimaxRemains({ model_remains: [], base_resp: { status_code: 0 } }),
    ).toBeUndefined();
    expect(parseMinimaxRemains('nope')).toBeUndefined();
  });
});

describe('Kimi usages', () => {
  it('reads the share used of each allowance, without capabilities', () => {
    const status = parseKimiUsages({
      limits: [{ window: { duration: 300 }, detail: { limit: '100', remaining: '100' } }],
      usages: {
        limit_5h: { used_ratio: 0, reset_time: '2026-11-23T22:33:59Z' },
        limit_month_total: { used_ratio: 0.0258, reset_time: '2026-12-19T00:00:00Z' },
        limit_month_code: { used_ratio: 0.0258, reset_time: '2026-12-19T00:00:00Z' },
      },
    })!;
    expect(status.unsupported).toBeUndefined();
    expect(status.quota).toEqual({
      status: 'available',
      balances: [],
      windows: [
        { period: 'hours', hours: 5, remainingPercent: 100, resetsAt: '2026-11-23T22:33:59Z' },
        { period: 'month', remainingPercent: 97.42, resetsAt: '2026-12-19T00:00:00Z' },
      ],
    });
  });

  it('does not read an answer without usages', () => {
    expect(parseKimiUsages({ error: { message: 'not found' } })).toBeUndefined();
  });
});

describe('DeepSeek balance', () => {
  it('reads the balance per currency, with no window to reset', () => {
    const status = parseDeepseekBalance({
      is_available: true,
      balance_infos: [
        {
          currency: 'USD',
          total_balance: '0.00',
          granted_balance: '0.00',
          topped_up_balance: '0.00',
        },
        {
          currency: 'CNY',
          total_balance: '12.34',
          granted_balance: '0.00',
          topped_up_balance: '12.34',
        },
      ],
    })!;
    expect(status).toEqual({
      quota: {
        status: 'available',
        windows: [],
        balances: [
          { currency: 'USD', amount: '0.00' },
          { currency: 'CNY', amount: '12.34' },
        ],
      },
    });
  });
});

describe('fetchPlanStatus', () => {
  afterEach(() => fetchMock.mockReset());

  it("asks the plan's own site with the key, and reads its answer", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(GO_PLAN), { status: 200 }));
    const { fetchPlanStatus } = await import('@/lib/server/plan-status');
    const status = await fetchPlanStatus('minimax-intl', 'sk-cp-go');
    expect(status.unsupported).toEqual(['video']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.minimax.io/v1/token_plan/remains');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer sk-cp-go');
  });

  it('answers unavailable, without capabilities, when the vendor refuses or fails', async () => {
    const { fetchPlanStatus } = await import('@/lib/server/plan-status');
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    expect(await fetchPlanStatus('minimax-intl', 'sk-bad')).toEqual({
      quota: { status: 'unavailable' },
    });
    fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    expect(await fetchPlanStatus('kimi-coding-plan', 'sk-kimi')).toEqual({
      quota: { status: 'unavailable' },
    });
  });

  it('does not ask about a plan whose vendor has no query', async () => {
    const { fetchPlanStatus, hasPlanStatus } = await import('@/lib/server/plan-status');
    expect(hasPlanStatus('volcengine-ark')).toBe(false);
    expect(hasPlanStatus('tokendance')).toBe(false);
    expect(hasPlanStatus('deepseek-token-plan')).toBe(true);
    // Only MiniMax's answer says what a plan lacks: saving another plan's key asks nothing.
    const { reportsPlanCapabilities } = await import('@/lib/server/plan-status');
    expect(reportsPlanCapabilities('minimax-intl')).toBe(true);
    expect(reportsPlanCapabilities('kimi-coding-plan')).toBe(false);
    expect(await fetchPlanStatus('volcengine-ark', 'k')).toEqual({
      quota: { status: 'unavailable' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
