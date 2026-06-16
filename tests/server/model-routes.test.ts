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
    vi.doMock('@/lib/logger', () => ({ createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
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
    vi.doMock('@/lib/logger', () => ({ createLogger: () => ({ error, info: vi.fn(), warn: vi.fn(), debug: vi.fn() }) }));
    process.env.MODEL_ROUTES = '{not valid json';
    const { getStageModel } = await import('@/lib/server/model-routes');
    expect(getStageModel('scene-content')).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it('ignores non-string route values', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 123, 'pbl-chat': 'anthropic:claude-sonnet-4' });
    const { getStageModel } = await import('@/lib/server/model-routes');
    expect(getStageModel('scene-content')).toBeUndefined();
    expect(getStageModel('pbl-chat')).toBe('anthropic:claude-sonnet-4');
  });

  it('exposes the routable stage registry', async () => {
    const { LLM_STAGES } = await import('@/lib/server/model-routes');
    expect(LLM_STAGES).toEqual(
      expect.arrayContaining([
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
