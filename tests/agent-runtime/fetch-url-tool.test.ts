/**
 * `fetch_url` tool tests — the trust gate and the reference result shape.
 *
 * The security core is the session-URL gate: a URL not allowed by
 * `isSessionUrlAllowed` is refused BEFORE any fetch happens, as a normal
 * business answer (never an error the model could misread as retryable), with
 * the exact remediation. The engine-level SSRF/byte-cap behavior is covered in
 * fetch-url.test.ts; the store-backed persistence round-trip (trust gate +
 * asset registry + material row) is covered in session-materials.test.ts.
 */
import { builtin } from '@/lib/web-fetch/providers/builtin';
import * as extraction from '@/lib/server/material-extraction/services';
import * as materials from '@/lib/server/agent-runtime/session-materials';
import * as urls from '@/lib/server/agent-runtime/session-urls';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildFetchUrlTool,
  type ExtractedWebPage,
  type FetchUrlOptions,
  type FetchUrlToolDependencies,
} from '@/lib/server/agent-runtime/fetch-url';

function page(overrides: Partial<ExtractedWebPage> = {}): ExtractedWebPage {
  return {
    sourceUrl: 'https://example.com/article',
    finalUrl: 'https://example.com/article',
    title: 'Example article',
    markdown: '正文'.repeat(100),
    fetchedAt: '2026-08-16T08:00:00.000Z',
    contentType: 'text/html',
    truncated: false,
    downloadedBytes: 300,
    ...overrides,
  };
}

function tool(deps: Partial<FetchUrlToolDependencies> = {}) {
  return buildFetchUrlTool({ sessionId: 'ses_1', ...deps });
}

/** The top-level `isError` pi puts on errored tool results. */
function isErrorOf(result: unknown): boolean | undefined {
  return (result as { isError?: boolean }).isError;
}

describe('fetch_url tool', () => {
  it('rejects a URL that is absent from the durable session URL set', async () => {
    const fetchUrl = vi.fn();
    const fetch = tool({
      isUrlAllowed: vi.fn().mockResolvedValue(false),
      fetchUrl,
    });

    const result = await fetch.execute(
      'call_1',
      { url: 'https://invented.example/' } as never,
      undefined,
    );

    expect(result).toMatchObject({ details: { trusted: { status: 'url_not_in_session' } } });
    // The trust gate's refusal is a NORMAL business answer (recoverable by
    // asking the user / web_search first), not an error — deliberately no
    // isError, like ask_user's guidance.
    expect(isErrorOf(result)).toBeUndefined();
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain('direct link');
    expect(text).toContain('web_search');
    // The fetch must never happen for a refused URL.
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it('fetches an allowed URL and returns the reference structured result', async () => {
    const markdown = '甲'.repeat(2500);
    const fetched = page({ markdown, title: '网页', truncated: true });
    const saveWebMaterial = vi.fn().mockResolvedValue({
      id: 'mat_web',
      sessionId: 'ses_1',
      kind: 'web',
      title: '网页',
      sourceUrl: fetched.sourceUrl,
      textAssetId: 'ast_text_1',
      rawAssetId: null,
      textChars: markdown.length,
      createdAt: '2026-08-16T08:00:00.000Z',
    });
    const fetchUrl = vi.fn().mockResolvedValue(fetched);
    const fetch = tool({
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      fetchUrl,
      saveWebMaterial,
    });

    const result = await fetch.execute(
      'call_1',
      { url: 'https://example.com/article' } as never,
      undefined,
    );

    expect(fetchUrl).toHaveBeenCalledWith(
      'https://example.com/article',
      expect.objectContaining({ signal: undefined, isUrlAllowed: expect.any(Function) }),
    );
    expect(saveWebMaterial).toHaveBeenCalledWith('ses_1', fetched);
    expect(result.details).toMatchObject({
      trusted: {
        status: 'done',
        materialId: 'mat_web',
        fetchedAt: fetched.fetchedAt,
        totalChars: markdown.length,
        truncated: true,
        // Preview bounded at 2000 chars, with the continuation offset.
        nextOffset: 2000,
      },
      untrusted: {
        url: 'https://example.com/article',
        title: '网页',
        content: '甲'.repeat(2000),
      },
    });
    // The full markdown never reaches the model — only the preview does.
    expect(result.details).not.toHaveProperty('content');
  });

  it('omits nextOffset when the whole page fits in the preview', async () => {
    const markdown = 'short';
    const fetch = tool({
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      fetchUrl: vi.fn().mockResolvedValue(page({ markdown })),
      saveWebMaterial: vi.fn().mockResolvedValue({
        id: 'mat_short',
        sessionId: 'ses_1',
        kind: 'web',
        sourceUrl: 'https://example.com/article',
        textAssetId: 'ast_1',
        rawAssetId: null,
        textChars: markdown.length,
        createdAt: '2026-08-16T08:00:00.000Z',
      }),
    });

    const result = await fetch.execute(
      'call_1',
      { url: 'https://example.com/article' } as never,
      undefined,
    );

    const trusted = (result.details as { trusted: Record<string, unknown> }).trusted;
    expect(trusted).toMatchObject({ status: 'done' });
    // No continuation offset when the whole page fits in the preview.
    expect(trusted).not.toHaveProperty('nextOffset');
  });

  it('fails the call when the per-run signal aborts before the fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchUrl = vi.fn();
    const fetch = tool({
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      fetchUrl,
    });

    await expect(
      fetch.execute('call_1', { url: 'https://example.com/article' } as never, controller.signal),
    ).rejects.toThrow('aborted');
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it('interrupts the fetch when the signal aborts mid-flight', async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = tool({
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      fetchUrl: vi.fn(async (_url: string, options?: FetchUrlOptions) => {
        if (options?.signal?.aborted) throw new Error('aborted');
        await gate;
        if (options?.signal?.aborted) throw new Error('aborted');
        return page();
      }),
      saveWebMaterial: vi.fn(),
    });

    const pending = fetch.execute(
      'call_1',
      { url: 'https://example.com/article' } as never,
      controller.signal,
    );
    controller.abort();
    release?.();
    await expect(pending).rejects.toThrow('aborted');
  });

  it('does not persist when the fetch fails', async () => {
    const fetch = tool({
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      fetchUrl: vi.fn().mockRejectedValue(new Error('network down')),
      saveWebMaterial: vi.fn(),
    });

    await expect(
      fetch.execute('call_1', { url: 'https://example.com/article' } as never, undefined),
    ).rejects.toThrow('network down');
  });

  it('rechecks the reported final URL and never persists an untrusted redirect result', async () => {
    const isUrlAllowed = vi.fn(async (_sessionId: string, url: string) =>
      url.startsWith('https://trusted.example/'),
    );
    const saveWebMaterial = vi.fn();
    const fetch = tool({
      isUrlAllowed,
      fetchUrl: vi.fn().mockResolvedValue(
        page({
          sourceUrl: 'https://trusted.example/start',
          finalUrl: 'https://untrusted.example/landing',
        }),
      ),
      saveWebMaterial,
    });

    const result = await fetch.execute(
      'call_1',
      { url: 'https://trusted.example/start' } as never,
      undefined,
    );

    expect(result).toMatchObject({ details: { trusted: { status: 'url_not_in_session' } } });
    expect(saveWebMaterial).not.toHaveBeenCalled();
  });

  it('bounds an attacker-controlled page title in the model-visible result', async () => {
    const fetch = tool({
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      fetchUrl: vi.fn().mockResolvedValue(page({ title: 'T'.repeat(10_000) })),
      saveWebMaterial: vi.fn().mockResolvedValue({ id: 'mat_title' }),
    });

    const result = await fetch.execute(
      'call_1',
      { url: 'https://example.com/article' } as never,
      undefined,
    );

    expect((result.details as { untrusted: { title: string } }).untrusted.title).toHaveLength(180);
  });
});

describe('classroom fetch_url', () => {
  afterEach(() => vi.restoreAllMocks());

  const fetch = buildFetchUrlTool({
    mode: 'classroom',
    connection: { providerId: 'builtin', managed: true, userEndpoint: false, origin: 'default' },
    workspaceId: 'workspace-a',
  });

  it.each([
    { length: 2000, truncated: false, partial: false },
    { length: 2001, truncated: false, partial: true },
    { length: 500, truncated: true, partial: true },
  ])(
    'bounds and labels the preview for $length characters, reader truncated=$truncated',
    async ({ length, truncated, partial }) => {
      const fetched = page({ markdown: 'x'.repeat(length), truncated });
      vi.spyOn(builtin, 'extract').mockResolvedValue(fetched);
      const gate = vi.spyOn(urls, 'isSessionUrlAllowed');
      const save = vi.spyOn(materials, 'createWebMaterial');
      const result = await fetch.execute('preview', { url: fetched.sourceUrl });
      const part = result.content[0];
      if (part.type !== 'text') throw new Error('Expected model-visible preview text');
      const visible = JSON.parse(part.text);
      expect(Object.keys(fetch.parameters.properties)).toEqual(['url']);
      expect(visible.untrusted.content).toBe(fetched.markdown.slice(0, 2000));
      expect(visible.trusted.truncated).toBe(partial);
      if (partial) expect(visible.trusted.note).toContain('Only the first part');
      else expect(visible.trusted.note).toBeUndefined();
      expect(visible.trusted).not.toHaveProperty('materialId');
      expect(visible.trusted).not.toHaveProperty('nextOffset');
      expect(gate).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    },
  );

  it('resolves document services lazily for the requesting workspace, without following a claim', async () => {
    const resolve = vi
      .spyOn(extraction, 'resolveExtractionServices')
      .mockResolvedValue({ document: null });
    const extract = vi.spyOn(builtin, 'extract').mockResolvedValue(page());
    await fetch.execute('read', { url: page().sourceUrl });
    const options = extract.mock.calls[0][1];
    expect(options.extractionServices).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    await options.loadExtractionServices!();
    expect(resolve).toHaveBeenCalledWith('workspace-a', { forward: false });
  });
});
