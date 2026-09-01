import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { createCodexLanguageModel, promptToCodexInput } from '@/lib/server/codex/language-model';
import type {
  CodexAppServer,
  CodexNotificationHandler,
} from '@/lib/server/codex/app-server-client';

const prompt = [
  {
    role: 'system' as const,
    content: 'Be concise.',
  },
  {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'Say hello.' }],
  },
];

class FakeCodexAppServer implements CodexAppServer {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly handlers = new Set<CodexNotificationHandler>();

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === 'account/read') {
      return { account: { type: 'chatgpt', email: 'test@example.com', planType: 'plus' } } as T;
    }
    if (method === 'thread/start') return { thread: { id: 'thread-1' } } as T;
    if (method === 'turn/interrupt') return {} as T;
    if (method !== 'turn/start') throw new Error(`Unexpected request: ${method}`);

    queueMicrotask(() => {
      this.emit('item/started', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'message-1', type: 'agentMessage', phase: 'final_answer', text: '' },
      });
      this.emit('item/agentMessage/delta', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'message-1',
        delta: 'Hel',
      });
      this.emit('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'message-1',
          type: 'agentMessage',
          phase: 'final_answer',
          text: 'Hello',
        },
      });
      this.emit('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          last: {
            inputTokens: 12,
            cachedInputTokens: 2,
            cacheWriteInputTokens: 1,
            outputTokens: 5,
            reasoningOutputTokens: 1,
          },
        },
      });
      this.emit('turn/completed', {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [
            {
              id: 'message-1',
              type: 'agentMessage',
              phase: 'final_answer',
              text: 'Hello',
            },
          ],
        },
      });
    });
    return { turn: { id: 'turn-1' } } as T;
  }

  onNotification(handler: CodexNotificationHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(method: string, params: unknown) {
    for (const handler of this.handlers) handler(method, params);
  }
}

function options(overrides: Partial<LanguageModelV3CallOptions> = {}): LanguageModelV3CallOptions {
  return { prompt, ...overrides } as LanguageModelV3CallOptions;
}

async function readStream(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const parts: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

describe('Codex LanguageModelV3 adapter', () => {
  beforeEach(() => vi.stubEnv('CODEX_PROVIDER_ENABLED', 'true'));
  afterEach(() => vi.unstubAllEnvs());

  it('runs an isolated ephemeral turn and maps final text and token usage', async () => {
    const client = new FakeCodexAppServer();
    const model = createCodexLanguageModel('gpt-5.6-sol', client);
    const schema = {
      type: 'object' as const,
      properties: { answer: { type: 'string' as const } },
      required: ['answer'],
      additionalProperties: false,
    };

    const result = await model.doGenerate(options({ responseFormat: { type: 'json', schema } }));

    expect(result.content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(result.finishReason).toMatchObject({ unified: 'stop', raw: 'completed' });
    expect(result.usage).toMatchObject({
      inputTokens: { total: 12, noCache: 9, cacheRead: 2, cacheWrite: 1 },
      outputTokens: { total: 5, text: 4, reasoning: 1 },
    });

    const thread = client.requests.find((request) => request.method === 'thread/start')?.params;
    expect(thread).toMatchObject({
      model: 'gpt-5.6-sol',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: {
        web_search: 'disabled',
        include_apps_instructions: false,
        include_environment_context: false,
        include_permissions_instructions: false,
        project_doc_max_bytes: 0,
        features: {
          apps: false,
          browser_use: false,
          computer_use: false,
          multi_agent: false,
          plugins: false,
          shell_tool: false,
          unified_exec: false,
          view_image: false,
        },
      },
      ephemeral: true,
      environments: [],
      dynamicTools: [],
      runtimeWorkspaceRoots: [],
    });
    const turn = client.requests.find((request) => request.method === 'turn/start')?.params;
    expect(turn).toMatchObject({
      threadId: 'thread-1',
      model: 'gpt-5.6-sol',
      outputSchema: schema,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      environments: [],
      runtimeWorkspaceRoots: [],
    });
    expect(JSON.stringify(turn)).toContain('SYSTEM:\\nBe concise.');
    expect(JSON.stringify(turn)).toContain('USER:\\nSay hello.');
  });

  it('maps App Server deltas to the AI SDK stream contract', async () => {
    const client = new FakeCodexAppServer();
    const model = createCodexLanguageModel('gpt-5.6-sol', client);

    const result = await model.doStream(options({ temperature: 0.2 }));
    const parts = await readStream(result.stream);

    expect(parts).toEqual([
      {
        type: 'stream-start',
        warnings: [expect.objectContaining({ type: 'unsupported', feature: 'temperature' })],
      },
      { type: 'text-start', id: 'codex-text' },
      { type: 'text-delta', id: 'codex-text', delta: 'Hel' },
      { type: 'text-delta', id: 'codex-text', delta: 'lo' },
      { type: 'text-end', id: 'codex-text' },
      expect.objectContaining({
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'completed' },
      }),
    ]);
  });

  it('rejects OpenMAIC tool calls before creating a Codex thread', async () => {
    const client = new FakeCodexAppServer();
    const model = createCodexLanguageModel('gpt-5.6-sol', client);

    await expect(
      model.doGenerate(
        options({
          tools: [{ type: 'function', name: 'search', inputSchema: { type: 'object' } }],
        }),
      ),
    ).rejects.toThrow(/does not support OpenMAIC tool calls/);
    expect(client.requests).toHaveLength(0);
  });

  it('serializes images and warns for unsupported non-image attachments', () => {
    const converted = promptToCodexInput([
      {
        role: 'user',
        content: [
          { type: 'file', mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) },
          { type: 'file', mediaType: 'application/pdf', data: 'cGRm' },
        ],
      },
    ]);

    expect(converted.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image', url: 'data:image/png;base64,AQID' }),
      ]),
    );
    expect(converted.warnings).toEqual([
      expect.objectContaining({ type: 'unsupported', feature: 'file input (application/pdf)' }),
    ]);
  });
});
