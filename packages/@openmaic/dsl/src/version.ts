/**
 * DSL version + migration registry.
 *
 * The DSL version is independent of the npm package version: it identifies the
 * shape of the *serialized* slide contract so that persisted documents can be
 * migrated forward as the schema evolves. A package release can bump for
 * code/API reasons (new exports, refactors) without touching the serialized
 * shape — in which case {@link DSL_VERSION} stays put; conversely the first
 * breaking change to the on-disk shape bumps {@link DSL_VERSION} and appends a
 * migration, regardless of where the package version happens to be.
 *
 * This module owns the *mechanism*: the ordered {@link DSL_MIGRATIONS} ladder,
 * plus the pure {@link migrate} runner that walks a document from whatever
 * version it was written at up to {@link DSL_VERSION}. It carries no runtime
 * dependency, and — like every migration transform — is pure and idempotent.
 *
 * The migratable unit (a {@link Stage} aggregate, a single Scene row, or a
 * bundle of them) is deliberately left open: the runner only needs the
 * {@link DSL_VERSION_KEY} envelope field to read the current version and stamp
 * the new one. Which aggregate carries that field is decided when a normalized
 * store first consumes this pipeline.
 */

/** Current version of the serialized slide contract. */
export const DSL_VERSION = '0.1.0' as const;

export type DslVersion = typeof DSL_VERSION;

/**
 * The version a document is treated as when it carries no {@link DSL_VERSION_KEY}
 * stamp: everything written before the version field existed. The first
 * {@link DSL_MIGRATIONS} entry lifts these legacy documents forward.
 *
 * A **document-line-only** concept. The runtime line has no unversioned epoch —
 * its envelope is brand new and stamped at write time, so it lifts nothing (see
 * {@link RUNTIME_DSL_MIGRATIONS} / {@link noRuntimeEpochError}). This constant
 * therefore names the document line's legacy origin; the runtime runner passes
 * `null` for its legacy version instead of reusing it.
 */
export const UNVERSIONED_DSL_VERSION = '0.0.0' as const;

/**
 * The first shipped serialized-contract version — a **pinned literal**, not the
 * moving {@link DSL_VERSION}. Migration endpoints must be immutable: they name a
 * fixed point in the ladder, so they cannot reference `DSL_VERSION` (which moves
 * every time the shape changes). It equals `DSL_VERSION` today; the two diverge
 * the moment the first real shape change bumps `DSL_VERSION` and appends a step
 * from here.
 */
export const INITIAL_DSL_VERSION = '0.1.0' as const;

/**
 * Envelope property that carries the serialized-contract version on a document.
 * Named so producers / stores stamp the same field the runner reads.
 */
export const DSL_VERSION_KEY = 'dslVersion' as const;

/**
 * Envelope property that carries the serialized-contract version on a runtime
 * session. Mechanically **disjoint** from {@link DSL_VERSION_KEY}: the two
 * version lines stamp different fields, so neither ladder can read, consume, or
 * corrupt the other's stamp.
 *
 * Disjoint keys are necessary but **not sufficient** to protect misrouted
 * data: an object carrying only this key still *lacks* {@link DSL_VERSION_KEY},
 * so the document runner would read it as {@link UNVERSIONED_DSL_VERSION} and
 * walk its legacy ladder over the session — stamping a foreign field and, once
 * a real transform lands, mangling the payload. The cross-line guard in
 * {@link runLadder} closes this: a runner whose own stamp is absent but whose
 * sibling's stamp is present **throws** rather than guessing. See that function
 * for the three-case semantics.
 */
export const RUNTIME_DSL_VERSION_KEY = 'runtimeDslVersion' as const;

/**
 * A document that may carry a DSL contract-version stamp. `@openmaic/dsl` does
 * not bind this to a specific aggregate (see the module note) — it is the
 * minimal envelope the {@link migrate} runner reads and writes.
 */
export interface DslVersioned {
  /** Serialized-contract version this document was written at. Absent on legacy data. */
  dslVersion?: string;
}

/**
 * A runtime aggregate that **may** carry a runtime-contract version stamp — the
 * envelope-layer type the readers ({@link runtimeDslVersionOf}), predicate
 * ({@link needsRuntimeMigration}), and runner ({@link migrateRuntime}) operate
 * over, all of which accept `unknown` and tolerate an absent stamp at the type
 * level. The runtime counterpart of {@link DslVersioned}, stamped by
 * {@link migrateRuntime} on a **different** envelope field
 * ({@link RUNTIME_DSL_VERSION_KEY}) so the two version lines are
 * byte-distinguishable, not convention-separated.
 *
 * The field is optional *here* because this is the "may carry" envelope view.
 * For a {@link RuntimeSession} the stamp is **required** — sessions are born
 * stamped, there is no unversioned epoch (see {@link RUNTIME_DSL_VERSION}), so an
 * absent `runtimeDslVersion` is only a transient in-memory state before the
 * producer stamps it, never a stored one; a stored session without it is a bug
 * the runtime-line functions and {@link RuntimeSession}'s required override both
 * reject.
 */
export interface RuntimeVersioned {
  /**
   * Runtime-contract version this aggregate was written at. Optional on this
   * envelope view; {@link RuntimeSession} overrides it to required (born stamped,
   * no legacy epoch).
   */
  runtimeDslVersion?: string;
}

/**
 * A pure, synchronous transform from one DSL version to the next. Migrations
 * MUST NOT have side effects and MUST NOT depend on any runtime library. They
 * receive and return the whole document; the runner stamps the `to` version, so
 * a transform need only reshape the payload.
 */
export interface DslMigration {
  /** Version this migration upgrades *from*. */
  from: string;
  /** Version this migration upgrades *to*. */
  to: string;
  /** Pure upgrade transform. */
  migrate: (doc: unknown) => unknown;
}

/**
 * Ordered migration ladder. Each entry's `to` is the next entry's `from`, and
 * the last entry's `to` is {@link DSL_VERSION} (both checked by a test). Every
 * `from` / `to` is a **pinned literal** — never the moving `DSL_VERSION`
 * constant — so appending a future step can't retroactively re-target an
 * existing one.
 *
 * The first entry stamps legacy (pre-`dslVersion`) documents up to
 * {@link INITIAL_DSL_VERSION}. It is intentionally a no-op *transform*: bringing
 * `Action` into the contract (#811) and adding validators (#817) did not alter
 * any serialized document, so the current on-disk shape already *is* 0.1.0. The
 * entry exists to wire the pipeline end to end and to give real documents a
 * version stamp to migrate forward from. When the serialized shape first
 * changes, bump {@link DSL_VERSION} *then* and append a real transform from
 * `INITIAL_DSL_VERSION` to the new pinned version.
 */
export const DSL_MIGRATIONS: readonly DslMigration[] = [
  { from: UNVERSIONED_DSL_VERSION, to: INITIAL_DSL_VERSION, migrate: (doc) => doc },
];

/**
 * Current version of the serialized *runtime* contract (#869) — the on-disk
 * shape of a {@link RuntimeSession}, NOT the slide document.
 *
 * This is a **deliberately separate version line** from {@link DSL_VERSION},
 * and the separation is mechanical, not by convention: a {@link RuntimeSession}
 * stamps its version on {@link RUNTIME_DSL_VERSION_KEY}, a distinct envelope
 * field from the document's {@link DSL_VERSION_KEY}. The two ladders version
 * independent serialized shapes, so a change to the document (Stage/Scene) shape
 * must never force — or, worse, accidentally *consume* — a runtime step, and
 * vice versa. A `DslMigration` body is an arbitrary whole-document transform;
 * if runtime sessions rode `DSL_MIGRATIONS`, a future real Stage/Scene migration
 * authored against the document shape would run over a `RuntimeSession` and
 * could corrupt or throw.
 *
 * The disjoint stamp fields keep each ladder from reading the other's version,
 * but they do not by themselves stop a misrouted aggregate from being lifted on
 * the wrong line (it simply reads as unversioned there). The cross-line guard in
 * {@link runLadder} closes this: a runner **throws** on any aggregate that
 * carries the *sibling* line's stamp but not its own, so a misrouted document
 * migration surfaces as an error instead of stamping a foreign `dslVersion`
 * onto a runtime session.
 *
 * Unlike {@link DSL_VERSION}, this line has **no unversioned epoch**. Real
 * pre-versioning *documents* exist, so the document line lifts an unstamped
 * document from {@link UNVERSIONED_DSL_VERSION}; nothing legitimately predates
 * the runtime envelope, and the future `RuntimeStore` stamps this version at
 * write time. So an object reaching a runtime-line function *without* a stamp is
 * not legacy data — it is a misrouted legacy document or an unstamped producer
 * write, and fails loud (see {@link noRuntimeEpochError}) rather than being
 * lifted. {@link RUNTIME_DSL_MIGRATIONS} accordingly ships empty.
 */
export const RUNTIME_DSL_VERSION = '0.1.0' as const;

export type RuntimeDslVersion = typeof RUNTIME_DSL_VERSION;

/**
 * The first shipped runtime-contract version — a **pinned literal**, not the
 * moving {@link RUNTIME_DSL_VERSION} (see {@link INITIAL_DSL_VERSION} for why
 * migration endpoints must be immutable). Equal to `RUNTIME_DSL_VERSION` today;
 * the two diverge the moment the runtime shape first changes.
 *
 * The runtime line **starts here**, not at an unversioned epoch: there is no
 * pre-versioning runtime data to lift, so {@link RUNTIME_DSL_MIGRATIONS} ships
 * empty and this pinned version is the `from` of the first real step appended
 * when the runtime shape first changes.
 */
export const INITIAL_RUNTIME_DSL_VERSION = '0.1.0' as const;

/**
 * Ordered migration ladder for the runtime contract, wholly independent of
 * {@link DSL_MIGRATIONS}. Same invariants when non-empty (contiguous chain, last
 * `to` === {@link RUNTIME_DSL_VERSION}, every endpoint a **pinned literal**), but
 * — unlike the document ladder — it starts **empty**, with NO legacy-lift entry.
 *
 * The runtime line has **no unversioned epoch**. Its envelope is a brand-new
 * contract: the future `RuntimeStore` stamps {@link RUNTIME_DSL_VERSION} at write
 * time, so nothing legitimately predates {@link INITIAL_RUNTIME_DSL_VERSION} and
 * there is no pre-versioning runtime data to lift. An unstamped object reaching
 * {@link migrateRuntime} is therefore a bug, not legacy data, and fails loud (see
 * {@link noRuntimeEpochError}) rather than being lifted by a no-op first entry.
 *
 * The first real runtime shape change bumps {@link RUNTIME_DSL_VERSION} and
 * appends a step from the pinned {@link INITIAL_RUNTIME_DSL_VERSION} to the new
 * version — the same append discipline as {@link DSL_MIGRATIONS}, just without a
 * pre-seeded legacy row. An empty ladder is fully functional: a session already
 * stamped at {@link RUNTIME_DSL_VERSION} early-returns from {@link migrateRuntime}
 * as current, and a session stamped at some unknown older version hits the
 * "no migration path" fail-loud.
 */
export const RUNTIME_DSL_MIGRATIONS: readonly DslMigration[] = [];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A well-formed `x.y.z` version: exactly three non-negative integer parts.
 *
 * Exported so the envelope validators can reject a present-but-malformed version
 * stamp (either line's — `dslVersion` or `runtimeDslVersion`) at their boundary
 * — the same well-formedness rule that {@link dslVersionOf} /
 * {@link runtimeDslVersionOf} / {@link migrate} / {@link migrateRuntime} enforce
 * by throwing — rather than letting a bad stamp pass a mere `typeof` check and
 * blow up downstream.
 */
export function isWellFormedDslVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(v);
}

/** Parse a validated `x.y.z` version into numeric parts. */
function parseVersion(v: string): [number, number, number] {
  const [x, y, z] = v.split('.').map((p) => Number.parseInt(p, 10));
  return [x, y, z];
}

/** Pure semver-ish compare over `x.y.z`. Returns <0, 0, or >0. */
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Read the version an aggregate was written at from an arbitrary envelope
 * `key`. The shared engine behind {@link dslVersionOf} (document line) and
 * {@link runtimeDslVersionOf} (runtime line) — each passes its own key, so the
 * two lines read disjoint fields and never conflate. This is where every
 * envelope rule is enforced, so the plain readers, the `needs*Migration`
 * predicates, and the migration runners all give one answer for one envelope:
 *
 * - A non-object is not a migratable aggregate: it is treated as
 *   {@link UNVERSIONED_DSL_VERSION} on every line, an established convention the
 *   runners (return input) and predicates (false) mirror. `legacyVersion` does
 *   NOT govern non-objects — only the "object present but wholly unstamped" case.
 * - An object with neither line's stamp is legacy / pre-versioning data. What
 *   that means depends on the line: the caller passes `legacyVersion` = the
 *   version an unstamped aggregate is lifted from ({@link UNVERSIONED_DSL_VERSION}
 *   for the document line, whose real pre-versioning documents exist), or `null`
 *   for a line with **no unversioned epoch** (the runtime line — its envelope is
 *   brand new, nothing legitimately predates it), in which case this **throws**
 *   {@link noRuntimeEpochError} rather than inventing a version for a misrouted
 *   legacy document or an unstamped producer write.
 * - A **present but malformed** stamp (not a well-formed `x.y.z` string) is
 *   corrupt data making a false version claim, so this **throws** rather than
 *   letting a bad stamp silently compare as some arbitrary version and bypass
 *   migration.
 * - An **ambiguous cross-line envelope** — own `key` absent, sibling `otherKey`
 *   present — also **throws** (see {@link crossLineError}). Reading it as
 *   unversioned would let a version report claim `0.0.0` for data the runner
 *   refuses to migrate.
 */
function versionOf(
  doc: unknown,
  key: string,
  otherKey: string,
  legacyVersion: string | null,
): string {
  if (!isObject(doc)) return UNVERSIONED_DSL_VERSION;
  const raw = doc[key];
  if (raw === undefined) {
    if (doc[otherKey] !== undefined) throw crossLineError(key, otherKey);
    if (legacyVersion === null) throw noRuntimeEpochError();
    return legacyVersion;
  }
  if (typeof raw !== 'string' || !isWellFormedDslVersion(raw)) {
    throw new Error(
      `@openmaic/dsl: invalid ${key} stamp ${JSON.stringify(raw)} (expected "x.y.z")`,
    );
  }
  return raw;
}

/**
 * Read the serialized *document* contract version a document was written at,
 * from its {@link DSL_VERSION_KEY} envelope field. An authoritative read: it
 * applies every envelope rule — unstamped, malformed-stamp, and the cross-line
 * throw on an ambiguous envelope — so callers reporting a version never claim
 * one for data {@link migrate} refuses to touch (see {@link versionOf}).
 */
export function dslVersionOf(doc: unknown): string {
  return versionOf(doc, DSL_VERSION_KEY, RUNTIME_DSL_VERSION_KEY, UNVERSIONED_DSL_VERSION);
}

/**
 * Read the serialized *runtime* contract version a session was written at, from
 * its {@link RUNTIME_DSL_VERSION_KEY} envelope field — the runtime-line
 * counterpart of {@link dslVersionOf}, reading a disjoint field. Same rules,
 * including the cross-line throw on an ambiguous envelope (see
 * {@link versionOf}), with **one difference**: the runtime line has no
 * unversioned epoch, so an unstamped object (not a non-object — those still read
 * as {@link UNVERSIONED_DSL_VERSION}) **throws** {@link noRuntimeEpochError}
 * rather than reading as `0.0.0`. Sessions are stamped with
 * {@link RUNTIME_DSL_VERSION} at write time; an unstamped one here is a misrouted
 * legacy document or an unstamped producer write, both bugs.
 */
export function runtimeDslVersionOf(doc: unknown): string {
  return versionOf(doc, RUNTIME_DSL_VERSION_KEY, DSL_VERSION_KEY, null);
}

/**
 * Shared predicate behind {@link needsMigration} and
 * {@link needsRuntimeMigration}: true when `doc` is an object stamped (on
 * envelope `key`) older than `targetVersion`. It mirrors its runner on every
 * input, so the two never disagree and a `while (needs…(x)) x = migrate…(x)`
 * loop always terminates: `false` for a non-object (the runners return those
 * as-is), and the same **throw** as {@link runLadder}'s cross-line guard for an
 * ambiguous envelope (own stamp absent, `otherKey` stamp present) — quietly
 * answering either way there would misreport data the runner refuses to touch.
 * Also throws on a malformed own-line stamp, and — when this line has no
 * unversioned epoch (`legacyVersion === null`) — on an object with no stamp at
 * all (see {@link versionOf}).
 */
function needsLadder(
  doc: unknown,
  key: string,
  targetVersion: string,
  otherKey: string,
  legacyVersion: string | null,
): boolean {
  if (!isObject(doc)) return false;
  // The cross-line throw on an ambiguous envelope, and the no-epoch throw on a
  // wholly-unstamped object, both come from `versionOf` itself, so the
  // predicate, its runner, and the plain readers cannot drift.
  return compareVersions(versionOf(doc, key, otherKey, legacyVersion), targetVersion) < 0;
}

/**
 * The error thrown on an ambiguous cross-line envelope — own `key` absent,
 * sibling `otherKey` present. That state is undecidable: the other line's
 * aggregate misrouted here is byte-identical to this line's data carrying a
 * stray foreign stamp, and each silent answer locks in one failure mode
 * (walking the ladder mangles the former; treating it as current/unversioned
 * orphans the latter from its own line). Thrown from {@link versionOf}, the
 * single reader behind the runners, the `needs*Migration` predicates, and the
 * plain `*VersionOf` readers, so none of them can drift apart on what the
 * ambiguous state means.
 */
function crossLineError(key: string, otherKey: string): Error {
  return new Error(
    `@openmaic/dsl: object carries "${otherKey}" but no "${key}" — a misrouted ` +
      `aggregate from the other version line, or a stray foreign stamp; route it ` +
      `to the correct runner or repair the envelope before migrating`,
  );
}

/**
 * The error thrown when a runtime-line function is handed an object carrying no
 * version stamp at all. Unlike the document line — where real pre-versioning
 * documents exist and are lifted from {@link UNVERSIONED_DSL_VERSION} — the
 * runtime line has **no unversioned epoch**: its envelope is a brand-new
 * contract, the future `RuntimeStore` stamps {@link RUNTIME_DSL_VERSION} at write
 * time, so nothing legitimately predates it. An unstamped object reaching a
 * runtime-line reader / predicate / runner is therefore a bug — a misrouted
 * legacy document or an unstamped producer write — and fails loud rather than
 * being invented a version and lifted. Thrown from {@link versionOf} (the single
 * reader behind the runners, predicates, and plain readers) when its
 * `legacyVersion` argument is `null`, so none of them can drift on what an
 * unstamped runtime object means. Non-objects are exempt: they are not
 * migratable aggregates and read as {@link UNVERSIONED_DSL_VERSION} on every line.
 */
function noRuntimeEpochError(): Error {
  return new Error(
    `@openmaic/dsl: object carries no version stamp; the runtime line has no ` +
      `unversioned epoch — runtime sessions are stamped with "runtimeDslVersion" ` +
      `at write time, so an unstamped object here is a misrouted legacy document ` +
      `or an unstamped producer write`,
  );
}

/**
 * True when `doc` is a migratable document written at an older version than
 * {@link DSL_VERSION}. The document-line predicate (counterpart:
 * {@link needsRuntimeMigration}, which reads the runtime envelope field). It
 * mirrors {@link migrate} on every input — `false` for a non-object, the same
 * cross-line-guard throw for an ambiguous envelope — so the two never disagree
 * (a caller looping `while (needsMigration(x)) x = migrate(x)` always
 * terminates or fails loud on the same input). Throws on an object carrying a
 * malformed stamp (see {@link dslVersionOf}).
 */
export function needsMigration(doc: unknown): boolean {
  return needsLadder(
    doc,
    DSL_VERSION_KEY,
    DSL_VERSION,
    RUNTIME_DSL_VERSION_KEY,
    UNVERSIONED_DSL_VERSION,
  );
}

/**
 * True when `doc` is a runtime session written at an older version than
 * {@link RUNTIME_DSL_VERSION}. The runtime-line counterpart of
 * {@link needsMigration}: it reads {@link RUNTIME_DSL_VERSION_KEY} and pairs with
 * {@link migrateRuntime}, so a `while (needsRuntimeMigration(x)) x = migrateRuntime(x)`
 * loop always terminates or fails loud on the same input — on a misrouted
 * document-line aggregate both the predicate and the runner throw the same
 * cross-line-guard error. Pairing {@link needsMigration} with
 * {@link migrateRuntime} (or vice versa) once the lines diverge would spin or
 * silently skip — always pair a predicate with its own line's runner. Throws on
 * a malformed stamp, and — because the runtime line has **no unversioned
 * epoch** — on a wholly-unstamped object (a misrouted legacy document or an
 * unstamped producer write; see {@link noRuntimeEpochError}). Non-objects still
 * answer `false`, as on the document line.
 */
export function needsRuntimeMigration(doc: unknown): boolean {
  return needsLadder(doc, RUNTIME_DSL_VERSION_KEY, RUNTIME_DSL_VERSION, DSL_VERSION_KEY, null);
}

/**
 * Purely stamp an aggregate's version onto envelope `key`, returning a new
 * object (never mutating). Keyed so each ladder writes its own line's field.
 */
function stampVersion(doc: unknown, version: string, key: string): unknown {
  return isObject(doc) ? { ...doc, [key]: version } : doc;
}

/**
 * Migrate a document forward to {@link DSL_VERSION}.
 *
 * - Idempotent: a document already at {@link DSL_VERSION} is returned unchanged.
 * - Forward-compatible: a document stamped *newer* than {@link DSL_VERSION} is
 *   returned untouched rather than silently downgraded (mirrors the app's
 *   `migrateSlideContent`). The caller may not render it correctly, but its
 *   on-disk shape survives for the next compatible reader.
 * - Fail-loud: throws (rather than returning a half-migrated document) if the
 *   ladder has no contiguous path from the document's version up to
 *   {@link DSL_VERSION}, or if the document carries a malformed version stamp
 *   (see {@link dslVersionOf}).
 * - A non-object is not a migratable document: it is returned unchanged (and
 *   {@link needsMigration} agrees it needs nothing).
 *
 * Pure: never mutates the input; each step returns a fresh object stamped with
 * its target version.
 */
/**
 * Shared ladder runner behind {@link migrate} and {@link migrateRuntime}. The
 * walk / stamp / fail-loud mechanism is identical for both version lines; only
 * the `ladder`, its `targetVersion`, the own envelope `key`, and the *other*
 * line's `otherKey` differ, so they are parameters rather than duplicated. This
 * is what keeps the two ladders *independent* — each caller passes its own
 * steps, endpoint, and stamp field, so a document migration reads and writes
 * only `dslVersion` while the runtime ladder reads and writes only
 * `runtimeDslVersion`; neither can be walked over the other's stamp.
 *
 * **Cross-line guard.** Disjoint stamp keys alone do NOT protect misrouted
 * data: an aggregate carrying the *other* line's stamp still lacks this line's
 * key, so `versionOf` reads it as {@link UNVERSIONED_DSL_VERSION} and the runner
 * would walk its own legacy ladder over it — stamping a foreign key and, once a
 * real transform lands on either ladder, mangling or throwing on the other
 * line's payload. The guard is keyed on the presence of the two stamps:
 *
 * 1. Own line's stamp present → migrate normally on this line, regardless of the
 *    other key (a doubly-stamped envelope is each runner's own line's data).
 * 2. Both stamps absent → depends on the line. A line WITH an unversioned epoch
 *    (`legacyVersion` non-null, the document line) treats it as genuine legacy
 *    data and walks its ladder from `legacyVersion`. A line with NO unversioned
 *    epoch (`legacyVersion === null`, the runtime line) **throws**
 *    {@link noRuntimeEpochError}: its envelope is brand new and stamped at write
 *    time, so an unstamped object is a misrouted legacy document or an unstamped
 *    producer write, not migratable legacy data.
 * 3. Own stamp ABSENT + other line's stamp PRESENT → **throw**. The envelope
 *    cannot say whether this is the other line's aggregate misrouted here or
 *    this line's data carrying a stray foreign stamp — walking the ladder would
 *    mangle the former, while silently returning it unchanged would permanently
 *    orphan the latter from its own line (its predicate would report "current"
 *    forever). An ambiguous envelope is corrupt data, handled like a malformed
 *    stamp: fail loud. `validateRuntimeSession` rejects a stray `dslVersion` at
 *    the door for the same reason.
 */
function runLadder(
  doc: unknown,
  ladder: readonly DslMigration[],
  targetVersion: string,
  key: string,
  otherKey: string,
  legacyVersion: string | null,
): unknown {
  if (!isObject(doc)) return doc;

  // Case (3) of the cross-line guard — own stamp absent, sibling stamp present
  // — throws inside `versionOf` (see `crossLineError` for why neither silent
  // answer is safe), as does a present-but-malformed own stamp, and — on a line
  // with no unversioned epoch (`legacyVersion === null`) — a wholly-unstamped
  // object (see `noRuntimeEpochError`). Enforcing all three in the shared reader
  // keeps the runner, its predicate, and the plain `*VersionOf` readers in
  // agreement on every envelope.
  let version = versionOf(doc, key, otherKey, legacyVersion);

  // Already current, or written ahead of us — leave the document as-is.
  if (compareVersions(version, targetVersion) >= 0) return doc;

  let current: unknown = doc;
  // Walk the ladder one step at a time. Guard against a malformed (cyclic /
  // non-advancing) registry so a bad entry can't spin forever.
  for (let step = 0; step < ladder.length + 1; step++) {
    if (version === targetVersion) return current;
    const next = ladder.find((m) => m.from === version);
    if (!next) {
      throw new Error(`@openmaic/dsl: no migration path from "${version}" to "${targetVersion}"`);
    }
    current = stampVersion(next.migrate(current), next.to, key);
    version = next.to;
  }

  if (version !== targetVersion) {
    throw new Error(
      `@openmaic/dsl: migration ladder did not reach "${targetVersion}" (stuck at "${version}")`,
    );
  }
  return current;
}

export function migrate(doc: unknown): unknown {
  return runLadder(
    doc,
    DSL_MIGRATIONS,
    DSL_VERSION,
    DSL_VERSION_KEY,
    RUNTIME_DSL_VERSION_KEY,
    UNVERSIONED_DSL_VERSION,
  );
}

/**
 * Migrate a {@link RuntimeSession} forward to {@link RUNTIME_DSL_VERSION},
 * walking {@link RUNTIME_DSL_MIGRATIONS} and stamping
 * {@link RUNTIME_DSL_VERSION_KEY}.
 *
 * The exact counterpart of {@link migrate} on the runtime version line —
 * idempotent, forward-compatible, fail-loud, pure, non-objects returned as-is —
 * but pinned to the runtime ladder, target version, and envelope field. Runtime
 * state is stamped and migrated on read through *this* function, never
 * {@link migrate}, so the document and runtime shapes evolve without either
 * ladder consuming the other's data.
 *
 * **No unversioned epoch.** Unlike {@link migrate}, this line does not lift an
 * unstamped object: sessions are born stamped with {@link RUNTIME_DSL_VERSION}
 * at write time, so a wholly-unstamped object here is a misrouted legacy
 * document or an unstamped producer write and **throws** {@link noRuntimeEpochError}
 * (passed `legacyVersion = null`). Non-objects are still returned unchanged, as
 * on the document line — they are not migratable aggregates.
 */
export function migrateRuntime(doc: unknown): unknown {
  return runLadder(
    doc,
    RUNTIME_DSL_MIGRATIONS,
    RUNTIME_DSL_VERSION,
    RUNTIME_DSL_VERSION_KEY,
    DSL_VERSION_KEY,
    null,
  );
}
