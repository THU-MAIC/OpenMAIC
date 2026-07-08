import { describe, expect, it } from 'vitest';
import {
  CHAT_RUNTIME_ROLES,
  CORE_RUNTIME_KINDS,
  QUIZ_ATTEMPT_PHASES,
  RUNTIME_DSL_VERSION,
  RUNTIME_SESSION_STATUSES,
  isChatMessageSkeleton,
  isChatRuntimeRole,
  isCoreRuntimeKind,
  isIsoTimestamp,
  isQuizAttemptPhase,
  isQuizAttemptSkeleton,
  isRuntimeSessionStatus,
  migrateRuntime,
  type ChatMessageSkeleton,
  type QuizAttemptSkeleton,
  type RuntimeRecord,
  type RuntimeRecordInit,
  type RuntimeSession,
} from '@openmaic/dsl';

describe('runtime envelope guards', () => {
  it('accepts every declared session status and rejects others', () => {
    for (const s of RUNTIME_SESSION_STATUSES) expect(isRuntimeSessionStatus(s)).toBe(true);
    expect(isRuntimeSessionStatus('paused')).toBe(false);
    expect(isRuntimeSessionStatus(undefined)).toBe(false);
    expect(isRuntimeSessionStatus(1)).toBe(false);
  });

  it('accepts every core kind and rejects app-defined kinds', () => {
    expect(CORE_RUNTIME_KINDS).toEqual(['chat', 'quizAttempt', 'playback']);
    for (const k of CORE_RUNTIME_KINDS) expect(isCoreRuntimeKind(k)).toBe(true);
    expect(isCoreRuntimeKind('myWidget')).toBe(false);
  });

  it('accepts every chat role and quiz phase', () => {
    for (const r of CHAT_RUNTIME_ROLES) expect(isChatRuntimeRole(r)).toBe(true);
    expect(isChatRuntimeRole('tool')).toBe(false);
    for (const p of QUIZ_ATTEMPT_PHASES) expect(isQuizAttemptPhase(p)).toBe(true);
    expect(isQuizAttemptPhase('graded')).toBe(false);
  });
});

describe('runtime envelope shapes (compile-time contract)', () => {
  it('a session owns identity/lifecycle; a record owns ordering/anchoring/payload', () => {
    const session: RuntimeSession = {
      id: 's1',
      kind: 'chat',
      stageId: 'stage1',
      learnerKey: 'anon:device-1',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      runtimeDslVersion: '0.1.0',
    };
    const record: RuntimeRecord<ChatMessageSkeleton> = {
      id: 'r1',
      sessionId: session.id,
      seq: 0,
      sceneId: 'scene1',
      actionIndex: 3,
      createdAt: '2026-01-01T00:00:01.000Z',
      payload: { role: 'user', content: 'hello' },
    };
    expect(record.sessionId).toBe(session.id);
    expect(record.payload.role).toBe('user');
    const quiz: RuntimeRecord<QuizAttemptSkeleton> = {
      id: 'r2',
      sessionId: 's2',
      seq: 0,
      sceneId: 'scene2',
      subAnchor: 'question-3',
      createdAt: '2026-01-01T00:00:02.000Z',
      payload: { phase: 'submitted', answers: { q1: 'A' } },
    };
    expect(quiz.payload.phase).toBe('submitted');
  });

  it('requires runtimeDslVersion on a session at the type level (born stamped)', () => {
    // The stamp is required: a session is born stamped and the runtime line has
    // no unversioned epoch, so a directly-constructed session omitting it is a
    // type error. (Envelope-view code operates over `RuntimeVersioned`, whose
    // field stays optional; this required-ness is specific to `RuntimeSession`.)
    // @ts-expect-error runtimeDslVersion is required on a RuntimeSession
    const bad: RuntimeSession = {
      id: 's1',
      kind: 'chat',
      stageId: 'stage1',
      learnerKey: 'anon:device-1',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    void bad;
    const good: RuntimeSession = {
      id: 's1',
      kind: 'chat',
      stageId: 'stage1',
      learnerKey: 'anon:device-1',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      runtimeDslVersion: RUNTIME_DSL_VERSION,
    };
    expect(good.runtimeDslVersion).toBe(RUNTIME_DSL_VERSION);
  });

  it('excludes undefined from payload at the type level (aligns with the validator)', () => {
    // The validator rejects `payload: undefined`; the static type must agree, so
    // `undefined` is not assignable to the payload — this is a type error.
    const bad: RuntimeRecord = {
      id: 'r1',
      sessionId: 's1',
      seq: 0,
      createdAt: '2026-01-01T00:00:01.000Z',
      // @ts-expect-error payload cannot be undefined (RuntimePayload excludes it)
      payload: undefined,
    };
    void bad;
    // `null` stays a legal stored payload (the validator accepts it too).
    const withNull: RuntimeRecord = {
      id: 'r2',
      sessionId: 's1',
      seq: 0,
      createdAt: '2026-01-01T00:00:01.000Z',
      payload: null,
    };
    expect(withNull.payload).toBe(null);
    // The init shape inherits the same constraint via Omit.
    const initBad: RuntimeRecordInit = {
      id: 'r3',
      sessionId: 's1',
      createdAt: '2026-01-01T00:00:01.000Z',
      // @ts-expect-error payload cannot be undefined on the init shape either
      payload: undefined,
    };
    void initBad;
  });

  it('lets a producer construct a RuntimeRecordInit without a store-assigned seq', () => {
    // Compile-time contract: `seq` is store-owned, so the creation shape omits
    // it. Supplying `seq` here would be a type error; leaving it out type-checks.
    const init: RuntimeRecordInit<ChatMessageSkeleton> = {
      id: 'r1',
      sessionId: 's1',
      createdAt: '2026-01-01T00:00:01.000Z',
      payload: { role: 'assistant', content: 'hi' },
    };
    expect(init.id).toBe('r1');
  });
});

describe('runtime payload skeleton guards', () => {
  it('narrows chat message skeletons and rejects malformed ones', () => {
    expect(isChatMessageSkeleton({ role: 'user', content: 'hi' })).toBe(true);
    expect(isChatMessageSkeleton({ role: 'assistant', content: '' })).toBe(true);
    expect(isChatMessageSkeleton({ role: 'tool', content: 'hi' })).toBe(false); // bad role
    expect(isChatMessageSkeleton({ role: 'user', content: 42 })).toBe(false); // non-string
    expect(isChatMessageSkeleton({ role: 'user' })).toBe(false); // missing content
    expect(isChatMessageSkeleton(null)).toBe(false);
    expect(isChatMessageSkeleton('user')).toBe(false);
  });

  it('narrows quiz attempt skeletons and rejects malformed ones', () => {
    expect(isQuizAttemptSkeleton({ phase: 'draft', answers: {} })).toBe(true);
    expect(isQuizAttemptSkeleton({ phase: 'submitted', answers: { q1: 'A' } })).toBe(true);
    expect(isQuizAttemptSkeleton({ phase: 'graded', answers: {} })).toBe(false); // bad phase
    expect(isQuizAttemptSkeleton({ phase: 'draft', answers: [] })).toBe(false); // array, not object
    expect(isQuizAttemptSkeleton({ phase: 'draft', answers: null })).toBe(false); // null answers
    expect(isQuizAttemptSkeleton({ phase: 'draft', answers: new Map() })).toBe(false); // Map, not a plain record
    expect(isQuizAttemptSkeleton({ phase: 'draft', answers: new Date() })).toBe(false); // class instance, not a plain record
    expect(isQuizAttemptSkeleton({ phase: 'draft', answers: Object.create(null) })).toBe(true); // null-prototype plain record
    expect(isQuizAttemptSkeleton({ phase: 'draft' })).toBe(false); // missing answers
    expect(isQuizAttemptSkeleton(null)).toBe(false);
  });
});

describe('isIsoTimestamp', () => {
  it('accepts well-formed zoned timestamps', () => {
    expect(isIsoTimestamp('2026-01-01T00:00:00Z')).toBe(true);
    expect(isIsoTimestamp('2026-01-01T00:00:00.000Z')).toBe(true); // fractional seconds
    expect(isIsoTimestamp('2026-01-01T08:00:00+08:00')).toBe(true); // offset form
    expect(isIsoTimestamp('2024-02-29T00:00:00Z')).toBe(true); // real leap day
  });

  it('rejects calendar-impossible day-of-month, incl. leap-year rules', () => {
    // V8 NORMALIZES full ISO datetimes like Feb 30 into the next month (a real
    // instant, not NaN), so Date.parse cannot reject these; the component-level
    // day-in-month check is what rejects them, engine-independently.
    expect(isIsoTimestamp('2026-02-30T00:00:00.000Z')).toBe(false);
    expect(isIsoTimestamp('2026-02-29T00:00:00.000Z')).toBe(false); // 2026 is not a leap year
    expect(isIsoTimestamp('2024-02-29T00:00:00.000Z')).toBe(true); // divisible by 4 -> leap
    expect(isIsoTimestamp('2026-04-31T00:00:00.000Z')).toBe(false); // April has 30 days
    expect(isIsoTimestamp('2100-02-29T00:00:00.000Z')).toBe(false); // century, not /400 -> not leap
    expect(isIsoTimestamp('2000-02-29T00:00:00.000Z')).toBe(true); // divisible by 400 -> leap
  });

  it('rejects field-range violations', () => {
    expect(isIsoTimestamp('2026-13-01T00:00:00Z')).toBe(false); // month 13
    expect(isIsoTimestamp('2026-00-15T00:00:00Z')).toBe(false); // month 00
    expect(isIsoTimestamp('2026-01-00T00:00:00Z')).toBe(false); // day 00
    expect(isIsoTimestamp('2026-01-01T25:00:00Z')).toBe(false); // hour 25
    expect(isIsoTimestamp('2026-01-01T24:00:00.000Z')).toBe(false); // hour 24 (no end-of-day form)
    expect(isIsoTimestamp('2026-01-01T00:60:00Z')).toBe(false); // minute 60
    expect(isIsoTimestamp('2026-01-01T00:00:60Z')).toBe(false); // second 60 (leap second not accepted)
  });

  it('rejects out-of-range numeric zone offsets', () => {
    expect(isIsoTimestamp('2026-01-01T00:00:00+25:00')).toBe(false); // offset hours 25
    expect(isIsoTimestamp('2026-01-01T00:00:00+00:60')).toBe(false); // offset minutes 60
  });

  it('rejects zoneless and date-only forms (the regex requires a zone + time)', () => {
    expect(isIsoTimestamp('2026-01-01T00:00:00')).toBe(false); // no zone designator
    expect(isIsoTimestamp('2026-01-01')).toBe(false); // date only
    expect(isIsoTimestamp('2026/01/01T00:00:00Z')).toBe(false); // wrong separators
    expect(isIsoTimestamp('not-a-date')).toBe(false);
  });
});

describe('runtime envelope rides the dedicated runtime version ladder', () => {
  it('throws on an unstamped session — the runtime line has no unversioned epoch', () => {
    // A session is born stamped (`runtimeDslVersion` is required, written at
    // creation), so an object arriving WITHOUT the stamp is not legacy data to
    // lift — it is a misrouted legacy document or an unstamped producer write.
    // `migrateRuntime` fails loud rather than inventing a version, because the
    // runtime line has no unversioned epoch (unlike the document line).
    const unstamped: Omit<RuntimeSession, 'runtimeDslVersion'> = {
      id: 's1',
      kind: 'chat',
      stageId: 'stage1',
      learnerKey: 'anon:device-1',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(() => migrateRuntime(unstamped)).toThrow(/no unversioned epoch/);
  });

  it('leaves a current-version session untouched', () => {
    const current: RuntimeSession = {
      id: 's1',
      kind: 'chat',
      stageId: 'stage1',
      learnerKey: 'anon:device-1',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      runtimeDslVersion: RUNTIME_DSL_VERSION,
    };
    expect(migrateRuntime(current)).toEqual(current);
  });
});
