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
