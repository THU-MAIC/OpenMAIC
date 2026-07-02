import { describe, it, expect } from 'vitest';
import {
  DSL_VERSION,
  UNVERSIONED_DSL_VERSION,
  INITIAL_DSL_VERSION,
  DSL_VERSION_KEY,
  DSL_MIGRATIONS,
  dslVersionOf,
  needsMigration,
  migrate,
} from '@openmaic/dsl';

describe('DSL_MIGRATIONS ladder invariants', () => {
  it('is a contiguous chain ending at DSL_VERSION', () => {
    expect(DSL_MIGRATIONS.length).toBeGreaterThan(0);
    for (let i = 1; i < DSL_MIGRATIONS.length; i++) {
      // each step's `to` is the next step's `from`
      expect(DSL_MIGRATIONS[i].from).toBe(DSL_MIGRATIONS[i - 1].to);
    }
    expect(DSL_MIGRATIONS[DSL_MIGRATIONS.length - 1].to).toBe(DSL_VERSION);
  });

  it('begins by lifting legacy (unversioned) documents to a pinned endpoint', () => {
    expect(DSL_MIGRATIONS[0].from).toBe(UNVERSIONED_DSL_VERSION);
    // The endpoint is the *pinned* initial version, not the moving DSL_VERSION —
    // so a future step appended from INITIAL_DSL_VERSION isn't skipped once
    // DSL_VERSION moves past it. (They're equal today; the assertion guards the
    // intent, not the current value.)
    expect(DSL_MIGRATIONS[0].to).toBe(INITIAL_DSL_VERSION);
  });
});

describe('dslVersionOf', () => {
  it('reads a stamped version', () => {
    expect(dslVersionOf({ [DSL_VERSION_KEY]: '9.9.9' })).toBe('9.9.9');
  });
  it('treats an unstamped document as unversioned', () => {
    expect(dslVersionOf({ id: 'x' })).toBe(UNVERSIONED_DSL_VERSION);
    expect(dslVersionOf(null)).toBe(UNVERSIONED_DSL_VERSION);
    expect(dslVersionOf('nope')).toBe(UNVERSIONED_DSL_VERSION);
  });
  it('throws on a present-but-malformed stamp (no silent bypass)', () => {
    // "1", "0.1", "0.1.0-beta" would otherwise parse into a comparable version
    // and skip migration entirely.
    for (const bad of ['1', '0.1', '0.1.0-beta', 'x.y.z', '']) {
      expect(() => dslVersionOf({ [DSL_VERSION_KEY]: bad })).toThrow(/invalid dslVersion/);
    }
    expect(() => dslVersionOf({ [DSL_VERSION_KEY]: 3 })).toThrow(/invalid dslVersion/);
  });
});

describe('needsMigration', () => {
  it('is true for legacy documents and false at/ahead of the current version', () => {
    expect(needsMigration({ id: 'legacy' })).toBe(true);
    expect(needsMigration({ [DSL_VERSION_KEY]: DSL_VERSION })).toBe(false);
    expect(needsMigration({ [DSL_VERSION_KEY]: '99.0.0' })).toBe(false);
  });
  it('is false for non-objects (mirrors migrate no-op — never disagree)', () => {
    for (const v of [42, null, undefined, 'x', []]) {
      expect(needsMigration(v)).toBe(false);
      // the invariant: needsMigration and migrate agree on every input
      expect(needsMigration(migrate(v))).toBe(false);
    }
  });
  it('throws on a malformed stamp rather than silently reporting no migration', () => {
    expect(() => needsMigration({ [DSL_VERSION_KEY]: '0.1.0-beta' })).toThrow(/invalid dslVersion/);
  });
});

describe('migrate', () => {
  it('stamps a legacy document up to the current version', () => {
    const out = migrate({ id: 'legacy', name: 'course' }) as Record<string, unknown>;
    expect(out[DSL_VERSION_KEY]).toBe(DSL_VERSION);
    // payload is preserved
    expect(out.id).toBe('legacy');
    expect(out.name).toBe('course');
  });

  it('is idempotent (running twice equals running once)', () => {
    const once = migrate({ id: 'x' });
    const twice = migrate(once);
    expect(twice).toEqual(once);
    // an already-current document is returned by reference (no needless copy)
    expect(migrate(once)).toBe(once);
  });

  it('does not mutate its input', () => {
    const input = { id: 'x' };
    const frozen = Object.freeze({ ...input });
    const out = migrate(frozen);
    expect(out).not.toBe(frozen);
    expect(frozen).toEqual({ id: 'x' }); // untouched, no dslVersion added
  });

  it('leaves a forward-versioned document untouched (no silent downgrade)', () => {
    const future = { id: 'x', [DSL_VERSION_KEY]: '99.0.0', shinyNewField: true };
    expect(migrate(future)).toBe(future);
  });

  it('fails loud when the ladder has no path from the document version', () => {
    // A version older than DSL_VERSION but with no matching `from` entry.
    expect(() => migrate({ id: 'x', [DSL_VERSION_KEY]: '0.0.5' })).toThrow(/no migration path/);
  });

  it('fails loud on a malformed version stamp (no silent no-op)', () => {
    expect(() => migrate({ id: 'x', [DSL_VERSION_KEY]: '0.1' })).toThrow(/invalid dslVersion/);
    expect(() => migrate({ id: 'x', [DSL_VERSION_KEY]: '0.1.0-beta' })).toThrow(
      /invalid dslVersion/,
    );
  });

  it('returns non-object inputs unchanged', () => {
    expect(migrate(42)).toBe(42);
    expect(migrate(null)).toBe(null);
  });
});
