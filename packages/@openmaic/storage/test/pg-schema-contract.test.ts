import { describe, expect, it } from 'vitest';

import { DOCUMENT_PG_SCHEMA, ensureDocumentSchema } from '../src/document/pg.js';
import { RUNTIME_PG_SCHEMA, ensureSchema } from '../src/runtime/pg.js';
import type { Queryable } from '../src/runtime/pg.js';

/**
 * Golden pins for the two PostgreSQL schemas this package exports.
 *
 * Both constants are public API. A deployment that provisions these tables with
 * its own migration tooling — rather than by calling `ensureDocumentSchema()` /
 * `ensureSchema()` — has to reproduce this DDL exactly for the ensure functions
 * to stay the intended no-op against an already-provisioned database.
 *
 * That coupling is invisible at runtime: every statement here is guarded by
 * `IF NOT EXISTS`, so PostgreSQL silently accepts whatever table already exists
 * under the name. A column type, a nullability, an index, or a FK action can
 * drift apart from a downstream migration without a single error being raised;
 * the first symptom is a store query failing in production, or — worse —
 * succeeding against the wrong types.
 *
 * These tests do not judge whether the DDL is correct. They make changing it
 * impossible to do by accident: any edit fails here and has to be made
 * deliberately, in the same change that tells consumers to migrate.
 *
 * Pinning the constants alone would leave a gap, because what a consumer has to
 * reproduce is not the constant but the statements the ensure functions run. So
 * each ensure function is also executed against a recording queryable and its
 * exact statement sequence is asserted, which keeps the two from drifting apart
 * through a change that touches only the function.
 */

const EXPECTED_DOCUMENT_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS document_stages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  interactive_mode BOOLEAN,
  task_engine_mode BOOLEAN,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS document_scenes (
  stage_id TEXT NOT NULL REFERENCES document_stages(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  scene_order DOUBLE PRECISION NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (stage_id, id)
);

CREATE INDEX IF NOT EXISTS document_scenes_stage_order_idx
  ON document_scenes (stage_id, scene_order, id);

CREATE TABLE IF NOT EXISTS document_outlines (
  stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
  data JSONB NOT NULL
);
`;

const EXPECTED_RUNTIME_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_sessions (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL,
  learner_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS runtime_sessions_stage_learner_idx
  ON runtime_sessions (stage_id, learner_key);
CREATE INDEX IF NOT EXISTS runtime_sessions_learner_idx
  ON runtime_sessions (learner_key);

CREATE TABLE IF NOT EXISTS runtime_records (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL CHECK (seq >= 0),
  scene_id TEXT,
  created_at TEXT NOT NULL,
  data JSONB NOT NULL,
  CONSTRAINT runtime_records_session_seq_unique UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS runtime_records_session_scene_idx
  ON runtime_records (session_id, scene_id);
`;

/** Records the statements an ensure function actually issues. */
function recordingQueryable(): { statements: string[]; queryable: Queryable } {
  const statements: string[] = [];
  return {
    statements,
    queryable: {
      async query<TRow extends Record<string, unknown>>(text: string) {
        statements.push(text);
        return { rows: [] as TRow[] };
      },
    },
  };
}

function statementsOf(schema: string): string[] {
  return schema
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

const schemas = [
  {
    name: 'DOCUMENT_PG_SCHEMA',
    actual: DOCUMENT_PG_SCHEMA,
    expected: EXPECTED_DOCUMENT_PG_SCHEMA,
    ensure: ensureDocumentSchema,
  },
  {
    name: 'RUNTIME_PG_SCHEMA',
    actual: RUNTIME_PG_SCHEMA,
    expected: EXPECTED_RUNTIME_PG_SCHEMA,
    ensure: ensureSchema,
  },
];

describe.each(schemas)('$name is a pinned contract', ({ name, actual, expected, ensure }) => {
  it('is exactly what the ensure function provisions', async () => {
    // Pinning the constant alone would not notice the ensure function growing
    // extra DDL, dropping the index statements, or reordering them. What a
    // consumer has to reproduce is what actually runs, so assert that.
    const { statements, queryable } = recordingQueryable();
    await ensure(queryable);

    expect(statements).toEqual(statementsOf(expected));
  });

  it('provisions idempotently on a second call', async () => {
    const { statements, queryable } = recordingQueryable();
    await ensure(queryable);
    await ensure(queryable);

    const once = statementsOf(expected);
    expect(statements).toEqual([...once, ...once]);
  });

  it('matches the published DDL verbatim', () => {
    // A failure here is not a broken test: it means the schema changed. Update
    // this pin in the same change, and treat it as a breaking change for any
    // deployment that provisions these tables through its own migrations.
    expect(actual).toBe(expected);
  });

  it('keeps every statement guarded so the ensure functions stay idempotent', () => {
    const statements = actual
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement !== '');

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(
        /^CREATE (TABLE|INDEX) IF NOT EXISTS /.test(statement),
        `${name} statement is not an IF NOT EXISTS create: ${statement}`,
      ).toBe(true);
    }
  });
});
