/**
 * PostgreSQL backend for durable user-authored skills.
 *
 * The backend imports no database driver. A host supplies a direct queryable
 * and a transaction hook that checks out and pins one connection for the
 * complete callback, exactly like the runtime / agent-session backends.
 *
 * The DDL is pinned (see `pg-schema-contract.test.ts` in the package tests):
 * a deployment that provisions this table with its own migration tooling must
 * reproduce it exactly for `ensureUserSkillSchema` to stay the intended no-op.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable, WithTransaction } from '../runtime/pg.js';
import {
  USER_SKILL_LIMIT,
  UserSkillError,
  applyUserSkillPatchOps,
  validateUserSkillFields,
  validateUserSkillInput,
  type UserSkillPatchOpInput,
  type UserSkillPatchOutcome,
  type UserSkillRecord,
  type UserSkillStore,
} from './types.js';

export type { QueryResult, Queryable, WithTransaction } from '../runtime/pg.js';

export interface UserSkillTableNames {
  skills: string;
}

export const DEFAULT_USER_SKILL_TABLE_NAMES: Readonly<UserSkillTableNames> = {
  skills: 'agent_user_skill',
};

export interface PgUserSkillStoreOptions {
  /**
   * On every call, checks out a fresh connection, opens a transaction, pins
   * every query in `body` to it, then commits or rolls back and releases it.
   * READ COMMITTED isolation is assumed.
   */
  withTransaction: WithTransaction;
  tableNames?: Partial<UserSkillTableNames>;
  /** Test seam; production callers normally use the default id scheme. */
  createId?: () => string;
}

/** Pinned default schema for the PostgreSQL user-skill backend. */
export const USER_SKILL_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_user_skill (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT agent_user_skill_version_check CHECK (version = 1),
  CONSTRAINT agent_user_skill_name_check
    CHECK (name ~ '^my-[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(name) <= 64),
  CONSTRAINT agent_user_skill_title_check CHECK (length(title) BETWEEN 1 AND 80),
  CONSTRAINT agent_user_skill_description_check
    CHECK (length(description) BETWEEN 1 AND 500 AND description !~ '[\r\n]'),
  CONSTRAINT agent_user_skill_content_check CHECK (octet_length(content) BETWEEN 1 AND 65536)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_user_skill_owner_name_unique
  ON agent_user_skill (owner_id, name) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_user_skill_owner
  ON agent_user_skill (owner_id, created_at) WHERE deleted_at IS NULL;
`;

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(
      `@openmaic/storage: invalid user-skill table name ${JSON.stringify(identifier)}`,
    );
  }
  return `"${identifier}"`;
}

function resolveTableNames(overrides?: Partial<UserSkillTableNames>): UserSkillTableNames {
  const names = { ...DEFAULT_USER_SKILL_TABLE_NAMES, ...overrides };
  for (const name of Object.values(names)) quoteIdentifier(name);
  return names;
}

function schemaFor(names: UserSkillTableNames): string {
  if (names.skills === DEFAULT_USER_SKILL_TABLE_NAMES.skills) return USER_SKILL_PG_SCHEMA;
  const s = quoteIdentifier(names.skills);
  const unique = `${names.skills}_owner_name_unique`;
  const ownerIdx = `idx_${names.skills}_owner`;
  // Constraint/index names are rewritten first (they embed the default table
  // name), then the table-name occurrences themselves; only the CREATE TABLE
  // statement gets the quoted identifier.
  return USER_SKILL_PG_SCHEMA.replaceAll('agent_user_skill_owner_name_unique', unique)
    .replaceAll('idx_agent_user_skill_owner', ownerIdx)
    .replaceAll('agent_user_skill', names.skills)
    .replaceAll(`CREATE TABLE IF NOT EXISTS ${names.skills}`, `CREATE TABLE IF NOT EXISTS ${s}`);
}

/** Create the backend-owned table when absent; existing schemas require migrations. */
export async function ensureUserSkillSchema(
  queryable: Queryable,
  tableNames?: Partial<UserSkillTableNames>,
): Promise<void> {
  const schema = schemaFor(resolveTableNames(tableNames));
  for (const sql of schema.split(';')) {
    const statement = sql.trim();
    if (statement !== '') await queryable.query(statement);
  }
}

interface UserSkillRow extends Record<string, unknown> {
  id: string;
  owner_id: string;
  name: string;
  title: string;
  description: string;
  content: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapRow(row: UserSkillRow): UserSkillRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    title: row.title,
    description: row.description,
    content: row.content,
    version: 1,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

/** Resolve a model-supplied reference: a `usk_*` id, `my-handle`, or `/my-handle`. */
function refCondition(ref: string): { sql: string; params: unknown[] } {
  const trimmed = ref.trim();
  if (trimmed.startsWith('usk_')) return { sql: `id = $1`, params: [trimmed] };
  const handle = (trimmed.startsWith('/') ? trimmed.slice(1) : trimmed).toLowerCase();
  return { sql: `name = $1`, params: [handle] };
}

function skillNotFound(ref: string): UserSkillError {
  // Deliberately identical whether the row does not exist or belongs to someone
  // else: a probe must not be able to learn that another user's handle is taken.
  return new UserSkillError(
    `No Skill ${JSON.stringify(ref)} was found for this owner. Only /my-* Skills you ` +
      'created yourself can be read or edited; built-in Skills are read with the read tool.',
    'not-found',
  );
}

export class PgUserSkillStore implements UserSkillStore {
  private readonly queryable: Queryable;
  private readonly transactionHook: WithTransaction;
  private readonly tableNames: UserSkillTableNames;
  private readonly createId: () => string;

  constructor(queryable: Queryable, options: PgUserSkillStoreOptions) {
    if (typeof options?.withTransaction !== 'function') {
      throw new Error(
        '@openmaic/storage: withTransaction is required and must pin a fresh connection and ' +
          'transaction for every call; reusing a shared client lets concurrent transactions ' +
          'interleave',
      );
    }
    this.queryable = queryable;
    this.transactionHook = options.withTransaction;
    this.tableNames = resolveTableNames(options.tableNames);
    this.createId = options.createId ?? (() => `usk_${randomBytes(12).toString('base64url')}`);
  }

  private get table(): string {
    return quoteIdentifier(this.tableNames.skills);
  }

  async list(ownerId: string): Promise<UserSkillRecord[]> {
    const result = await this.queryable.query<UserSkillRow>(
      `SELECT * FROM ${this.table}
        WHERE owner_id = $1 AND deleted_at IS NULL
        ORDER BY created_at ASC`,
      [ownerId],
    );
    return result.rows.map(mapRow);
  }

  async find(id: string, ownerId: string): Promise<UserSkillRecord | null> {
    const result = await this.queryable.query<UserSkillRow>(
      `SELECT * FROM ${this.table}
        WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
        LIMIT 1`,
      [id, ownerId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findByRef(ownerId: string, ref: string): Promise<UserSkillRecord | null> {
    const condition = refCondition(ref);
    const result = await this.queryable.query<UserSkillRow>(
      `SELECT * FROM ${this.table}
        WHERE ${condition.sql} AND owner_id = $2 AND deleted_at IS NULL
        LIMIT 1`,
      [...condition.params, ownerId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async create(
    ownerId: string,
    input: { name: string; title: string; description: string; content: string },
  ): Promise<UserSkillRecord> {
    const value = validateUserSkillInput(input);
    const id = this.createId();
    try {
      const rows = await this.transactionHook(async (tx) => {
        // Serialize creates per owner. The quota check below is a
        // read-then-write pair: under READ COMMITTED, two concurrent creates at
        // 49 rows would BOTH count 49 and both insert, overshooting the
        // contract. The advisory lock makes the check-and-insert one critical
        // section per owner (a hashtext collision only serializes two unrelated
        // owners, which is harmless).
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [ownerId]);
        // Same-name idempotency BEFORE the quota check, so an at-least-once
        // retry of a create that committed as the owner's 50th row still
        // returns its durable receipt instead of a confusing quota error.
        const existing = (
          await tx.query<UserSkillRow>(
            `SELECT * FROM ${this.table}
              WHERE owner_id = $1 AND name = $2 AND deleted_at IS NULL
              LIMIT 1`,
            [ownerId, value.name],
          )
        ).rows[0];
        if (existing) {
          if (
            existing.title === value.title &&
            existing.description === value.description &&
            existing.content === value.content
          ) {
            return [mapRow(existing)];
          }
          throw new UserSkillError(
            `You already have a Skill named /${value.name}; it will not be overwritten.`,
            'duplicate',
          );
        }
        const [{ used }] = (
          await tx.query<{ used: string }>(
            `SELECT count(*)::text AS used FROM ${this.table}
              WHERE owner_id = $1 AND deleted_at IS NULL`,
            [ownerId],
          )
        ).rows;
        if (Number(used) >= USER_SKILL_LIMIT) {
          throw new UserSkillError(
            `Each user can save at most ${USER_SKILL_LIMIT} Skills.`,
            'quota',
          );
        }
        const inserted = await tx.query<UserSkillRow>(
          `INSERT INTO ${this.table}
             (id, owner_id, name, title, description, content)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [id, ownerId, value.name, value.title, value.description, value.content],
        );
        return inserted.rows.map(mapRow);
      });
      return rows[0]!;
    } catch (error) {
      if (error instanceof UserSkillError) throw error;
      // Backstop for a row that appeared between the same-name check and the
      // INSERT through a path that does not take the advisory lock (manual
      // provisioning, a different store instance without the lock).
      if (isUniqueViolation(error)) {
        const existing = await this.findByRef(ownerId, value.name);
        if (
          existing &&
          existing.title === value.title &&
          existing.description === value.description &&
          existing.content === value.content
        ) {
          // At-least-once runner recovery can re-issue a call whose INSERT
          // committed just before the worker died. Identical content is the same
          // create request, so return the durable receipt without overwriting it.
          return existing;
        }
        throw new UserSkillError(
          `You already have a Skill named /${value.name}; it will not be overwritten.`,
          'duplicate',
        );
      }
      throw error;
    }
  }

  async delete(ownerId: string, ref: string): Promise<void> {
    const condition = refCondition(ref);
    const deleted = await this.queryable.query<{ id: string }>(
      `UPDATE ${this.table}
          SET deleted_at = now(), updated_at = now()
        WHERE ${condition.sql} AND owner_id = $2 AND deleted_at IS NULL
        RETURNING id`,
      [...condition.params, ownerId],
    );
    if (deleted.rows.length !== 1) throw skillNotFound(ref);
  }

  async patch(
    ownerId: string,
    ref: string,
    ops: readonly UserSkillPatchOpInput[],
  ): Promise<UserSkillPatchOutcome> {
    return this.transactionHook(async (tx) => {
      const condition = refCondition(ref);
      const rows = await tx.query<UserSkillRow>(
        `SELECT * FROM ${this.table}
          WHERE ${condition.sql} AND owner_id = $2 AND deleted_at IS NULL
          LIMIT 1
          FOR UPDATE`,
        [...condition.params, ownerId],
      );
      const row = rows.rows[0];
      if (!row) throw skillNotFound(ref);
      const { fields, applied } = applyUserSkillPatchOps(
        { title: row.title, description: row.description, content: row.content },
        ops,
      );
      const next = validateUserSkillFields(fields);
      if (
        next.title === row.title &&
        next.description === row.description &&
        next.content === row.content
      ) {
        return { skill: mapRow(row), applied, changed: false };
      }
      const updated = await tx.query<UserSkillRow>(
        `UPDATE ${this.table}
            SET title = $2, description = $3, content = $4, updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [row.id, next.title, next.description, next.content],
      );
      return { skill: mapRow(updated.rows[0]!), applied, changed: true };
    });
  }
}
