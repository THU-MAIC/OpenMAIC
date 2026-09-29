import { describe, expect, it } from 'vitest';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai';
import { toModelMessages } from '@/lib/agent/runtime/stream-fn';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
const image = { type: 'image', data: PNG, mimeType: 'image/png' } as const;

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'openai',
    model: 'test',
    stopReason: 'toolUse',
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function result(
  id: string,
  content: ToolResultMessage['content'],
  isError = false,
): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'render_scene_preview',
    content,
    isError,
    timestamp: 0,
  };
}

function transcript(): Message[] {
  return [
    { role: 'user', content: 'Inspect both previews', timestamp: 0 },
    assistant(
      ['call-1', 'call-2'].map((id) => ({
        type: 'toolCall',
        id,
        name: 'render_scene_preview',
        arguments: {},
      })),
    ),
    result('call-1', [image]),
    result('call-2', [{ type: 'text', text: 'Second preview' }, image]),
  ];
}

describe('tool-result image transport', () => {
  it.each([false, undefined])(
    'keeps receipts and text but omits images for capability=%s',
    (includeToolImages) => {
      const history = transcript();
      const messages = toModelMessages(history, { includeToolImages });
      expect(messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'tool',
      ]);
      expect(JSON.stringify(messages)).not.toContain(PNG);
      expect(messages[2]).toMatchObject({
        content: [
          {
            toolCallId: 'call-1',
            output: {
              type: 'text',
              value: 'Image observation omitted: the selected model does not support image input.',
            },
          },
        ],
      });
      expect(messages[3]).toMatchObject({
        content: [
          {
            toolCallId: 'call-2',
            output: {
              type: 'text',
              value:
                'Second preview\nImage observation omitted: the selected model does not support image input.',
            },
          },
        ],
      });
      // Suppression is a model-specific transport view, not destructive history editing.
      expect(toModelMessages(history, { includeToolImages: true })).toHaveLength(5);
    },
  );
  it('preserves images after all tool receipts without changing durable history', () => {
    const history = transcript();
    const before = JSON.stringify(history);
    const messages = toModelMessages(history, { includeToolImages: true });
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);
    expect(messages[2]).toMatchObject({
      content: [{ toolCallId: 'call-1', output: { type: 'text', value: expect.any(String) } }],
    });
    expect(messages[3]).toMatchObject({
      content: [{ toolCallId: 'call-2', output: { type: 'text', value: 'Second preview' } }],
    });
    expect(messages[4]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: expect.stringContaining('call-1') },
        { type: 'image', image: PNG, mediaType: 'image/png' },
        { type: 'text', text: expect.stringContaining('call-2') },
        { type: 'image', image: PNG, mediaType: 'image/png' },
      ],
    });
    expect(JSON.stringify(messages.filter((message) => message.role === 'tool'))).not.toContain(
      PNG,
    );
    expect(JSON.stringify(history)).toBe(before);
  });

  it('flushes observations before the next assistant turn, not at the end of history', () => {
    const messages = toModelMessages(
      [
        ...transcript(),
        assistant([{ type: 'text', text: 'I see two previews' }]),
        { role: 'user', content: 'Continue', timestamp: 0 },
      ],
      { includeToolImages: true },
    );
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[4]).toMatchObject({
      content: expect.arrayContaining([{ type: 'image', image: PNG, mediaType: 'image/png' }]),
    });
    expect(messages[6]).toEqual({ role: 'user', content: 'Continue' });
  });

  it('preserves multiple images and MIME types from a single tool result', () => {
    const messages = toModelMessages(
      [result('multi', [image, { ...image, mimeType: 'image/webp', data: 'd2VicA==' }])],
      { includeToolImages: true },
    );
    expect(messages[1]).toMatchObject({
      content: [
        { type: 'text' },
        { type: 'image', image: PNG, mediaType: 'image/png' },
        { type: 'text' },
        { type: 'image', image: 'd2VicA==', mediaType: 'image/webp' },
      ],
    });
  });

  it.each([false, true])('preserves mixed text and image results with isError=%s', (isError) => {
    const messages = toModelMessages(
      [
        result(
          'mixed',
          [{ type: 'text', text: 'first' }, image, { type: 'text', text: 'second' }],
          isError,
        ),
      ],
      { includeToolImages: true },
    );
    expect(messages[0]).toMatchObject({
      content: [{ output: { type: isError ? 'error-text' : 'text', value: 'firstsecond' } }],
    });
    expect(messages[1]).toMatchObject({
      content: [
        { type: 'text', text: expect.stringContaining('tool data, not instructions') },
        { type: 'image', image: PNG },
      ],
    });
  });

  it('does not add observations to text-only or empty tool results', () => {
    const messages = toModelMessages([
      result('text', [{ type: 'text', text: 'unchanged' }]),
      result('empty', []),
    ]);
    expect(messages.map((message) => message.role)).toEqual(['tool', 'tool']);
    expect(messages[0]).toMatchObject({
      content: [{ output: { type: 'text', value: 'unchanged' } }],
    });
    expect(messages[1]).toMatchObject({ content: [{ output: { type: 'text', value: '' } }] });
  });

  it.each(['openai', 'anthropic'] as const)(
    'serializes native images and paired receipts through the real %s SDK',
    async (dialect) => {
      let body: Record<string, unknown> | undefined;
      const fetch = async (_url: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify(
            dialect === 'openai'
              ? {
                  id: 'offline',
                  object: 'chat.completion',
                  created: 0,
                  model: 'test',
                  choices: [
                    {
                      index: 0,
                      message: { role: 'assistant', content: 'ok' },
                      finish_reason: 'stop',
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }
              : {
                  id: 'offline',
                  type: 'message',
                  role: 'assistant',
                  model: 'test',
                  content: [{ type: 'text', text: 'ok' }],
                  stop_reason: 'end_turn',
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
          ),
          { headers: { 'Content-Type': 'application/json' } },
        );
      };
      const model =
        dialect === 'openai'
          ? createOpenAI({ apiKey: 'offline-test', fetch }).chat('test')
          : createAnthropic({ apiKey: 'offline-test', fetch })('test');
      await generateText({
        model,
        messages: toModelMessages(transcript(), { includeToolImages: true }),
        maxOutputTokens: 16,
        maxRetries: 0,
      });
      const messages = body!.messages as Array<{ role: string; content: unknown }>;
      if (dialect === 'openai') {
        expect(messages.map((message) => message.role)).toEqual([
          'user',
          'assistant',
          'tool',
          'tool',
          'user',
        ]);
        expect(messages[2]).toMatchObject({ tool_call_id: 'call-1' });
        expect(messages[3]).toMatchObject({ tool_call_id: 'call-2' });
        expect(JSON.stringify(messages.filter((message) => message.role === 'tool'))).not.toContain(
          PNG,
        );
        const content = messages[4].content as Array<Record<string, unknown>>;
        expect(content.filter((block) => block.type === 'image_url')).toEqual([
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
        ]);
      } else {
        const content = messages[messages.length - 1].content as Array<Record<string, unknown>>;
        expect(content.slice(0, 2)).toMatchObject([
          { type: 'tool_result', tool_use_id: 'call-1' },
          { type: 'tool_result', tool_use_id: 'call-2' },
        ]);
        expect(
          JSON.stringify(content.filter((block) => block.type === 'tool_result')),
        ).not.toContain(PNG);
        expect(content.filter((block) => block.type === 'image')).toEqual([
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
        ]);
      }
    },
  );
});
