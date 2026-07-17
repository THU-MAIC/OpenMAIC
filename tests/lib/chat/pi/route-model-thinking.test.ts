import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const PI_CHAT_FLAG = 'NEXT_PUBLIC_PI_CHAT_ENABLED';
let originalPiChatFlag: string | undefined;

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  runPiDirectorLoop: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModel: mocks.resolveModel,
}));

vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers')>();
  return {
    ...actual,
    isProviderKeyRequired: vi.fn(() => false),
  };
});

vi.mock('@/lib/chat/pi/director-loop', () => ({
  runPiDirectorLoop: mocks.runPiDirectorLoop,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new Request('http://localhost/api/chat/pi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function makeBody() {
  return {
    messages: [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Explain city cooling.' }],
      },
    ],
    storeState: {
      stage: { id: 'stage-1', name: 'City Cooling', whiteboard: [] },
      scenes: [
        {
          id: 'scene-1',
          title: 'Cooling',
          type: 'slide',
          content: { type: 'slide', canvas: { elements: [] } },
        },
      ],
      currentSceneId: 'scene-1',
      mode: 'autonomous',
      whiteboardOpen: false,
    },
    config: {
      agentIds: ['default-1'],
      agentConfigs: [
        {
          id: 'default-1',
          name: 'Teacher',
          role: 'teacher',
          persona: 'You teach clearly.',
          priority: 10,
          avatar: '',
          color: '#3366ff',
          allowedActions: [],
        },
      ],
    },
    apiKey: 'client-key',
    model: 'client:model',
    thinkingConfig: { enabled: true, level: 'high' },
  };
}

describe('POST /api/chat/pi model and thinking resolution', () => {
  beforeEach(() => {
    originalPiChatFlag = process.env[PI_CHAT_FLAG];
    process.env[PI_CHAT_FLAG] = 'true';
    vi.resetModules();
    mocks.resolveModel.mockReset();
    mocks.runPiDirectorLoop.mockReset();
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      apiKey: 'resolved-key',
      providerId: 'test-provider',
      modelInfo: { outputWindow: 4096 },
      thinkingConfig: { enabled: false },
    });
    mocks.runPiDirectorLoop.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalPiChatFlag === undefined) {
      delete process.env[PI_CHAT_FLAG];
    } else {
      process.env[PI_CHAT_FLAG] = originalPiChatFlag;
    }
  });

  it('returns 404 without invoking the runtime when the feature flag is disabled', async () => {
    delete process.env[PI_CHAT_FLAG];
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(makeBody()));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'Pi chat runtime is disabled',
    });
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.runPiDirectorLoop).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed agentIds value before resolving a model', async () => {
    const body = makeBody();
    body.config.agentIds = 'default-1' as never;
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'config.agentIds must be a non-empty array of unique, non-empty strings',
    });
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.runPiDirectorLoop).not.toHaveBeenCalled();
  });

  it('returns 400 when only some requested agent IDs resolve', async () => {
    const body = makeBody();
    body.config.agentIds.push('missing-agent');
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'Unknown classroom agents in config.agentIds: missing-agent',
    });
    expect(mocks.runPiDirectorLoop).not.toHaveBeenCalled();
  });

  it('resolves through chat-adapter and passes the resolved thinking config into Pi runtime', async () => {
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(makeBody()));
    await response.text();

    expect(response.status).toBe(200);
    expect(mocks.resolveModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelString: 'client:model',
        stage: 'chat-adapter',
        apiKey: 'client-key',
        thinkingConfig: { enabled: true, level: 'high' },
      }),
    );
    expect(mocks.runPiDirectorLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        languageModel: { id: 'language-model' },
        thinkingConfig: { enabled: false },
        maxOutputTokens: 4096,
      }),
    );
  });
});
