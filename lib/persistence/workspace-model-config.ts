/**
 * The workspace model configuration: the providers and slot assignments a
 * workspace sets in the web settings (RFC #1701, tracked in #1725). A
 * workspace is an owner (see `lib/server/identity`), and each owner has at most
 * one row, holding the same shape as `openmaic.yml` minus `policy`.
 *
 * Provider secrets (`apiKey`, `credentials`) never sit in the `config` column.
 * They are sealed per provider under the instance secret
 * (`lib/server/secret-box.ts`) in `secrets`, bound to the provider id, and
 * opened on read. A secret that no longer opens (the instance secret was lost
 * or changed) is reported in `unreadableSecrets`, and a save that brings no new
 * secret for that provider keeps the sealed value as it is: a misconfigured
 * instance secret must not destroy keys on the first settings change.
 *
 * Writes replace the whole document under a revision check, take the owner's
 * identity lock first like every owner write (`./owner-merges.ts`), and a
 * claim moves the row to the account unless the account has one already.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import { encodeJson } from '@openmaic/storage/pg-json';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import {
  checkModelConfigShape,
  type ModelConfigFile,
} from '@/lib/server/model-config/openmaic-yml';
import { isSealedSecret, openSecret, sealSecret, type SealedSecret } from '@/lib/server/secret-box';

import { ensureOwnerMergeSchema, fenceOwnerWrite } from './owner-merges';

export const WORKSPACE_MODEL_CONFIG_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_model_config (
  owner_id TEXT PRIMARY KEY,
  config JSONB NOT NULL,
  secrets JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
`;

export async function ensureWorkspaceModelConfigSchema(queryable: Queryable): Promise<void> {
  await queryable.query(WORKSPACE_MODEL_CONFIG_SCHEMA);
  await ensureOwnerMergeSchema(queryable);
}

export interface WorkspaceModelConfig {
  /** The configuration with secrets opened. */
  config: ModelConfigFile;
  revision: number;
  /** Providers whose stored secret does not open; they have to be entered again. */
  unreadableSecrets: string[];
}

export class WorkspaceConfigConflictError extends Error {
  constructor() {
    super('the workspace configuration changed since it was read');
    this.name = 'WorkspaceConfigConflictError';
  }
}

export class WorkspaceConfigInvalidError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`invalid workspace model configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'WorkspaceConfigInvalidError';
  }
}

type Provider = NonNullable<ModelConfigFile['providers']>[string];
type ProviderSecret = Pick<Provider, 'apiKey' | 'credentials'>;

const secretContext = (providerId: string) => `workspace-provider:${providerId}`;

function splitSecret(provider: Provider): { rest: Provider; secret?: ProviderSecret } {
  const { apiKey, credentials, ...rest } = provider;
  if (apiKey === undefined && credentials === undefined) return { rest };
  return {
    rest: rest as Provider,
    secret: {
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(credentials !== undefined ? { credentials } : {}),
    },
  };
}

interface Row {
  config: ModelConfigFile;
  secrets: Record<string, unknown>;
  revision: number;
}

function openRow(row: Row): WorkspaceModelConfig {
  const unreadableSecrets: string[] = [];
  const providers: NonNullable<ModelConfigFile['providers']> = {};
  for (const [id, provider] of Object.entries(row.config.providers ?? {})) {
    const sealed = Object.hasOwn(row.secrets, id) ? row.secrets[id] : undefined;
    if (!isSealedSecret(sealed)) {
      providers[id] = provider;
      continue;
    }
    try {
      providers[id] = {
        ...provider,
        ...(JSON.parse(openSecret(sealed, secretContext(id))) as ProviderSecret),
      };
    } catch {
      unreadableSecrets.push(id);
      providers[id] = provider;
    }
  }
  const config: ModelConfigFile = { ...row.config };
  if (row.config.providers) config.providers = providers;
  return { config, revision: row.revision, unreadableSecrets };
}

export async function readWorkspaceModelConfig(
  queryable: Queryable,
  ownerId: string,
): Promise<WorkspaceModelConfig | null> {
  const result = await queryable.query<Row & Record<string, unknown>>(
    'SELECT config, secrets, revision FROM workspace_model_config WHERE owner_id = $1',
    [ownerId],
  );
  const row = result.rows[0];
  return row ? openRow(row) : null;
}

/**
 * Replace the workspace configuration. `expectedRevision` is the revision the
 * caller read, or null when it read none; anything else changed in between
 * raises {@link WorkspaceConfigConflictError}. Returns the new revision.
 */
export async function saveWorkspaceModelConfig(
  queryable: ConnectableQueryable,
  ownerId: string,
  next: ModelConfigFile,
  expectedRevision: number | null,
  /** Providers whose stored key is removed even if it can no longer be opened. */
  { clearKeys = [] }: { clearKeys?: readonly string[] } = {},
): Promise<number> {
  const { config, issues } = checkModelConfigShape(next);
  if (!config) throw new WorkspaceConfigInvalidError(issues);
  if (config.policy !== undefined) {
    throw new WorkspaceConfigInvalidError([
      'policy: only the deployment configuration sets policy',
    ]);
  }

  const withTransaction = nodePostgresTransaction(queryable);
  return withTransaction(async (tx) => {
    await fenceOwnerWrite(tx, ownerId);
    const current = await tx.query<Row & Record<string, unknown>>(
      'SELECT config, secrets, revision FROM workspace_model_config WHERE owner_id = $1 FOR UPDATE',
      [ownerId],
    );
    const row = current.rows[0];
    if ((row?.revision ?? null) !== expectedRevision) throw new WorkspaceConfigConflictError();

    const stored: ModelConfigFile = { ...config };
    const secrets: Record<string, SealedSecret> = {};
    const unreadable = row ? new Set(openRow(row).unreadableSecrets) : new Set<string>();
    if (config.providers) {
      stored.providers = {};
      for (const [id, provider] of Object.entries(config.providers)) {
        const { rest, secret } = splitSecret(provider);
        stored.providers[id] = rest;
        if (secret) {
          secrets[id] = sealSecret(JSON.stringify(secret), secretContext(id));
        } else if (
          unreadable.has(id) &&
          !clearKeys.includes(id) &&
          isSealedSecret(row!.secrets[id])
        ) {
          secrets[id] = row!.secrets[id] as SealedSecret;
        }
      }
    }
    const revision = (row?.revision ?? 0) + 1;
    // A compare-and-swap either way: the row lock above covers an update, and
    // a first save that races another first save finds the row taken.
    const written = row
      ? await tx.query(
          `UPDATE workspace_model_config
              SET config = $2::jsonb, secrets = $3::jsonb, revision = $4, updated_at = now()
            WHERE owner_id = $1 AND revision = $5
            RETURNING owner_id`,
          [
            ownerId,
            encodeJson(stored, 'workspace model configuration'),
            encodeJson(secrets, 'workspace provider secrets'),
            revision,
            row.revision,
          ],
        )
      : await tx.query(
          `INSERT INTO workspace_model_config (owner_id, config, secrets, revision)
           VALUES ($1, $2::jsonb, $3::jsonb, $4)
           ON CONFLICT (owner_id) DO NOTHING
           RETURNING owner_id`,
          [
            ownerId,
            encodeJson(stored, 'workspace model configuration'),
            encodeJson(secrets, 'workspace provider secrets'),
            revision,
          ],
        );
    if (written.rows.length !== 1) throw new WorkspaceConfigConflictError();
    return revision;
  });
}

/**
 * The claim step (`./owner-claims.ts`): the anonymous owner's configuration
 * moves to the account, unless the account has one, which is kept; the
 * anonymous row goes either way, since a retired owner is never read again.
 */
export async function rekeyWorkspaceModelConfig(
  tx: Queryable,
  fromOwnerId: string,
  toOwnerId: string,
): Promise<number> {
  const locked = await tx.query<{ owner_id: string } & Record<string, unknown>>(
    `SELECT owner_id FROM workspace_model_config
      WHERE owner_id = ANY($1::text[]) ORDER BY owner_id FOR UPDATE`,
    [[fromOwnerId, toOwnerId]],
  );
  const owners = new Set(locked.rows.map((row) => row.owner_id));
  if (!owners.has(fromOwnerId)) return 0;
  if (owners.has(toOwnerId)) {
    await tx.query('DELETE FROM workspace_model_config WHERE owner_id = $1', [fromOwnerId]);
    return 0;
  }
  await tx.query('UPDATE workspace_model_config SET owner_id = $2 WHERE owner_id = $1', [
    fromOwnerId,
    toOwnerId,
  ]);
  return 1;
}
