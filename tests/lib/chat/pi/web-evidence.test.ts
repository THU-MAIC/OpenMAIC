import { describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { withClassroomWebEvidence } from '@/lib/chat/pi/tools/web-evidence';
import type { StatelessEvent } from '@/lib/types/chat';
import {
  buildNativeWebFetchTool,
  createClassroomWebFetchContext,
} from '@/lib/chat/pi/tools/web-fetch';

function wrap(execute: AgentTool['execute'], name = 'fetch_url') {
  const send = vi.fn(async (_event: StatelessEvent) => {});
  const tool = withClassroomWebEvidence(
    { name, label: name, description: '', parameters: Type.Object({}), execute },
    'message',
    send,
  );
  const lastEvidence = () => {
    const event = send.mock.calls.at(-1)?.[0];
    return event?.type === 'web_evidence' ? event.data.evidence : undefined;
  };
  return { tool, send, lastEvidence };
}

describe('classroom tool-owned web evidence', () => {
  it('emits reading before waiting for a page, then only the retrieved range and source', async () => {
    let finish!: (value: AgentToolResult<unknown>) => void;
    const h = wrap(
      () =>
        new Promise<AgentToolResult<unknown>>((resolve) => {
          finish = resolve;
        }) as ReturnType<AgentTool['execute']>,
    );
    const reading = h.tool.execute('read-1', { url: 'https://example.com/article' });
    await Promise.resolve();
    expect(h.send).toHaveBeenCalledExactlyOnceWith({
      type: 'web_evidence',
      data: {
        messageId: 'message',
        evidence: expect.objectContaining({
          id: 'read-1',
          status: 'running',
          url: 'https://example.com/article',
        }),
      },
    });
    finish({
      content: [],
      details: {
        trusted: { status: 'done', offset: 8000, totalChars: 20000 },
        untrusted: { title: 'Actual title', url: 'https://example.com/final', content: 'body' },
      },
    });
    await reading;
    expect(h.lastEvidence()).toEqual(
      expect.objectContaining({
        status: 'done',
        title: 'Actual title',
        url: 'https://example.com/final',
        offset: 8000,
        chars: 4,
        totalChars: 20000,
      }),
    );
    expect(JSON.stringify(h.send.mock.calls)).not.toContain('"content":"body"');
  });

  it('never labels a refused fetch as retrieved, and every refusal tells the model it is unverified', async () => {
    const context = createClassroomWebFetchContext({
      messages: [],
      connection: { providerId: 'builtin', managed: true, userEndpoint: false, origin: 'default' },
      workspaceId: null,
    });
    const h = wrap(buildNativeWebFetchTool(context).execute as AgentTool['execute']);
    const result = await h.tool.execute('read-2', { url: 'https://example.com/article' });
    expect(h.lastEvidence()).toEqual(
      expect.objectContaining({ status: 'error', reason: 'url_not_observed' }),
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      trusted: {
        verified: false,
        instruction: expect.stringContaining('NO PAGE TEXT WAS RETRIEVED'),
      },
    });
  });

  it('projects search URLs as search sources without claiming page verification', async () => {
    const h = wrap(
      async () => ({
        content: [],
        details: {
          status: 'ok',
          sources: [{ title: 'Excerpt source', url: 'https://example.com/article' }],
        },
      }),
      'web_search',
    );
    await h.tool.execute('search-1', { query: 'a question' });
    expect(h.lastEvidence()).toEqual(
      expect.objectContaining({
        kind: 'search',
        status: 'done',
        sources: [{ title: 'Excerpt source', url: 'https://example.com/article' }],
      }),
    );
  });

  it('sends no late evidence for an interrupted read; the client settles the running card', async () => {
    const controller = new AbortController();
    const h = wrap(async () => {
      controller.abort();
      return { content: [], details: { trusted: { status: 'done' } } };
    });
    await expect(h.tool.execute('read-3', {}, controller.signal)).rejects.toThrow();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.lastEvidence()).toEqual(expect.objectContaining({ status: 'running' }));
  });
});
