/**
 * `@`-named classrooms on the message that CREATES a conversation.
 *
 * Every later mention rides its own `POST /messages`, whose `user_message` event
 * carries it and whose drain composes it. A launch composer has no such message —
 * its first prompt IS `agent_session.prompt`, delivered by the runner's start path
 * straight from the row — so the mention travels on the creation request, is stored
 * as the session's opening context, and is injected through the SAME resolver the
 * follow-up path uses.
 *
 * What is pinned here: the wire shape both ways, and that a request WITHOUT a
 * mention is byte-for-byte what it always was.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkbenchSession } from '@/lib/workbench/session-store';
import type { CourseRef } from '@/lib/workbench/course-refs';

const REF: CourseRef = { kind: 'course', stageId: 'stage-1', title: '光的折射' };

const created = (extra: Record<string, unknown> = {}) => ({
  id: 's1',
  stageId: 'stage-1',
  status: 'queued',
  prompt: 'p',
  ...extra,
});

function stubFetch(body: Record<string, unknown>) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(body),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('creating a session with a named classroom', () => {
  it('sends the refs verbatim', async () => {
    const fetchMock = stubFetch(created({ courseRefs: [REF] }));
    await createWorkbenchSession({ prompt: 'p', courseRefs: [REF] });
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({ prompt: 'p', courseRefs: [REF] });
  });

  it('leaves the body untouched when nothing was named', async () => {
    // The field is absent, not empty: this exact body is what every existing
    // caller and assertion already expects.
    const fetchMock = stubFetch(created());
    await createWorkbenchSession({ prompt: 'p' });
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({ prompt: 'p' });
    expect(String(request.body)).not.toContain('courseRefs');

    const empty = stubFetch(created());
    await createWorkbenchSession({ prompt: 'p', courseRefs: [] });
    expect(String((empty.mock.calls[0][1] as RequestInit).body)).not.toContain('courseRefs');
  });

  it('reports acceptance, so a server that dropped the field is not silent', async () => {
    // The rolling-deploy case: an older route answers 202 and ignores a field it
    // does not know. The caller warns instead of losing the mention quietly.
    const dropped = stubFetch(created());
    const meta = await createWorkbenchSession({ prompt: 'p', courseRefs: [REF] });
    expect(dropped).toHaveBeenCalled();
    expect(meta.courseRefsAccepted).toBe(false);

    stubFetch(created({ courseRefs: [REF] }));
    const ok = await createWorkbenchSession({ prompt: 'p', courseRefs: [REF] });
    expect(ok.courseRefsAccepted).toBe(true);
  });

  it('has nothing to report when nothing was named', async () => {
    stubFetch(created());
    const meta = await createWorkbenchSession({ prompt: 'p' });
    expect(meta.courseRefsAccepted).toBe(true);
  });
});
