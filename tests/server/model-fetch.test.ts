import { describe, expect, it } from 'vitest';
import { buildModelsUrlCandidates } from '@/lib/server/model-fetch';

describe('buildModelsUrlCandidates', () => {
  it('plain root → /v1/models', () => {
    expect(buildModelsUrlCandidates('https://api.siliconflow.cn')).toEqual([
      'https://api.siliconflow.cn/v1/models',
    ]);
  });

  it('strips a trailing slash', () => {
    expect(buildModelsUrlCandidates('https://api.example.com/')).toEqual([
      'https://api.example.com/v1/models',
    ]);
  });

  it('base ending in /v1 → {base}/models (no double /v1)', () => {
    expect(buildModelsUrlCandidates('https://api.example.com/v1')).toEqual([
      'https://api.example.com/v1/models',
    ]);
  });

  it('zhipu coding paas/v4 → /models first, /v1/models fallback', () => {
    expect(buildModelsUrlCandidates('https://open.bigmodel.cn/api/coding/paas/v4')).toEqual([
      'https://open.bigmodel.cn/api/coding/paas/v4/models',
      'https://open.bigmodel.cn/api/coding/paas/v4/v1/models',
    ]);
  });

  it('explicit override wins and is the only candidate', () => {
    expect(
      buildModelsUrlCandidates('https://x.com/v1', {
        modelsUrlOverride: 'https://x.com/custom/models',
      }),
    ).toEqual(['https://x.com/custom/models']);
  });

  it('base ending exactly in a compat suffix → strips it and appends fallbacks', () => {
    // Suffix-strip only triggers when the base ENDS with the suffix.
    const c = buildModelsUrlCandidates('https://api.minimaxi.com/anthropic');
    // not a version segment → {base}/v1/models first
    expect(c[0]).toBe('https://api.minimaxi.com/anthropic/v1/models');
    // then stripped-suffix fallbacks
    expect(c).toContain('https://api.minimaxi.com/v1/models');
    expect(c).toContain('https://api.minimaxi.com/models');
  });

  it('base .../anthropic/v1 keeps the version segment (no strip)', () => {
    // ends in /v1, not the compat suffix → only {base}/models.
    expect(buildModelsUrlCandidates('https://api.minimaxi.com/anthropic/v1')).toEqual([
      'https://api.minimaxi.com/anthropic/v1/models',
    ]);
  });

  it('longest compat suffix wins (/api/anthropic over /anthropic)', () => {
    const c = buildModelsUrlCandidates('https://gw.example.com/api/anthropic');
    expect(c).toContain('https://gw.example.com/v1/models');
    expect(c).toContain('https://gw.example.com/models');
  });

  it('throws on empty base url', () => {
    expect(() => buildModelsUrlCandidates('   ')).toThrow();
  });

  it('dedupes candidates preserving order', () => {
    const c = buildModelsUrlCandidates('https://api.example.com');
    expect(new Set(c).size).toBe(c.length);
  });
});
