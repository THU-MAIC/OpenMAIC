/**
 * DSL version + migration scaffolding.
 *
 * The DSL version is independent of the npm package version: it identifies the
 * shape of the serialized slide contract so that persisted documents can be
 * migrated forward as the schema evolves.
 *
 * This is intentionally a stub: the real migration registry is filled in once
 * the first breaking schema change lands. The types below pin down the shape
 * that registry will take so callers can already code against it.
 */

/** Current version of the serialized slide contract. */
export const DSL_VERSION = '0.1.0' as const;

export type DslVersion = typeof DSL_VERSION;

/**
 * A pure, synchronous transform from one DSL version to the next. Migrations
 * MUST NOT have side effects and MUST NOT depend on any runtime library.
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
 * Ordered list of migrations. Empty until the first breaking change ships.
 * Keep entries sorted so `from(n).to === from(n+1).from`.
 */
export const DSL_MIGRATIONS: readonly DslMigration[] = [];
