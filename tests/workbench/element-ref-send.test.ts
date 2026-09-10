import { afterEach, describe, expect, it, vi } from 'vitest';

import { postWorkbenchMessage } from '@/lib/workbench/session-store';
import type { ElementRef } from '@/lib/workbench/element-refs';
import { useElementRefsStore } from '@/lib/store/element-refs';
import { settleSentElementRefs } from '@/lib/workbench/element-ref-send-result';

const material = {
  materialId: 'mat_00000000000000000000000000',
  name: '讲义.pdf',
  bytes: 5,
  mimeType: 'application/pdf',
  extractionStatus: 'idle' as const,
};

const elementRef: ElementRef = {
  kind: 'slide-element',
  stageId: 'stage-1',
  sceneId: 'scene-1',
  elementId: 'title-1',
  elementType: 'text',
  label: '文本 · 折射定律',
  snapshotText: '折射定律',
};

function captureFetch(responseBody?: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return responseBody === undefined
      ? new Response(null, { status: 202 })
      : Response.json(responseBody, { status: 202 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  useElementRefsStore.setState({
    ownerSessionId: null,
    refs: [],
    hovered: null,
    nextGeneration: 1,
  });
});

describe('postWorkbenchMessage element refs', () => {
  /**
   * The zero-regression pin. The control plane rejects unknown fields and no
   * message sends refs today, so an unconditional `elementRefs: []` would break
   * every existing send. These two assertions are byte-exact on purpose: a
   * reordered or always-present key is exactly the failure they exist to catch.
   */
  it('sends a body identical to the pre-refs shape when nothing is staged', async () => {
    const calls = captureFetch();
    await postWorkbenchMessage('sess-1', '第三页换个例子');
    expect(calls[0].init.body).toBe(JSON.stringify({ text: '第三页换个例子' }));
  });

  it('keeps the materials-only body byte-identical too', async () => {
    const calls = captureFetch();
    await postWorkbenchMessage('sess-1', '读这份 PDF', [material]);
    expect(calls[0].init.body).toBe(
      JSON.stringify({ text: '读这份 PDF', materialIds: [material.materialId] }),
    );
  });

  it('omits the field for an explicitly empty ref list', async () => {
    const calls = captureFetch();
    await postWorkbenchMessage('sess-1', 'hi', [], []);
    expect(calls[0].init.body).toBe(JSON.stringify({ text: 'hi' }));
    expect(String(calls[0].init.body)).not.toContain('elementRefs');
  });

  it('carries the staged refs verbatim, after materialIds', async () => {
    const calls = captureFetch({ elementRefsAccepted: true });
    const result = await postWorkbenchMessage('sess-1', '把标题改短', [material], [elementRef]);
    expect(calls[0].init.body).toBe(
      JSON.stringify({
        text: '把标题改短',
        materialIds: [material.materialId],
        elementRefs: [elementRef],
      }),
    );
    expect(calls[0].url).toBe('/api/agent/sessions/sess-1/messages');
    expect(result).toEqual({ elementRefsAccepted: true, courseRefsAccepted: false });
  });

  it('warns and retains refs when an old route returns 202 without a capability receipt', async () => {
    captureFetch();
    const store = useElementRefsStore.getState();
    store.attachOwner('sess-1');
    store.add(elementRef);
    const sent = useElementRefsStore.getState().refs;
    const warnUnsupported = vi.fn();

    const result = await postWorkbenchMessage('sess-1', '把标题改短', [], sent);
    settleSentElementRefs({
      sessionId: 'sess-1',
      sent,
      elementRefsAccepted: result.elementRefsAccepted,
      warnUnsupported,
    });

    expect(warnUnsupported).toHaveBeenCalledOnce();
    expect(useElementRefsStore.getState().refs).toHaveLength(1);
  });

  it('clears the sent refs normally when the route returns the capability receipt', async () => {
    captureFetch({ elementRefsAccepted: true });
    const store = useElementRefsStore.getState();
    store.attachOwner('sess-1');
    store.add(elementRef);
    const sent = useElementRefsStore.getState().refs;
    const warnUnsupported = vi.fn();

    const result = await postWorkbenchMessage('sess-1', '把标题改短', [], sent);
    settleSentElementRefs({
      sessionId: 'sess-1',
      sent,
      elementRefsAccepted: result.elementRefsAccepted,
      warnUnsupported,
    });

    expect(warnUnsupported).not.toHaveBeenCalled();
    expect(useElementRefsStore.getState().refs).toEqual([]);
  });
});
