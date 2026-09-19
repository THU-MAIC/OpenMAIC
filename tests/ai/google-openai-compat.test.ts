import { beforeEach, describe, expect, it } from 'vitest';

import {
  forgetGoogleThoughtSignatures,
  isGoogleOpenAICompatUrl,
  normalizeGoogleChunk,
  normalizeGoogleToolCallStream,
  restoreGoogleThoughtSignatures,
} from '@/lib/ai/google-openai-compat';

// A chunk as streamed by the Gemini OpenAI-compatible endpoint (gemini-3.8-flash,
// workbench agent driver): no `index`, plus Google's thought signature.
type ToolCallChunk = {
  choices: Array<{
    delta: {
      role?: string;
      tool_calls: Array<{
        index?: number;
        id: string;
        type: string;
        function: { name: string; arguments: string };
        extra_content?: { google?: { thought_signature?: string } };
      }>;
    };
    index: number;
  }>;
  model: string;
  object: string;
};

const MEASURED_CHUNK: ToolCallChunk = {
  choices: [
    {
      delta: {
        role: 'assistant',
        tool_calls: [
          {
            extra_content: { google: { thought_signature: 'sig-297140' } },
            function: {
              arguments:
                '{"offset":1,"limit":100,"path":"/app/skills/agent-runtime/stage-design/SKILL.md"}',
              name: 'read',
            },
            id: 'call_297140',
            type: 'function',
          },
        ],
      },
      index: 0,
    },
  ],
  model: 'gemini-3.8-flash',
  object: 'chat.completion.chunk',
};

async function readAll(response: Response): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()));
}

describe('Gemini OpenAI-compatible shim', () => {
  beforeEach(() => {
    forgetGoogleThoughtSignatures();
  });

  it('recognises only the Gemini compat endpoint', () => {
    expect(isGoogleOpenAICompatUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
      true,
    );
    expect(isGoogleOpenAICompatUrl('https://api.openai.com/v1')).toBe(false);
    expect(
      isGoogleOpenAICompatUrl('https://generativelanguage.googleapis.com.evil.example/v1'),
    ).toBe(false);
    expect(isGoogleOpenAICompatUrl(undefined)).toBe(false);
  });

  it('adds a stable index per tool-call id and remembers the thought signature', () => {
    const indexById = new Map<string, number>();
    const a = normalizeGoogleChunk(structuredClone(MEASURED_CHUNK), indexById) as ToolCallChunk;
    expect(a.choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, id: 'call_297140' });
    // A second tool call in a later chunk gets index 1; a delta for the first keeps 0.
    const second = structuredClone(MEASURED_CHUNK);
    second.choices[0].delta.tool_calls[0].id = 'call_2';
    const b = normalizeGoogleChunk(second, indexById) as ToolCallChunk;
    expect(b.choices[0].delta.tool_calls[0].index).toBe(1);
    const again = normalizeGoogleChunk(structuredClone(MEASURED_CHUNK), indexById) as ToolCallChunk;
    expect(again.choices[0].delta.tool_calls[0].index).toBe(0);
    // An explicit index is left alone; chunks without tool calls pass through.
    const explicit = structuredClone(MEASURED_CHUNK);
    explicit.choices[0].delta.tool_calls[0].index = 7;
    expect(
      (normalizeGoogleChunk(explicit, indexById) as ToolCallChunk).choices[0].delta.tool_calls[0]
        .index,
    ).toBe(7);
    expect(normalizeGoogleChunk({ choices: [{ delta: { content: 'hi' } }] }, indexById)).toEqual({
      choices: [{ delta: { content: 'hi' } }],
    });
  });

  it('rewrites the SSE stream line by line and leaves keep-alives and [DONE] alone', async () => {
    const sse = `: keep-alive\n\ndata: ${JSON.stringify(MEASURED_CHUNK)}\n\ndata: [DONE]\n\n`;
    const response = normalizeGoogleToolCallStream(
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const out = await readAll(response);
    expect(out).toContain(': keep-alive\n');
    expect(out).toContain('data: [DONE]');
    const dataLine = out.split('\n').find((l) => l.startsWith('data: {'))!;
    const parsed = JSON.parse(dataLine.slice(6));
    expect(parsed.choices[0].delta.tool_calls[0].index).toBe(0);
    expect(parsed.choices[0].delta.tool_calls[0].function.name).toBe('read');
  });

  it('puts the remembered thought signature back on the assistant tool call of the next request', () => {
    normalizeGoogleChunk(structuredClone(MEASURED_CHUNK), new Map());
    const request = {
      messages: [
        { role: 'user', content: 'ders' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_297140', type: 'function', function: { name: 'read', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_297140', content: '…' },
      ],
    };
    const init = restoreGoogleThoughtSignatures({ body: JSON.stringify(request) });
    const body = JSON.parse(init!.body as string);
    expect(body.messages[1].tool_calls[0].extra_content).toEqual({
      google: { thought_signature: 'sig-297140' },
    });
    // Unknown ids and non-JSON bodies are untouched.
    const unknown = {
      body: JSON.stringify({ messages: [{ role: 'assistant', tool_calls: [{ id: 'x' }] }] }),
    };
    expect(restoreGoogleThoughtSignatures(unknown)).toBe(unknown);
    const raw = { body: 'not json' };
    expect(restoreGoogleThoughtSignatures(raw)).toBe(raw);
  });
});
