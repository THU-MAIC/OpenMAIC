import { afterEach, describe, expect, it, vi } from 'vitest';

import { postWorkbenchMessage } from '@/lib/workbench/session-store';
import type { CourseRef } from '@/lib/workbench/course-refs';
import { useCourseRefsStore } from '@/lib/store/course-refs';
import { settleSentCourseRefs } from '@/lib/workbench/course-ref-send-result';

const material = {
  materialId: 'mat_00000000000000000000000000',
  name: '讲义.pdf',
  bytes: 5,
  mimeType: 'application/pdf',
  extractionStatus: 'idle' as const,
};

const courseRef: CourseRef = { kind: 'course', stageId: 'stage-1', title: '光的折射' };

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
  useCourseRefsStore.setState({ ownerSessionId: null, refs: [], nextGeneration: 1 });
});

describe('postWorkbenchMessage course refs', () => {
  /**
   * The zero-regression pin. The control plane rejects unknown fields, and the
   * overwhelming majority of messages name no course — an unconditional
   * `courseRefs: []` would put a key on every one of them. Byte-exact on purpose.
   */
  it('sends a body identical to the pre-mention shape when nothing is named', async () => {
    const calls = captureFetch();
    await postWorkbenchMessage('sess-1', '第三页换个例子');
    expect(calls[0].init.body).toBe(JSON.stringify({ text: '第三页换个例子' }));
    expect(String(calls[0].init.body)).not.toContain('courseRefs');
  });

  it('omits the field for an explicitly empty list, alongside empty element refs', async () => {
    const calls = captureFetch();
    await postWorkbenchMessage('sess-1', 'hi', [], [], []);
    expect(calls[0].init.body).toBe(JSON.stringify({ text: 'hi' }));
  });

  it('carries the named courses verbatim, after materialIds and elementRefs', async () => {
    const calls = captureFetch({ courseRefsAccepted: true });
    const result = await postWorkbenchMessage('sess-1', '改第三页', [material], [], [courseRef]);
    expect(calls[0].init.body).toBe(
      JSON.stringify({
        text: '改第三页',
        materialIds: [material.materialId],
        courseRefs: [courseRef],
      }),
    );
    expect(calls[0].url).toBe('/api/agent/sessions/sess-1/messages');
    expect(result).toEqual({ elementRefsAccepted: false, courseRefsAccepted: true });
  });

  it('warns and retains the mention when an old route answers 202 without a receipt', async () => {
    captureFetch();
    const store = useCourseRefsStore.getState();
    store.attachOwner('sess-1');
    store.add(courseRef);
    const sent = useCourseRefsStore.getState().refs;
    const warnUnsupported = vi.fn();

    const result = await postWorkbenchMessage('sess-1', '改第三页', [], [], sent);
    settleSentCourseRefs({
      sessionId: 'sess-1',
      sent,
      courseRefsAccepted: result.courseRefsAccepted,
      warnUnsupported,
    });

    expect(warnUnsupported).toHaveBeenCalledOnce();
    expect(useCourseRefsStore.getState().refs).toHaveLength(1);
  });

  it('clears the mention normally when the route returns the capability receipt', async () => {
    captureFetch({ courseRefsAccepted: true });
    const store = useCourseRefsStore.getState();
    store.attachOwner('sess-1');
    store.add(courseRef);
    const sent = useCourseRefsStore.getState().refs;
    const warnUnsupported = vi.fn();

    const result = await postWorkbenchMessage('sess-1', '改第三页', [], [], sent);
    settleSentCourseRefs({
      sessionId: 'sess-1',
      sent,
      courseRefsAccepted: result.courseRefsAccepted,
      warnUnsupported,
    });

    expect(warnUnsupported).not.toHaveBeenCalled();
    expect(useCourseRefsStore.getState().refs).toEqual([]);
  });
});
