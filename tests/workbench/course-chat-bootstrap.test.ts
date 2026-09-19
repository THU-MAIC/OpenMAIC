/**
 * Opening a course must not create a conversation.
 *
 * The regression this file exists for: the resolver used to answer `create`, and
 * the shell POSTed on arrival — so opening a course, closing the chat and opening
 * the course again left an empty session in the rail per visit. Nothing is minted
 * here now; the first message does it.
 */
import { describe, expect, it } from 'vitest';

import {
  mostRecentSession,
  resolveCourseChatBootstrap,
} from '@/lib/workbench/course-chat-bootstrap';

const session = (id: string, updatedAt: number, createdAt = updatedAt) => ({
  id,
  updatedAt,
  createdAt,
});

const base = {
  courseId: 'course-a' as string | null,
  sessionId: null as string | null,
  sessions: [] as ReturnType<typeof session>[],
  sessionsLoaded: true,
};

describe('resolveCourseChatBootstrap', () => {
  it('does nothing with no course open', () => {
    expect(resolveCourseChatBootstrap({ ...base, courseId: null })).toEqual({ kind: 'settled' });
  });

  it('leaves an open conversation alone — including one about another course', () => {
    // It never hunts for "the session that owns this course", and never swaps out
    // the conversation the user is reading.
    expect(
      resolveCourseChatBootstrap({
        ...base,
        sessionId: 'session-other',
        sessions: [session('session-recent', 5)],
      }),
    ).toEqual({ kind: 'settled' });
  });

  it('treats the attached store session as a conversation too', () => {
    // The window during navigation where the URL has dropped `?session=` but the
    // store has not detached yet must not read as "there is no conversation".
    expect(resolveCourseChatBootstrap({ ...base, attachedSessionId: 'session-attached' })).toEqual({
      kind: 'settled',
    });
  });

  it('carries the most recent conversation over rather than minting one', () => {
    expect(
      resolveCourseChatBootstrap({
        ...base,
        sessions: [session('session-old', 1), session('session-recent', 9)],
      }),
    ).toEqual({ kind: 'adopt', sessionId: 'session-recent', courseId: 'course-a' });
  });

  it('offers an empty conversation — and NO mint — when the user has none at all', () => {
    expect(resolveCourseChatBootstrap(base)).toEqual({ kind: 'draft', courseId: 'course-a' });
  });

  it('waits for the session list before deciding either branch', () => {
    // Deciding 'draft' early would flash an empty composer at a user who has
    // fifty conversations.
    expect(resolveCourseChatBootstrap({ ...base, sessionsLoaded: false })).toEqual({
      kind: 'settled',
    });
  });

  it('is stable across repeated visits to the same course', () => {
    const input = { ...base, sessions: [session('session-recent', 9)] };
    expect(resolveCourseChatBootstrap(input)).toEqual(resolveCourseChatBootstrap(input));
    // And once the adoption has reached the URL, it settles instead of adopting again.
    expect(resolveCourseChatBootstrap({ ...input, sessionId: 'session-recent' })).toEqual({
      kind: 'settled',
    });
  });
});

describe('mostRecentSession', () => {
  it('prefers the most recently active over the most recently created', () => {
    expect(mostRecentSession([session('a', 10, 1), session('b', 2, 9)])?.id).toBe('a');
  });

  it('falls back to createdAt for a session never updated', () => {
    expect(mostRecentSession([session('a', 0, 5), session('b', 0, 3)])?.id).toBe('a');
  });

  it('breaks ties deterministically instead of depending on list order', () => {
    expect(mostRecentSession([session('a', 5), session('b', 5)])?.id).toBe('b');
    expect(mostRecentSession([session('b', 5), session('a', 5)])?.id).toBe('b');
  });

  it('has nothing to offer for an empty list', () => {
    expect(mostRecentSession([])).toBeNull();
  });
});
