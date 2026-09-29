import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('model-routes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
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
        'chat-adapter',
        'generate-classroom',
        'web-search-query-rewrite',
        'maic-agent-driver',
        'conversation-title',
      ]),
    );
  });

  it('no longer lists stage keys nothing resolves', async () => {
    const { LLM_STAGES } = await import('@/lib/server/model-routes');
    expect(LLM_STAGES).not.toContain('pbl-chat');
    expect(LLM_STAGES).not.toContain('maic-agent');
  });

  it('parses a user route object with the full thinking config', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { parseUserStageRoutes } = await import('@/lib/server/model-routes');
    const routes = parseUserStageRoutes(
      JSON.stringify({
        'scene-content:quiz': {
          model: 'anthropic:claude-sonnet-4',
          thinking: { mode: 'enabled', budgetTokens: 2048, level: 'nope' },
        },
      }),
    );
    expect(routes['scene-content:quiz']).toEqual({
      model: 'anthropic:claude-sonnet-4',
      thinking: { mode: 'enabled', budgetTokens: 2048 },
    });
    warn.mockRestore();
  });

  it('never parses a fallback from the user x-model-routes header (the slot fallback applies)', async () => {
    const { parseUserStageRoutes } = await import('@/lib/server/model-routes');
    const routes = parseUserStageRoutes(
      JSON.stringify({
        'chat-adapter': { model: 'minimax:MiniMax-M3', fallback: 'qwen:user-fb' },
      }),
    );
    expect(routes['chat-adapter']).toEqual({ model: 'minimax:MiniMax-M3' });
    expect(routes['chat-adapter']?.fallback).toBeUndefined();
  });

  it('parses known user stages from x-model-routes and drops unknown ones', async () => {
    const { parseUserStageRoutes } = await import('@/lib/server/model-routes');
    const routes = parseUserStageRoutes(
      JSON.stringify({
        'chat-adapter': 'minimax:MiniMax-M3',
        'quiz-grade': {
          model: 'anthropic:claude-sonnet-4',
          apiKey: 'user-key',
          baseUrl: 'https://user.example/v1',
          providerType: 'anthropic',
        },
        'not-a-stage': 'openai:gpt-5.4',
      }),
    );
    expect(routes['chat-adapter']).toEqual({ model: 'minimax:MiniMax-M3' });
    expect(routes['quiz-grade']).toEqual({
      model: 'anthropic:claude-sonnet-4',
      apiKey: 'user-key',
      baseUrl: 'https://user.example/v1',
      providerType: 'anthropic',
    });
    expect(routes).not.toHaveProperty('not-a-stage');
  });

  it('returns no user routes for malformed, empty, or oversized headers', async () => {
    const { parseUserStageRoutes } = await import('@/lib/server/model-routes');
    expect(parseUserStageRoutes(undefined)).toEqual({});
    expect(parseUserStageRoutes(null)).toEqual({});
    expect(parseUserStageRoutes('not json')).toEqual({});
    expect(parseUserStageRoutes('[]')).toEqual({});
    expect(parseUserStageRoutes('x'.repeat(17 * 1024))).toEqual({});
  });

  it('resolves a composite user route from its parent key', async () => {
    const { getUserStageRoute } = await import('@/lib/server/model-routes');
    const routes = { 'pbl-v2-runtime': { model: 'anthropic:claude-sonnet-4' } };
    expect(getUserStageRoute(routes, 'pbl-v2-runtime:instructor')).toEqual({
      model: 'anthropic:claude-sonnet-4',
    });
    expect(getUserStageRoute(routes, 'chat-adapter')).toBeUndefined();
  });
});
