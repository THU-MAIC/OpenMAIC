/**
 * An owner's custom agents (RFC #1754, G). Built-in agents are code
 * (`lib/orchestration/registry/built-in.ts`) and never stored; each custom
 * agent is one row keyed by owner and agent id, holding the agent's fields as
 * `customAgentSchema` describes them. Agent ids are the owner's: two owners
 * may use the same one.
 *
 * Writes take the owner's identity lock first, like every owner write
 * (`lib/persistence/owner-merges.ts`), and a claim moves the rows to the
 * account (`rekeyOwnerAgents`, a participant of `lib/persistence/owner-claims.ts`).
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import { encodeJson } from '@openmaic/storage/pg-json';
import { applySchemaMigrations, type SchemaMigrationSet } from '@openmaic/storage/pg-migrations';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import { ensureOwnerMergeSchema, fenceOwnerWrite } from '@/lib/persistence/owner-merges';
import {
  MAX_CUSTOM_AGENTS,
  type CustomAgent,
  type CustomAgentFields,
} from '@/lib/orchestration/registry/schema';

export const OWNER_AGENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS owner_agents (
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  config JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, agent_id)
)
`;

export const OWNER_AGENT_MIGRATIONS: SchemaMigrationSet = {
  store: 'owner-agents',
  migrations: [{ version: 1, name: 'baseline', up: OWNER_AGENTS_SCHEMA }],
};

export async function ensureOwnerAgentSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, OWNER_AGENT_MIGRATIONS);
  await ensureOwnerMergeSchema(queryable);
}

export interface StoredCustomAgent {
  agent: CustomAgent;
  createdAt: Date;
  updatedAt: Date;
}

export class OwnerAgentExistsError extends Error {
  constructor(readonly agentId: string) {
    super(`an agent with id ${JSON.stringify(agentId)} exists already`);
    this.name = 'OwnerAgentExistsError';
  }
}

export class OwnerAgentNotFoundError extends Error {
  constructor(readonly agentId: string) {
    super(`no agent with id ${JSON.stringify(agentId)}`);
    this.name = 'OwnerAgentNotFoundError';
  }
}

export class OwnerAgentLimitError extends Error {
  constructor() {
    super(`an owner keeps at most ${MAX_CUSTOM_AGENTS} custom agents`);
    this.name = 'OwnerAgentLimitError';
  }
}

interface Row extends Record<string, unknown> {
  agent_id: string;
  config: CustomAgentFields;
  created_at: Date | string;
  updated_at: Date | string;
}

function fromRow(row: Row): StoredCustomAgent {
  return {
    agent: { ...row.config, id: row.agent_id },
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function storedConfig(agent: CustomAgent): string {
  const { id: _id, ...fields } = agent;
  return encodeJson(fields, 'custom agent');
}

/** The owner's custom agents, oldest first. */
export async function listOwnerAgents(
  queryable: Queryable,
  ownerId: string,
): Promise<StoredCustomAgent[]> {
  const result = await queryable.query<Row>(
    `SELECT agent_id, config, created_at, updated_at FROM owner_agents
      WHERE owner_id = $1 ORDER BY created_at, agent_id`,
    [ownerId],
  );
  return result.rows.map(fromRow);
}

/** The owner's custom agents among `agentIds` (missing ones are left out). */
export async function readOwnerAgents(
  queryable: Queryable,
  ownerId: string,
  agentIds: readonly string[],
): Promise<StoredCustomAgent[]> {
  if (agentIds.length === 0) return [];
  const result = await queryable.query<Row>(
    `SELECT agent_id, config, created_at, updated_at FROM owner_agents
      WHERE owner_id = $1 AND agent_id = ANY($2::text[])`,
    [ownerId, [...agentIds]],
  );
  return result.rows.map(fromRow);
}

/**
 * The write transaction every change runs in: the owner's write fence, then
 * the owner's agent-count lock, so the limit holds across concurrent creates.
 */
function ownerWrite<T>(
  queryable: ConnectableQueryable,
  ownerId: string,
  body: (tx: Queryable) => Promise<T>,
): Promise<T> {
  return nodePostgresTransaction(queryable)(async (tx) => {
    await fenceOwnerWrite(tx, ownerId);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `owner-agents:${ownerId}`,
    ]);
    return body(tx);
  });
}

async function countOwnerAgents(tx: Queryable, ownerId: string): Promise<number> {
  const result = await tx.query<{ n: string } & Record<string, unknown>>(
    'SELECT COUNT(*)::text AS n FROM owner_agents WHERE owner_id = $1',
    [ownerId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Create a custom agent under its own id. */
export async function createOwnerAgent(
  queryable: ConnectableQueryable,
  ownerId: string,
  agent: CustomAgent,
): Promise<StoredCustomAgent> {
  return ownerWrite(queryable, ownerId, async (tx) => {
    if ((await countOwnerAgents(tx, ownerId)) >= MAX_CUSTOM_AGENTS) {
      throw new OwnerAgentLimitError();
    }
    const inserted = await tx.query<Row>(
      `INSERT INTO owner_agents (owner_id, agent_id, config)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (owner_id, agent_id) DO NOTHING
       RETURNING agent_id, config, created_at, updated_at`,
      [ownerId, agent.id, storedConfig(agent)],
    );
    const row = inserted.rows[0];
    if (!row) throw new OwnerAgentExistsError(agent.id);
    return fromRow(row);
  });
}

/** Replace a custom agent's fields. */
export async function updateOwnerAgent(
  queryable: ConnectableQueryable,
  ownerId: string,
  agent: CustomAgent,
): Promise<StoredCustomAgent> {
  return ownerWrite(queryable, ownerId, async (tx) => {
    const updated = await tx.query<Row>(
      `UPDATE owner_agents SET config = $3::jsonb, updated_at = now()
        WHERE owner_id = $1 AND agent_id = $2
        RETURNING agent_id, config, created_at, updated_at`,
      [ownerId, agent.id, storedConfig(agent)],
    );
    const row = updated.rows[0];
    if (!row) throw new OwnerAgentNotFoundError(agent.id);
    return fromRow(row);
  });
}

/** Delete a custom agent; whether it existed. */
export async function deleteOwnerAgent(
  queryable: ConnectableQueryable,
  ownerId: string,
  agentId: string,
): Promise<boolean> {
  return ownerWrite(queryable, ownerId, async (tx) => {
    const deleted = await tx.query<{ agent_id: string } & Record<string, unknown>>(
      'DELETE FROM owner_agents WHERE owner_id = $1 AND agent_id = $2 RETURNING agent_id',
      [ownerId, agentId],
    );
    return deleted.rows.length === 1;
  });
}

export interface OwnerAgentImport {
  imported: string[];
  skipped: { id: string; reason: string }[];
}

/**
 * Add agents a browser kept, in one transaction. An id the owner already
 * uses keeps the owner's agent, so importing the same agents again changes
 * nothing; agents past the limit are skipped.
 */
export async function importOwnerAgents(
  queryable: ConnectableQueryable,
  ownerId: string,
  agents: readonly CustomAgent[],
): Promise<OwnerAgentImport> {
  return ownerWrite(queryable, ownerId, async (tx) => {
    const result: OwnerAgentImport = { imported: [], skipped: [] };
    let count = await countOwnerAgents(tx, ownerId);
    for (const agent of agents) {
      if (count >= MAX_CUSTOM_AGENTS) {
        result.skipped.push({ id: agent.id, reason: 'limit' });
        continue;
      }
      const inserted = await tx.query<{ agent_id: string } & Record<string, unknown>>(
        `INSERT INTO owner_agents (owner_id, agent_id, config)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (owner_id, agent_id) DO NOTHING
         RETURNING agent_id`,
        [ownerId, agent.id, storedConfig(agent)],
      );
      if (inserted.rows.length === 1) {
        result.imported.push(agent.id);
        count += 1;
      } else {
        result.skipped.push({ id: agent.id, reason: 'exists' });
      }
    }
    return result;
  });
}

/**
 * The claim step (`lib/persistence/owner-claims.ts`): the anonymous owner's
 * agents move to the account; where the account already uses an id, the
 * account's agent is kept and the anonymous one is dropped (a retired owner
 * is never read again). Answers how many moved.
 */
export async function rekeyOwnerAgents(
  tx: Queryable,
  fromOwnerId: string,
  toOwnerId: string,
): Promise<number> {
  await tx.query(
    `SELECT agent_id FROM owner_agents
      WHERE owner_id = ANY($1::text[]) ORDER BY owner_id, agent_id FOR UPDATE`,
    [[fromOwnerId, toOwnerId]],
  );
  await tx.query(
    `DELETE FROM owner_agents AS source
      WHERE source.owner_id = $1
        AND EXISTS (SELECT 1 FROM owner_agents AS target
                     WHERE target.owner_id = $2 AND target.agent_id = source.agent_id)`,
    [fromOwnerId, toOwnerId],
  );
  const moved = await tx.query<{ agent_id: string } & Record<string, unknown>>(
    'UPDATE owner_agents SET owner_id = $2 WHERE owner_id = $1 RETURNING agent_id',
    [fromOwnerId, toOwnerId],
  );
  return moved.rows.length;
}
