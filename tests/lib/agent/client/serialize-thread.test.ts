import { describe, expect, it } from 'vitest';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { serializeThread, deserializeThread } from '@/lib/agent/client/serialize-thread';

describe('serializeThread / deserializeThread', () => {
  it('round-trips text user + assistant turns', () => {
    const messages: ThreadMessageLike[] = [
      { role: 'user', id: 'u1', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'hi there' }] },
    ];
    const restored = deserializeThread(serializeThread(messages));
    expect(restored).toHaveLength(2);
    expect(restored[0].role).toBe('user');
    expect((restored[0].content as unknown as { text: string }[])[0].text).toBe('hello');
    expect((restored[1].content as unknown as { text: string }[])[0].text).toBe('hi there');
    expect(restored[1].status).toEqual({ type: 'complete', reason: 'stop' });
    // assistant-ui throws if a user message carries a status — it must be unset.
    expect(restored[0].status).toBeUndefined();
  });

  it('keeps tool-call metadata but strips heavy result element data', () => {
    const messages: ThreadMessageLike[] = [
      {
        role: 'assistant',
        id: 'a1',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'regenerate_scene',
            args: { sceneId: 's1', instruction: 'condense' },
            result: {
              content: [{ type: 'text', text: 'done' }],
              details: {
                sceneId: 's1',
                content: {
                  elements: [
                    { id: 'e1', type: 'image', src: 'data:image/png;base64,AAAA…huge' },
                    { id: 'e2', type: 'text', content: 'x'.repeat(5000) },
                  ],
                },
                actions: [{ type: 'speech', extra: 'dropme' }],
              },
            },
          },
        ] as ThreadMessageLike['content'],
      },
    ];
    const slim = serializeThread(messages);
    const part = slim[0].content[0];
    expect(part.type).toBe('tool-call');
    if (part.type !== 'tool-call') throw new Error('expected tool-call');
    expect(part.toolName).toBe('regenerate_scene');
    expect(part.args).toEqual({ sceneId: 's1', instruction: 'condense' });
    // element count preserved, element payload (incl base64) dropped
    expect(part.result?.details?.content).toEqual({ elements: [{}, {}] });
    const json = JSON.stringify(slim);
    expect(json).not.toContain('base64');
    expect(json.length).toBeLessThan(400);
    // action types kept, extra fields dropped
    expect(part.result?.details?.actions).toEqual([{ type: 'speech' }]);
  });

  it('preserves details.content === null (failure marker)', () => {
    const messages: ThreadMessageLike[] = [
      {
        role: 'assistant',
        id: 'a1',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'regenerate_scene',
            args: { sceneId: 's1' },
            result: {
              content: [{ type: 'text', text: 'refused' }],
              details: { sceneId: 's1', content: null },
            },
          },
        ] as ThreadMessageLike['content'],
      },
    ];
    const part = serializeThread(messages)[0].content[0];
    if (part.type !== 'tool-call') throw new Error('expected tool-call');
    expect(part.result?.details?.content).toBeNull();
  });

  it('round-trips a reasoning part with its duration', () => {
    const messages: ThreadMessageLike[] = [
      {
        role: 'assistant',
        id: 'a1',
        content: [
          { type: 'reasoning', text: 'let me think' },
          { type: 'text', text: 'answer' },
        ] as ThreadMessageLike['content'],
      },
    ];
    const slim = serializeThread(messages, () => 1500);
    expect(slim[0].content[0]).toEqual({
      type: 'reasoning',
      text: 'let me think',
      durationMs: 1500,
    });
    const restored = deserializeThread(slim);
    const parts = restored[0].content as unknown as { type: string; text?: string }[];
    expect(parts[0]).toEqual({ type: 'reasoning', text: 'let me think' });
    expect(parts[1]).toEqual({ type: 'text', text: 'answer' });
  });

  it('preserves edit_interactive_html success markers (html applied + editCount)', () => {
    const messages: ThreadMessageLike[] = [
      {
        role: 'assistant',
        id: 'a1',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'edit_interactive_html',
            args: { sceneId: 's1' },
            result: { details: { sceneId: 's1', html: '<html>…huge 745kb…</html>', editCount: 3 } },
          },
        ] as ThreadMessageLike['content'],
      },
    ];
    const slim = serializeThread(messages);
    const part = slim[0].content[0];
    if (part.type !== 'tool-call') throw new Error('expected tool-call');
    // html replaced by a non-null placeholder (success survives, payload dropped)
    expect(typeof part.result?.details?.html).toBe('string');
    expect(part.result?.details?.editCount).toBe(3);
    expect(JSON.stringify(slim).length).toBeLessThan(300);
  });

  it('preserves edit_interactive_html refusal (html === null)', () => {
    const messages: ThreadMessageLike[] = [
      {
        role: 'assistant',
        id: 'a1',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'edit_interactive_html',
            args: { sceneId: 's1' },
            result: { details: { sceneId: 's1', html: null, editCount: 0 } },
          },
        ] as ThreadMessageLike['content'],
      },
    ];
    const part = serializeThread(messages)[0].content[0];
    if (part.type !== 'tool-call') throw new Error('expected tool-call');
    expect(part.result?.details?.html).toBeNull();
  });

  it('preserves edit_elements success markers (intents applied + updateCount)', () => {
    const messages: ThreadMessageLike[] = [
      {
        role: 'assistant',
        id: 'a1',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'edit_elements',
            args: { sceneId: 's1', instruction: 'make title blue' },
            result: {
              details: {
                sceneId: 's1',
                intents: [{ type: 'element.update', id: 't1', props: { defaultColor: '#00f' } }],
                updateCount: 1,
              },
            },
          },
        ] as ThreadMessageLike['content'],
      },
    ];
    const slim = serializeThread(messages);
    const part = slim[0].content[0];
    if (part.type !== 'tool-call') throw new Error('expected tool-call');
    expect(Array.isArray(part.result?.details?.intents)).toBe(true);
    expect(part.result?.details?.intents).toHaveLength(1);
    expect(part.result?.details?.updateCount).toBe(1);
    // props payload dropped
    expect(JSON.stringify(part.result?.details?.intents)).not.toContain('defaultColor');
  });

  it('preserves edit_elements refusal (intents === null)', () => {
    const messages: ThreadMessageLike[] = [
      {
        role: 'assistant',
        id: 'a1',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'edit_elements',
            args: { sceneId: 's1' },
            result: { details: { sceneId: 's1', intents: null, updateCount: 0 } },
          },
        ] as ThreadMessageLike['content'],
      },
    ];
    const part = serializeThread(messages)[0].content[0];
    if (part.type !== 'tool-call') throw new Error('expected tool-call');
    expect(part.result?.details?.intents).toBeNull();
  });

  it('drops messages with no renderable content', () => {
    const messages: ThreadMessageLike[] = [
      { role: 'assistant', id: 'a1', content: [] },
      { role: 'user', id: 'u1', content: [{ type: 'text', text: 'kept' }] },
    ];
    expect(serializeThread(messages)).toHaveLength(1);
  });

  it('deserialize handles undefined / empty', () => {
    expect(deserializeThread(undefined)).toEqual([]);
    expect(deserializeThread([])).toEqual([]);
  });
});
