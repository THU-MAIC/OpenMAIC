import { describe, expect, it } from 'vitest';
import {
  newestFirst,
  reconcileAttachedSessionStatus,
  reduceOwnerSessionEvent,
  reduceOwnerStreamSignal,
  relativeBucket,
  runningSessionStageIds,
  type OwnerSessionEvent,
  type ProHomeSessionItem,
} from '@/lib/workbench/pro-home-data';

const session = (id: string, overrides: Partial<ProHomeSessionItem> = {}): ProHomeSessionItem => ({
  id,
  stageId: `course-${id}`,
  prompt: `${id} prompt`,
  status: 'running',
  createdAt: 100,
  updatedAt: 200,
  ...overrides,
});

describe('Pro workspace home data projection', () => {
  it('sorts a copied list by most recent activity', () => {
    const source = [
      { id: 'old', createdAt: 100, updatedAt: 200 },
      { id: 'new', createdAt: 300, updatedAt: 400 },
      { id: 'middle', createdAt: 250, updatedAt: 300 },
    ];

    expect(newestFirst(source).map((item) => item.id)).toEqual(['new', 'middle', 'old']);
    expect(source.map((item) => item.id)).toEqual(['old', 'new', 'middle']);
  });

  it('falls back to createdAt for malformed or missing updatedAt values', () => {
    expect(
      newestFirst([
        { id: 'missing', createdAt: 500 },
        { id: 'invalid', createdAt: 300, updatedAt: Number.NaN },
        { id: 'valid', createdAt: 100, updatedAt: 400 },
      ]).map((item) => item.id),
    ).toEqual(['missing', 'valid', 'invalid']);
  });

  it('settles only the attached row from the live conversation fold', () => {
    const sessions: ProHomeSessionItem[] = [
      {
        id: 'active',
        stageId: 'course-active',
        prompt: 'active prompt',
        status: 'running',
        createdAt: 100,
        updatedAt: 200,
      },
      {
        id: 'other-tab',
        stageId: 'course-other',
        prompt: 'other prompt',
        status: 'running',
        createdAt: 90,
        updatedAt: 190,
      },
    ];

    const reconciled = reconcileAttachedSessionStatus(sessions, {
      paneId: 'active',
      attachedId: 'active',
      status: 'succeeded',
    });

    expect(reconciled).not.toBe(sessions);
    expect(reconciled[0]).toEqual({ ...sessions[0], status: 'succeeded' });
    expect(reconciled[1]).toBe(sessions[1]);
    expect(sessions[0]?.status).toBe('running');

    const restarted = reconcileAttachedSessionStatus(reconciled, {
      paneId: 'active',
      attachedId: 'active',
      status: 'running',
    });
    expect(restarted[0]?.status).toBe('running');
    expect(restarted[1]).toBe(sessions[1]);

    expect(runningSessionStageIds(reconciled)).toEqual(new Set(['course-other']));
    expect(runningSessionStageIds(restarted)).toEqual(new Set(['course-active', 'course-other']));
  });

  it('keeps genuine live and cross-session states untouched during bootstrap', () => {
    const sessions: ProHomeSessionItem[] = [
      {
        id: 'active',
        stageId: 'course-active',
        prompt: 'active prompt',
        status: 'running',
        createdAt: 100,
        updatedAt: 200,
      },
    ];

    expect(
      reconcileAttachedSessionStatus(sessions, {
        paneId: 'active',
        attachedId: 'active',
        status: 'connecting',
      }),
    ).toBe(sessions);
    const queuedFollowUp = [{ ...sessions[0]!, status: 'queued' as const, updatedAt: 400 }];
    expect(
      reconcileAttachedSessionStatus(queuedFollowUp, {
        paneId: 'active',
        attachedId: 'active',
        status: 'succeeded',
        pendingWork: true,
      }),
    ).toBe(queuedFollowUp);
    expect(
      reconcileAttachedSessionStatus([{ ...sessions[0]!, status: 'running' }], {
        paneId: 'active',
        attachedId: 'active',
        status: 'succeeded',
      }),
    ).toEqual([{ ...sessions[0]!, status: 'succeeded' }]);
    expect(
      reconcileAttachedSessionStatus(sessions, {
        paneId: 'new-pane',
        attachedId: 'previous-pane',
        status: 'succeeded',
      }),
    ).toBe(sessions);
    expect(
      reconcileAttachedSessionStatus(sessions, {
        paneId: 'active',
        attachedId: 'active',
        status: 'succeeded',
        connected: false,
      }),
    ).toBe(sessions);
    expect(
      reconcileAttachedSessionStatus(sessions, {
        paneId: 'active',
        attachedId: 'active',
        status: 'running',
      }),
    ).toBe(sessions);
  });
});

describe('owner session event projection', () => {
  const event = <T extends OwnerSessionEvent>(value: T): T => value;

  it('requires a full fetch for every sparse event that references an unknown row', () => {
    const unknownEvents: OwnerSessionEvent[] = [
      event({
        id: '90071992547409931',
        sessionId: 'missing',
        ts: 300,
        phase: 'live',
        type: 'session_created',
        status: 'queued',
        attempt: 0,
      }),
      event({
        id: '90071992547409932',
        sessionId: 'missing',
        ts: 301,
        phase: 'live',
        type: 'session_status',
        status: 'running',
        attempt: 1,
      }),
      event({
        id: '90071992547409933',
        sessionId: 'missing',
        ts: 302,
        phase: 'live',
        type: 'session_deleted',
      }),
      event({
        id: '90071992547409934',
        sessionId: 'missing',
        ts: 303,
        phase: 'live',
        type: 'session_active_stage',
        activeStageId: 'course-new',
      }),
      event({
        id: '90071992547409935',
        sessionId: 'missing',
        ts: 304,
        phase: 'live',
        type: 'session_cancel_requested',
      }),
      event({
        id: '90071992547409936',
        sessionId: 'missing',
        ts: 305,
        phase: 'live',
        type: 'session_title',
        title: 'Generated title',
      }),
    ];

    expect(
      unknownEvents.map((ownerEvent) => reduceOwnerSessionEvent([], ownerEvent).needsFullFetch),
    ).toEqual([true, true, true, true, true, true]);
  });

  it('removes a deleted row without disturbing its neighbours', () => {
    const source = [session('newer', { updatedAt: 400 }), session('deleted'), session('older')];
    const result = reduceOwnerSessionEvent(
      source,
      event({
        id: '41',
        sessionId: 'deleted',
        ts: 500,
        phase: 'live',
        type: 'session_deleted',
      }),
    );

    expect(result.needsFullFetch).toBe(false);
    expect(result.sessions.map((item) => item.id)).toEqual(['newer', 'older']);
    expect(source).toHaveLength(3);
  });

  it('updates active stage in place and orders real transitions by event time', () => {
    const source = [session('other', { updatedAt: 450 }), session('active', { updatedAt: 200 })];
    const result = reduceOwnerSessionEvent(
      source,
      event({
        id: '42',
        sessionId: 'active',
        ts: 500,
        phase: 'live',
        type: 'session_active_stage',
        activeStageId: 'course-reassigned',
      }),
    );

    expect(result.needsFullFetch).toBe(false);
    expect(result.sessions.map((item) => item.id)).toEqual(['active', 'other']);
    expect(result.sessions[0]).toEqual({
      ...source[1],
      stageId: 'course-reassigned',
      updatedAt: 500,
    });
  });

  it('sets and clears a title through the owner projection', () => {
    const source = [session('active', { title: 'Old title', updatedAt: 200 })];
    const renamed = reduceOwnerSessionEvent(
      source,
      event({
        id: '43',
        sessionId: 'active',
        ts: 300,
        phase: 'live',
        type: 'session_title',
        title: 'New title',
      }),
    );
    const cleared = reduceOwnerSessionEvent(
      renamed.sessions,
      event({
        id: '44',
        sessionId: 'active',
        ts: 400,
        phase: 'backlog',
        type: 'session_title',
        title: null,
      }),
    );

    expect(renamed.sessions[0]).toEqual({ ...source[0], title: 'New title', updatedAt: 300 });
    expect(cleared.sessions[0]).toEqual({ ...source[0], title: null, updatedAt: 400 });
  });

  it('treats a title change as recent rail activity', () => {
    const source = [
      session('newer', { updatedAt: 250 }),
      session('renamed', { title: 'Old title', updatedAt: 200 }),
    ];
    const result = reduceOwnerSessionEvent(
      source,
      event({
        id: '45',
        sessionId: 'renamed',
        ts: 300,
        phase: 'live',
        type: 'session_title',
        title: 'New title',
      }),
    );

    expect(result.needsFullFetch).toBe(false);
    expect(result.sessions.map((item) => item.id)).toEqual(['renamed', 'newer']);
    expect(result.sessions[0]).toEqual({ ...source[1], title: 'New title', updatedAt: 300 });
  });

  it.each([
    { relation: 'older than', eventTimestamp: 499 },
    { relation: 'from the same millisecond as', eventTimestamp: 500 },
  ])('ignores a title projection $relation the matching owner snapshot', ({ eventTimestamp }) => {
    const source = [session('active', { title: 'Newest title', updatedAt: 500 })];
    const result = reduceOwnerSessionEvent(
      source,
      event({
        id: '45',
        sessionId: 'active',
        ts: eventTimestamp,
        phase: 'backlog',
        type: 'session_title',
        title: 'Stale title',
      }),
    );

    expect(result).toEqual({ sessions: source, needsFullFetch: false });
    expect(result.sessions).toBe(source);
  });

  it('treats degraded catch-up as non-authoritative and initializes only once after recovery', () => {
    const initial = { initialized: false, degraded: false };
    const degraded = reduceOwnerStreamSignal(initial, { type: 'caught_up', degraded: true });
    const recovered = reduceOwnerStreamSignal(degraded.state, { type: 'caught_up' });
    const duplicate = reduceOwnerStreamSignal(recovered.state, { type: 'caught_up' });

    expect(degraded).toMatchObject({
      state: { initialized: false, degraded: true },
      needsFullFetch: true,
      initializedNow: false,
    });
    expect(recovered).toMatchObject({
      state: { initialized: true, degraded: false },
      needsFullFetch: false,
      initializedNow: true,
    });
    expect(duplicate.initializedNow).toBe(false);
  });

  it('requires both a fresh stream and a full fetch after owner movement', () => {
    expect(
      reduceOwnerStreamSignal({ initialized: true, degraded: false }, { type: 'owner_moved' }),
    ).toMatchObject({ reconnect: true, needsFullFetch: true, initializedNow: false });
  });
});

describe('sidebar relative timestamps', () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  it('buckets by the largest unit that still reads as recent', () => {
    expect(relativeBucket(now - 30_000, now)).toEqual({ unit: 'now' });
    expect(relativeBucket(now - 5 * minute, now)).toEqual({ unit: 'minutes', count: 5 });
    expect(relativeBucket(now - 3 * hour, now)).toEqual({ unit: 'hours', count: 3 });
    expect(relativeBucket(now - 2 * day, now)).toEqual({ unit: 'days', count: 2 });
  });

  it('falls back to an absolute date past a week', () => {
    const old = now - 30 * day;
    expect(relativeBucket(old, now)).toEqual({ unit: 'date', at: old });
  });

  it('reads a future-skewed clock as now rather than a negative age', () => {
    expect(relativeBucket(now + 5 * minute, now)).toEqual({ unit: 'now' });
  });

  it('says nothing for a missing or nonsensical timestamp', () => {
    expect(relativeBucket(0, now)).toBeNull();
    expect(relativeBucket(Number.NaN, now)).toBeNull();
    expect(relativeBucket(-1, now)).toBeNull();
  });
});
