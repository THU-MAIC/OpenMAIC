import { describe, it, expect } from 'vitest';
import {
  validateStage,
  validateScene,
  validateAction,
  validateRuntimeSession,
  validateRuntimeRecord,
  type ValidationResult,
} from '@openmaic/dsl';

function errors(r: ValidationResult): string[] {
  return r.valid ? [] : r.errors.map((e) => e.path);
}

describe('validateStage', () => {
  it('accepts a well-formed stage', () => {
    expect(validateStage({ id: 's', name: 'n', createdAt: 1, updatedAt: 2 })).toEqual({
      valid: true,
    });
  });
  it('collects every missing required field', () => {
    const r = validateStage({ id: 's' });
    expect(r.valid).toBe(false);
    expect(errors(r)).toEqual(expect.arrayContaining(['/name', '/createdAt', '/updatedAt']));
  });
  it('rejects non-objects', () => {
    expect(validateStage(null).valid).toBe(false);
    expect(validateStage('x').valid).toBe(false);
  });
});

describe('validateScene', () => {
  const ok = {
    id: 'sc1',
    stageId: 'st1',
    type: 'slide',
    title: 'Intro',
    order: 0,
    content: { type: 'slide', canvas: { id: 'c' } },
  };
  it('accepts a well-formed slide scene', () => {
    expect(validateScene(ok)).toEqual({ valid: true });
  });
  it('flags an unknown content type', () => {
    const r = validateScene({ ...ok, content: { type: 'bogus' } });
    expect(errors(r)).toContain('/content/type');
  });
  it('flags a quiz scene missing its questions array', () => {
    const r = validateScene({ ...ok, type: 'quiz', content: { type: 'quiz' } });
    expect(errors(r)).toContain('/content/questions');
  });
  it('flags app-widened scene kinds (contract owns only slide/quiz)', () => {
    const r = validateScene({ ...ok, type: 'pbl', content: { type: 'pbl' } });
    expect(errors(r)).toContain('/type');
  });
  it('flags a scene whose content.type disagrees with its type', () => {
    const r = validateScene({
      ...ok,
      type: 'quiz',
      content: { type: 'slide', canvas: { id: 'c' } },
    });
    expect(r.valid).toBe(false);
    expect(errors(r)).toContain('/content/type');
  });
  it('validates nested actions and points at the bad one', () => {
    const r = validateScene({
      ...ok,
      actions: [
        { id: 'a', type: 'speech', text: 'hi' },
        { id: 'b', type: 'nope' },
      ],
    });
    expect(errors(r)).toContain('/actions/1/type');
  });
});

describe('validateAction', () => {
  it('accepts a well-formed action (variant fields present)', () => {
    expect(validateAction({ id: 'a', type: 'spotlight', elementId: 'e' })).toEqual({ valid: true });
  });
  it('rejects an unknown action type', () => {
    const r = validateAction({ id: 'a', type: 'frobnicate' });
    expect(errors(r)).toContain('/type');
  });
  it('flags a known action type missing a variant-required field', () => {
    // A spotlight with no elementId is unusable at runtime.
    const r = validateAction({ id: 'a', type: 'spotlight' });
    expect(errors(r)).toContain('/elementId');
    const d = validateAction({ id: 'a', type: 'discussion' });
    expect(errors(d)).toContain('/topic');
  });
  it('flags a variant-required field of the wrong type', () => {
    // present but mis-typed: elementId must be a string, not a number.
    const r = validateAction({ id: 'a', type: 'spotlight', elementId: 123 });
    expect(errors(r)).toContain('/elementId');
  });
  it('requires a string id', () => {
    const r = validateAction({ type: 'laser', elementId: 'e' });
    expect(errors(r)).toContain('/id');
  });
});

describe('validateRuntimeSession', () => {
  const good = {
    id: 's1',
    kind: 'chat',
    stageId: 'stage1',
    learnerKey: 'anon:device-1',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    // Required: sessions are born stamped, the runtime line has no unversioned epoch.
    runtimeDslVersion: '0.1.0',
  };

  it('accepts a minimal valid session', () => {
    expect(validateRuntimeSession(good)).toEqual({ valid: true });
  });

  it('accepts an app-defined kind alongside the required runtimeDslVersion', () => {
    expect(
      validateRuntimeSession({ ...good, kind: 'myWidget', runtimeDslVersion: '0.1.0' }),
    ).toEqual({
      valid: true,
    });
  });

  it('rejects a session missing runtimeDslVersion, reported once at /runtimeDslVersion', () => {
    // The stamp is required now: an absent one is a bug (a misrouted legacy
    // document or an unstamped producer write), not legacy data to lift, since
    // the runtime line has no unversioned epoch. Reported exactly once.
    const { runtimeDslVersion: _v, ...noStamp } = good;
    const result = validateRuntimeSession(noStamp);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    const stampErrors = result.errors.filter((e) => e.path === '/runtimeDslVersion');
    expect(stampErrors).toHaveLength(1);
    expect(stampErrors[0].message).toMatch(/missing/);
  });

  it('rejects non-objects', () => {
    const result = validateRuntimeSession(null);
    expect(result.valid).toBe(false);
  });

  it('reports every missing required field with a path', () => {
    const result = validateRuntimeSession({});
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    const paths = result.errors.map((e) => e.path);
    for (const p of [
      '/id',
      '/kind',
      '/stageId',
      '/learnerKey',
      '/status',
      '/createdAt',
      '/updatedAt',
      // Required now: an empty session is missing the runtime stamp too.
      '/runtimeDslVersion',
    ]) {
      expect(paths).toContain(p);
    }
  });

  it('rejects an unknown status value', () => {
    const result = validateRuntimeSession({ ...good, status: 'paused' });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(result.errors[0].path).toBe('/status');
  });

  it('rejects a non-string runtimeDslVersion', () => {
    const result = validateRuntimeSession({ ...good, runtimeDslVersion: 1 });
    expect(result.valid).toBe(false);
  });

  it('rejects a present-but-malformed runtimeDslVersion stamp', () => {
    // A well-formed string that is not `x.y.z` would pass the typeof check yet
    // make `migrateRuntime`/`runtimeDslVersionOf` throw downstream — reject it
    // at the door.
    const result = validateRuntimeSession({ ...good, runtimeDslVersion: 'legacy' });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(result.errors.map((e) => e.path)).toContain('/runtimeDslVersion');
  });

  it('accepts a well-formed runtimeDslVersion stamp', () => {
    expect(validateRuntimeSession({ ...good, runtimeDslVersion: '0.1.0' })).toEqual({
      valid: true,
    });
  });

  it('rejects a stray document-line dslVersion on a session', () => {
    // A session versions on `runtimeDslVersion`; `dslVersion` never belongs on
    // its shape. This is the deliberate exception to the structural-subset rule:
    // a stray sibling stamp is evidence of a misrouted migration, and once
    // stored it makes the envelope ambiguous to the cross-line guard (which
    // fails loud on own-stamp-absent + sibling-stamp-present) — so reject it at
    // the door, whatever its value.
    for (const stray of ['legacy', '0.1.0']) {
      const result = validateRuntimeSession({ ...good, dslVersion: stray });
      expect(result.valid).toBe(false);
      if (result.valid) throw new Error('unreachable');
      expect(result.errors.map((e) => e.path)).toContain('/dslVersion');
    }
    // Rejected even alongside a well-formed own-line stamp: a doubly-stamped
    // session is equally the product of a misroute.
    const doubly = validateRuntimeSession({
      ...good,
      runtimeDslVersion: '0.1.0',
      dslVersion: '0.1.0',
    });
    expect(doubly.valid).toBe(false);
  });

  it('reports an empty-string createdAt exactly once, at /createdAt', () => {
    // The required-field table already flags an empty string as non-empty; the
    // ISO refinement must not fire a second error at the same path.
    const result = validateRuntimeSession({ ...good, createdAt: '' });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    const createdAtErrors = result.errors.filter((e) => e.path === '/createdAt');
    expect(createdAtErrors).toHaveLength(1);
  });

  it('rejects an empty required string (learnerKey)', () => {
    // `''` passes typeof but is useless as a partition key.
    const result = validateRuntimeSession({ ...good, learnerKey: '' });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(result.errors.map((e) => e.path)).toContain('/learnerKey');
  });

  it('rejects a non-ISO-8601 createdAt / updatedAt (contract says ISO 8601)', () => {
    // These pass the `typeof === 'string'` table check but are not timestamps;
    // the contract docs call them ISO 8601, so a bare string is not enough.
    const bad = validateRuntimeSession({
      ...good,
      createdAt: 'not-a-date',
      updatedAt: 'still-bad',
    });
    expect(bad.valid).toBe(false);
    if (bad.valid) throw new Error('unreachable');
    const paths = bad.errors.map((e) => e.path);
    expect(paths).toContain('/createdAt');
    expect(paths).toContain('/updatedAt');
  });

  it('rejects a calendar-impossible ISO date (month 13)', () => {
    // Well-formed shape but not a real date: the regex alone would accept it,
    // so `Date.parse` calendar validity is what rejects it.
    const r = validateRuntimeSession({ ...good, createdAt: '2026-13-01T00:00:00.000Z' });
    expect(r.valid).toBe(false);
    if (r.valid) throw new Error('unreachable');
    expect(r.errors.map((e) => e.path)).toContain('/createdAt');
  });

  it('accepts an ISO-8601 offset timestamp form', () => {
    expect(validateRuntimeSession({ ...good, createdAt: '2026-01-01T08:00:00+08:00' })).toEqual({
      valid: true,
    });
  });
});

describe('validateRuntimeRecord', () => {
  const good = {
    id: 'r1',
    sessionId: 's1',
    seq: 0,
    createdAt: '2026-01-01T00:00:01.000Z',
    payload: { role: 'user', content: 'hi' },
  };

  it('accepts a minimal valid record (payload is opaque)', () => {
    expect(validateRuntimeRecord(good)).toEqual({ valid: true });
  });

  it('accepts optional anchors of the right shape', () => {
    expect(
      validateRuntimeRecord({ ...good, sceneId: 'sc1', actionIndex: 2, subAnchor: 'q3' }),
    ).toEqual({ valid: true });
  });

  it('rejects a record with no payload key', () => {
    const { payload: _payload, ...rest } = good;
    const result = validateRuntimeRecord(rest);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(result.errors.map((e) => e.path)).toContain('/payload');
  });

  it('rejects an explicit `payload: undefined` but accepts a null payload', () => {
    // `'payload' in doc` would pass an explicit-undefined; require a real value.
    // `null` stays legal — it is a value the app may have deliberately stored.
    const undef = validateRuntimeRecord({ ...good, payload: undefined });
    expect(undef.valid).toBe(false);
    if (undef.valid) throw new Error('unreachable');
    expect(undef.errors.map((e) => e.path)).toContain('/payload');
    expect(validateRuntimeRecord({ ...good, payload: null })).toEqual({ valid: true });
  });

  it('rejects a seq that is not a non-negative integer', () => {
    // `seq` is the sole replay ordering key; NaN/Infinity/negative/fractional
    // all pass `typeof === "number"` but would corrupt ordering.
    for (const seq of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      const r = validateRuntimeRecord({ ...good, seq });
      expect(r.valid).toBe(false);
      if (r.valid) throw new Error('unreachable');
      expect(r.errors.map((e) => e.path)).toContain('/seq');
    }
    expect(validateRuntimeRecord({ ...good, seq: 0 })).toEqual({ valid: true });
  });

  it('rejects a negative optional actionIndex', () => {
    const r = validateRuntimeRecord({ ...good, actionIndex: -1 });
    expect(r.valid).toBe(false);
    if (r.valid) throw new Error('unreachable');
    expect(r.errors.map((e) => e.path)).toContain('/actionIndex');
  });

  it('rejects an empty required string (id)', () => {
    const r = validateRuntimeRecord({ ...good, id: '' });
    expect(r.valid).toBe(false);
    if (r.valid) throw new Error('unreachable');
    expect(r.errors.map((e) => e.path)).toContain('/id');
  });

  it('rejects wrongly-typed optional anchors', () => {
    expect(validateRuntimeRecord({ ...good, actionIndex: 'x' }).valid).toBe(false);
    expect(validateRuntimeRecord({ ...good, sceneId: 5 }).valid).toBe(false);
    expect(validateRuntimeRecord({ ...good, subAnchor: 5 }).valid).toBe(false);
  });

  it('rejects missing required fields with paths', () => {
    const result = validateRuntimeRecord({});
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    const paths = result.errors.map((e) => e.path);
    for (const p of ['/id', '/sessionId', '/seq', '/createdAt', '/payload']) {
      expect(paths).toContain(p);
    }
  });

  it('rejects a non-ISO-8601 createdAt (contract says ISO 8601)', () => {
    const r = validateRuntimeRecord({ ...good, createdAt: 'not-a-date' });
    expect(r.valid).toBe(false);
    if (r.valid) throw new Error('unreachable');
    expect(r.errors.map((e) => e.path)).toContain('/createdAt');
    // A calendar-impossible but well-formed date is rejected too (Date.parse).
    expect(validateRuntimeRecord({ ...good, createdAt: '2026-13-01T00:00:00.000Z' }).valid).toBe(
      false,
    );
    // An offset form is accepted.
    expect(validateRuntimeRecord({ ...good, createdAt: '2026-01-01T08:00:00+08:00' })).toEqual({
      valid: true,
    });
  });
});
