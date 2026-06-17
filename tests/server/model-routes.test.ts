import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// model-routes reads process.env.MODEL_ROUTES once and caches the parsed map.
// Tests reset the module registry between cases via vi.resetModules() so each
// case re-reads a fresh env, mirroring the provider-config test convention.

describe('model-routes', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.MODEL_ROUTES;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.MODEL_ROUTES;
  });

  it('returns undefined for any stage when MODEL_ROUTES is unset', async () => {
    const { getStageModel } = await import('@/lib/server/model-routes');
    expect(getStageModel('scene-content')).toBeUndefined();
    expect(getStageModel('pbl-chat')).toBeUndefined();
  });

  it('returns undefined when no stage is provided', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { getStageModel } = await import('@/lib/server/model-routes');
    expect(getStageModel(undefined)).toBeUndefined();
  });

  it('returns the mapped model for a configured routable stage', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content': 'openai:gpt-5.4',
      'pbl-chat': 'anthropic:claude-sonnet-4',
    });
    const { getStageModel } = await import('@/lib/server/model-routes');
    expect(getStageModel('scene-content')).toBe('openai:gpt-5.4');
    expect(getStageModel('pbl-chat')).toBe('anthropic:claude-sonnet-4');
  });

  it('returns undefined for a routable stage that is not listed', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { getStageModel } = await import('@/lib/server/model-routes');
    expect(getStageModel('scene-actions')).toBeUndefined();
  });

  it('ignores unknown stage keys with a warning but keeps valid ones', async () => {
    const warn = vi.fn();
    vi.doMock('@/lib/logger', () => ({
      createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    process.env.MODEL_ROUTES = JSON.stringify({
      'not-a-stage': 'openai:gpt-5.4',
      'scene-content': 'openai:gpt-5.4',
    });
    const { getStageModel } = await import('@/lib/server/model-routes');
    expect(getStageModel('not-a-stage')).toBeUndefined();
    expect(getStageModel('scene-content')).toBe('openai:gpt-5.4');
    expect(warn).toHaveBeenCalled();
  });

  it('returns undefined for everything when MODEL_ROUTES is invalid JSON (no throw)', async () => {
    const error = vi.fn();
    vi.doMock('@/lib/logger', () => ({
      createLogger: () => ({ error, info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
    }));
    process.env.MODEL_ROUTES = '{not valid json';
    const { getStageModel } = await import('@/lib/server/model-routes');
    expect(getStageModel('scene-content')).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it('ignores non-string route values', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content': 123,
      'pbl-chat': 'anthropic:claude-sonnet-4',
    });
    const { getStageModel } = await import('@/lib/server/model-routes');
    expect(getStageModel('scene-content')).toBeUndefined();
    expect(getStageModel('pbl-chat')).toBe('anthropic:claude-sonnet-4');
  });

  it('resolves a composite scene-content:<type> key', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content:quiz': 'openai:gpt-5.4' });
    const { getStageModel } = await import('@/lib/server/model-routes');
    expect(getStageModel('scene-content:quiz')).toBe('openai:gpt-5.4');
  });

  it('falls back from a composite key to the base stage', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4-mini' });
    const { getStageModel } = await import('@/lib/server/model-routes');
    expect(getStageModel('scene-content:quiz')).toBe('openai:gpt-5.4-mini');
  });

  it('prefers the composite key over the base stage', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content': 'openai:gpt-5.4-mini',
      'scene-content:quiz': 'openai:gpt-5.4',
    });
    const { getStageModel } = await import('@/lib/server/model-routes');
    expect(getStageModel('scene-content:quiz')).toBe('openai:gpt-5.4');
    // a type without its own route falls back to the base scene-content route
    expect(getStageModel('scene-content:slide')).toBe('openai:gpt-5.4-mini');
  });

  it('ignores an unknown scene-content:<type> key with a warning', async () => {
    const warn = vi.fn();
    vi.doMock('@/lib/logger', () => ({
      createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content:bogus': 'openai:gpt-5.4' });
    const { getStageModel } = await import('@/lib/server/model-routes');
    expect(getStageModel('scene-content:bogus')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('parses an object route value {model, thinking} via getStageRoute', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content': { model: 'openai:gpt-5.4', thinking: { effort: 'high' } },
    });
    const { getStageRoute, getStageModel } = await import('@/lib/server/model-routes');
    expect(getStageRoute('scene-content')).toEqual({
      model: 'openai:gpt-5.4',
      thinking: { effort: 'high' },
    });
    expect(getStageModel('scene-content')).toBe('openai:gpt-5.4');
  });

  it('supports the full thinking config (budgetTokens/enabled/level/mode)', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content:interactive': {
        model: 'qwen:qwen3.7-plus',
        thinking: { enabled: true, budgetTokens: 8000 },
      },
      'scene-content:slide': { model: 'google:gemini-3-flash-preview', thinking: { level: 'low' } },
      'scene-content:quiz': {
        model: 'deepseek:deepseek-v4-pro',
        thinking: { mode: 'disabled', enabled: false },
      },
    });
    const { getStageRoute } = await import('@/lib/server/model-routes');
    expect(getStageRoute('scene-content:interactive')!.thinking).toEqual({
      enabled: true,
      budgetTokens: 8000,
    });
    expect(getStageRoute('scene-content:slide')!.thinking).toEqual({ level: 'low' });
    expect(getStageRoute('scene-content:quiz')!.thinking).toEqual({
      mode: 'disabled',
      enabled: false,
    });
  });

  it('treats a string route value as a model with no thinking', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'pbl-chat': 'anthropic:claude-sonnet-4' });
    const { getStageRoute } = await import('@/lib/server/model-routes');
    expect(getStageRoute('pbl-chat')).toEqual({ model: 'anthropic:claude-sonnet-4' });
  });

  it('drops invalid thinking fields with a warning but keeps the model', async () => {
    const warn = vi.fn();
    vi.doMock('@/lib/logger', () => ({
      createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content': {
        model: 'openai:gpt-5.4',
        thinking: { effort: 'bogus', budgetTokens: 'x' },
      },
    });
    const { getStageRoute } = await import('@/lib/server/model-routes');
    expect(getStageRoute('scene-content')).toEqual({ model: 'openai:gpt-5.4' });
    expect(warn).toHaveBeenCalled();
  });

  it('ignores an object route value with no model string', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content': { thinking: { effort: 'high' } },
    });
    const { getStageRoute } = await import('@/lib/server/model-routes');
    expect(getStageRoute('scene-content')).toBeUndefined();
  });

  it('getStageRoute returns the matched composite entry (model+thinking) as a unit', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content': { model: 'openai:gpt-5.4-mini' },
      'scene-content:quiz': { model: 'openai:gpt-5.4', thinking: { effort: 'high' } },
    });
    const { getStageRoute } = await import('@/lib/server/model-routes');
    expect(getStageRoute('scene-content:quiz')).toEqual({
      model: 'openai:gpt-5.4',
      thinking: { effort: 'high' },
    });
    // unrouted type falls back to the base entry (no thinking there)
    expect(getStageRoute('scene-content:slide')).toEqual({ model: 'openai:gpt-5.4-mini' });
  });

  it('exposes the routable stage registry', async () => {
    const { LLM_STAGES } = await import('@/lib/server/model-routes');
    expect(LLM_STAGES).toEqual(
      expect.arrayContaining([
        'scene-content:slide',
        'scene-content:quiz',
        'scene-content:interactive',
        'scene-content:pbl',
        'scene-outlines-stream',
        'scene-content',
        'scene-actions',
        'agent-profiles',
        'quiz-grade',
        'pbl-chat',
        'chat-adapter',
        'generate-classroom',
        'web-search-query-rewrite',
      ]),
    );
  });
});
