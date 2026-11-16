/**
 * What sits beside an open course.
 *
 * Two regressions this file exists for: the resolver once answered `create`
 * and the shell POSTed on arrival (an empty session in the rail per visit), and
 * it once carried the most recent conversation over, so browsing to an
 * unrelated course put that conversation's chat beside it as if it were
 * editing the course. Nothing is minted and nothing is carried over now: a
 * browsed course is shown alone, and a conversation about it starts empty.
 */
import { describe, expect, it } from 'vitest';

import { resolveCourseChatBootstrap } from '@/lib/workbench/course-chat-bootstrap';

const base = {
  courseId: 'course-a' as string | null,
  sessionId: null as string | null,
};

describe('resolveCourseChatBootstrap', () => {
  it('does nothing with no course open', () => {
    expect(resolveCourseChatBootstrap({ ...base, courseId: null })).toEqual({ kind: 'settled' });
    expect(
      resolveCourseChatBootstrap({ ...base, courseId: null, newConversationRequested: true }),
    ).toEqual({ kind: 'settled' });
  });

  it('leaves a conversation in the URL beside the course — whatever it is about', () => {
    // Opened from a conversation (a course card, the preview's handoff, an
    // agent link), or a `?course=&session=` URL reloaded: the pairing stays.
    expect(resolveCourseChatBootstrap({ ...base, sessionId: 'session-other' })).toEqual({
      kind: 'settled',
    });
  });

  it('shows a browsed course alone, minting nothing and carrying nothing over', () => {
    expect(resolveCourseChatBootstrap(base)).toEqual({ kind: 'browse', courseId: 'course-a' });
  });

  it('offers an empty conversation about the course once asked for', () => {
    expect(resolveCourseChatBootstrap({ ...base, newConversationRequested: true })).toEqual({
      kind: 'draft',
      courseId: 'course-a',
    });
  });

  it('a conversation in the URL outranks the ask: the draft has become it', () => {
    // The draft's first message attaches the session it created.
    expect(
      resolveCourseChatBootstrap({
        ...base,
        sessionId: 'created',
        newConversationRequested: true,
      }),
    ).toEqual({ kind: 'settled' });
  });

  it('is the same answer for every visit to the same course', () => {
    expect(resolveCourseChatBootstrap(base)).toEqual(resolveCourseChatBootstrap(base));
  });
});
