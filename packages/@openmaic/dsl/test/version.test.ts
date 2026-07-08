import { describe, it, expect } from 'vitest';
import {
  DSL_VERSION,
  UNVERSIONED_DSL_VERSION,
  INITIAL_DSL_VERSION,
  INITIAL_RUNTIME_DSL_VERSION,
  DSL_VERSION_KEY,
  DSL_MIGRATIONS,
  RUNTIME_DSL_VERSION,
  RUNTIME_DSL_VERSION_KEY,
  RUNTIME_DSL_MIGRATIONS,
  dslVersionOf,
  runtimeDslVersionOf,
  needsMigration,
  needsRuntimeMigration,
  migrate,
  migrateRuntime,
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

describe('RUNTIME_DSL_MIGRATIONS ladder invariants', () => {
  it('is empty today — the runtime line has no unversioned epoch to lift from', () => {
    // Unlike the document ladder, the runtime ladder ships EMPTY: the runtime
    // envelope is brand new (nothing legitimately predates it), so there is no
    // legacy-lift first entry. It stays a valid, fully-functional ladder — an
    // empty ladder just means every stamped-current session is already at the
    // target and no walk is needed.
    expect(RUNTIME_DSL_MIGRATIONS.length).toBe(0);
  });

  it('IF non-empty (future), starts at the pinned initial version and chains to RUNTIME_DSL_VERSION', () => {
    // Guards the invariants the *first real* runtime shape change must satisfy.
    // Vacuously true while empty; becomes a real check the moment a step is
    // appended. The first `from` is pinned to INITIAL_RUNTIME_DSL_VERSION — the
    // runtime line has no unversioned epoch, so a ladder starting anywhere
    // earlier (e.g. a copy-pasted 0.0.0 legacy lift) would reintroduce the
    // lift-arbitrary-unstamped-data hole this model removed.
    if (RUNTIME_DSL_MIGRATIONS.length > 0) {
      expect(RUNTIME_DSL_MIGRATIONS[0].from).toBe(INITIAL_RUNTIME_DSL_VERSION);
      expect(RUNTIME_DSL_MIGRATIONS[RUNTIME_DSL_MIGRATIONS.length - 1].to).toBe(
        RUNTIME_DSL_VERSION,
      );
    }
    for (let i = 1; i < RUNTIME_DSL_MIGRATIONS.length; i++) {
      expect(RUNTIME_DSL_MIGRATIONS[i].from).toBe(RUNTIME_DSL_MIGRATIONS[i - 1].to);
    }
  });
});

describe('migrateRuntime', () => {
  it('throws on an unstamped object — the runtime line has no unversioned epoch', () => {
    // Unlike the document line, an unstamped object is NOT legacy data to lift:
    // sessions are born stamped, so this is a misrouted legacy document or an
    // unstamped producer write — fail loud instead of inventing a version.
    expect(() => migrateRuntime({ id: 'sess' })).toThrow(/no unversioned epoch/);
  });

  it('is idempotent on a stamped-current session and returns non-objects unchanged', () => {
    // An already-current (stamped) session early-returns by reference — the
    // empty ladder needs no walk once the object is at the target version.
    const once = { id: 's', [RUNTIME_DSL_VERSION_KEY]: RUNTIME_DSL_VERSION };
    expect(migrateRuntime(once)).toBe(once);
    expect(migrateRuntime(migrateRuntime(once))).toBe(once);
    // Non-objects are not migratable aggregates: returned as-is on every line,
    // never subject to the no-epoch throw.
    expect(migrateRuntime(42)).toBe(42);
    expect(migrateRuntime(null)).toBe(null);
  });

  it('stamps only the runtime envelope field, never the document key', () => {
    // A doubly-stamped-free session at the current version keeps the runtime
    // stamp and never grows a `dslVersion`.
    const out = migrateRuntime({
      id: 'sess',
      [RUNTIME_DSL_VERSION_KEY]: RUNTIME_DSL_VERSION,
    }) as Record<string, unknown>;
    expect(out[RUNTIME_DSL_VERSION_KEY]).toBe(RUNTIME_DSL_VERSION);
    expect(out[DSL_VERSION_KEY]).toBeUndefined();
  });

  it('leaves a forward-versioned runtime document untouched', () => {
    const future = { id: 's', [RUNTIME_DSL_VERSION_KEY]: '99.0.0' };
    expect(migrateRuntime(future)).toBe(future);
  });

  it('fails loud when the ladder has no path from the runtime version', () => {
    // A runtime version older than RUNTIME_DSL_VERSION with no matching `from`
    // entry — with an empty ladder, ANY stamped-older version hits this. Mirrors
    // the document ladder's unbridgeable-stamp case.
    expect(() => migrateRuntime({ id: 's', [RUNTIME_DSL_VERSION_KEY]: '0.0.5' })).toThrow(
      /no migration path/,
    );
  });

  it('fails loud on a malformed stamp', () => {
    expect(() => migrateRuntime({ id: 's', [RUNTIME_DSL_VERSION_KEY]: '0.1' })).toThrow(
      /invalid runtimeDslVersion/,
    );
  });
});

describe('cross-line guard (ambiguous envelopes fail loud, not reinterpreted)', () => {
  it('migrate() throws on a runtime-stamped object — no document lift, no silent skip', () => {
    // Case (3): own stamp (dslVersion) ABSENT + other line's stamp
    // (runtimeDslVersion) PRESENT. Byte-identical to "runtime session misrouted
    // into the document runner" AND to "document carrying a stray runtime
    // stamp" — walking the ladder would mangle the former, returning it
    // unchanged would orphan the latter, so the only safe answer is to throw.
    const session = { id: 's', [RUNTIME_DSL_VERSION_KEY]: RUNTIME_DSL_VERSION };
    expect(() => migrate(session)).toThrow(/carries "runtimeDslVersion" but no "dslVersion"/);
  });

  it('migrateRuntime() throws on a document-stamped object — no runtime lift, no orphaning', () => {
    // Symmetric case (3): own stamp (runtimeDslVersion) ABSENT + document
    // line's stamp (dslVersion) PRESENT. Same undecidable state, mirrored:
    // fail loud instead of guessing.
    const doc = { id: 'd', [DSL_VERSION_KEY]: DSL_VERSION };
    expect(() => migrateRuntime(doc)).toThrow(/carries "dslVersion" but no "runtimeDslVersion"/);
  });

  it('an object carrying BOTH stamps migrates normally on each runner’s own line', () => {
    // Case (1): own line's stamp present → migrate normally on own line,
    // regardless of the other key. The guard only fires when the OWN stamp is
    // absent, so a doubly-stamped envelope is handled by each runner exactly as
    // if the other stamp were not there.
    const both = {
      id: 'x',
      [DSL_VERSION_KEY]: DSL_VERSION,
      [RUNTIME_DSL_VERSION_KEY]: RUNTIME_DSL_VERSION,
    };
    // Each runner sees its own line already current → idempotent no-op, and
    // leaves the other line's stamp intact.
    const migrated = migrate(both) as Record<string, unknown>;
    expect(migrated[DSL_VERSION_KEY]).toBe(DSL_VERSION);
    expect(migrated[RUNTIME_DSL_VERSION_KEY]).toBe(RUNTIME_DSL_VERSION);
    const migratedRuntime = migrateRuntime(both) as Record<string, unknown>;
    expect(migratedRuntime[RUNTIME_DSL_VERSION_KEY]).toBe(RUNTIME_DSL_VERSION);
    expect(migratedRuntime[DSL_VERSION_KEY]).toBe(DSL_VERSION);
  });

  it('an object with NEITHER stamp: document line lifts it, runtime line throws (no epoch)', () => {
    // Case (2), but the two lines diverge here. The document line HAS an
    // unversioned epoch → genuine legacy data, lifted onto its own ladder. The
    // runtime line has NO unversioned epoch → an unstamped object is a misrouted
    // legacy document or an unstamped producer write, so it fails loud instead.
    const legacy = { id: 'z', name: 'course' };
    const lifted = migrate(legacy) as Record<string, unknown>;
    expect(lifted[DSL_VERSION_KEY]).toBe(DSL_VERSION);
    expect(lifted[RUNTIME_DSL_VERSION_KEY]).toBeUndefined();
    expect(lifted.name).toBe('course');

    expect(() => migrateRuntime(legacy)).toThrow(/no unversioned epoch/);
  });
});

describe('runtimeDslVersionOf', () => {
  it('reads a stamped runtime version', () => {
    expect(runtimeDslVersionOf({ [RUNTIME_DSL_VERSION_KEY]: '9.9.9' })).toBe('9.9.9');
  });
  it('throws on an unstamped object (no unversioned epoch)', () => {
    // The runtime line has no legacy epoch, so an unstamped object does not read
    // as `0.0.0` here — it throws, matching migrateRuntime / needsRuntimeMigration.
    expect(() => runtimeDslVersionOf({ id: 'x' })).toThrow(/no unversioned epoch/);
  });
  it('reads non-objects as unversioned (not migratable aggregates)', () => {
    // Non-objects are exempt from the no-epoch throw on every line — they are not
    // migratable aggregates and read as the unversioned sentinel.
    expect(runtimeDslVersionOf(null)).toBe(UNVERSIONED_DSL_VERSION);
    expect(runtimeDslVersionOf('nope')).toBe(UNVERSIONED_DSL_VERSION);
  });
  it('throws on an ambiguous document-stamped envelope (authoritative read)', () => {
    // Reading this as unversioned would report `0.0.0` for data migrateRuntime
    // refuses to touch — the reader applies the same cross-line rule.
    expect(() => runtimeDslVersionOf({ [DSL_VERSION_KEY]: '9.9.9' })).toThrow(
      /carries "dslVersion" but no "runtimeDslVersion"/,
    );
  });
  it('throws on a present-but-malformed runtime stamp', () => {
    expect(() => runtimeDslVersionOf({ [RUNTIME_DSL_VERSION_KEY]: '0.1' })).toThrow(
      /invalid runtimeDslVersion/,
    );
  });
});

describe('needsRuntimeMigration', () => {
  it('throws on an unstamped session (no epoch) and is false at/ahead of the current version', () => {
    // No unversioned epoch: an unstamped object is a bug, not legacy data, so the
    // predicate throws — matching migrateRuntime, so a
    // `while (needsRuntimeMigration(x)) x = migrateRuntime(x)` loop fails loud on
    // the same input rather than spinning.
    expect(() => needsRuntimeMigration({ id: 'legacy' })).toThrow(/no unversioned epoch/);
    expect(needsRuntimeMigration({ [RUNTIME_DSL_VERSION_KEY]: RUNTIME_DSL_VERSION })).toBe(false);
    expect(needsRuntimeMigration({ [RUNTIME_DSL_VERSION_KEY]: '99.0.0' })).toBe(false);
  });
  it('agrees with migrateRuntime on non-objects (loop terminates)', () => {
    for (const v of [42, null, undefined, 'x', []]) {
      expect(needsRuntimeMigration(v)).toBe(false);
      expect(needsRuntimeMigration(migrateRuntime(v))).toBe(false);
    }
  });
  it('throws on an ambiguous document-stamped envelope (mirrors the runner guard)', () => {
    // migrateRuntime throws on a document-stamped object (cross-line guard), so
    // the predicate must throw the same error — quietly answering true would
    // spin a `while (needsRuntimeMigration(x)) x = migrateRuntime(x)` loop,
    // quietly answering false would misreport data the runner refuses to touch.
    const doc = { [DSL_VERSION_KEY]: DSL_VERSION, id: 'doc' };
    expect(() => needsRuntimeMigration(doc)).toThrow(
      /carries "dslVersion" but no "runtimeDslVersion"/,
    );
    // Doubly-stamped data is the runtime line's own: predicate and runner both
    // act on the runtime stamp as usual.
    expect(
      needsRuntimeMigration({ [DSL_VERSION_KEY]: DSL_VERSION, [RUNTIME_DSL_VERSION_KEY]: '0.0.0' }),
    ).toBe(true);
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
  it('throws on an ambiguous runtime-stamped envelope (authoritative read)', () => {
    // The reader, the predicate, and the runner give one answer per envelope:
    // this state throws everywhere instead of reading as `0.0.0` here while
    // `migrate` refuses to touch it.
    expect(() => dslVersionOf({ [RUNTIME_DSL_VERSION_KEY]: '9.9.9' })).toThrow(
      /carries "runtimeDslVersion" but no "dslVersion"/,
    );
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
  it('throws on an ambiguous runtime-stamped envelope (mirrors the runner guard)', () => {
    // migrate throws on a runtime-stamped object (cross-line guard), so the
    // predicate must throw the same error rather than quietly answer either
    // way — see the needsRuntimeMigration counterpart for the two failure
    // modes a quiet answer would pick between.
    const session = { [RUNTIME_DSL_VERSION_KEY]: RUNTIME_DSL_VERSION, id: 's' };
    expect(() => needsMigration(session)).toThrow(
      /carries "runtimeDslVersion" but no "dslVersion"/,
    );
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
