/**
 * Durable deployment provider policy.
 *
 * Provider credentials stay in the server environment/secret manager. This
 * table stores only the operator's selected provider/model and lock state, so
 * the policy can be changed without rebuilding the application.
 */

import type { Queryable } from '@openmaic/storage/runtime/pg';

export interface ProviderPolicyRow {
  scope: string;
  llmLocked: boolean;
  llmProviderId: string | null;
  llmModelId: string | null;
  audioLocked: boolean;
  ttsProviderId: string | null;
  asrProviderId: string | null;
  updatedAt: Date | null;
}

export interface ProviderPolicyInput {
  llmLocked: boolean;
  llmProviderId?: string | null;
  llmModelId?: string | null;
  audioLocked: boolean;
  ttsProviderId?: string | null;
  asrProviderId?: string | null;
}

interface RawProviderPolicyRow extends Record<string, unknown> {
  scope: string;
  llm_locked: boolean;
  llm_provider_id: string | null;
  llm_model_id: string | null;
  audio_locked: boolean;
  tts_provider_id: string | null;
  asr_provider_id: string | null;
  updated_at: Date | string | null;
}

/** Idempotent schema; credentials deliberately do not belong in this table. */
export const PROVIDER_POLICY_SCHEMA = `
CREATE TABLE IF NOT EXISTS openmaic_provider_policy (
  scope TEXT PRIMARY KEY,
  llm_locked BOOLEAN NOT NULL DEFAULT false,
  llm_provider_id TEXT,
  llm_model_id TEXT,
  audio_locked BOOLEAN NOT NULL DEFAULT false,
  tts_provider_id TEXT,
  asr_provider_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT openmaic_provider_policy_scope_check CHECK (scope = 'global'),
  CONSTRAINT openmaic_provider_policy_llm_check CHECK (
    (llm_locked = false AND llm_provider_id IS NULL AND llm_model_id IS NULL)
    OR (llm_locked = true AND llm_provider_id IS NOT NULL AND llm_model_id IS NOT NULL)
  ),
  CONSTRAINT openmaic_provider_policy_audio_check CHECK (
    (audio_locked = false AND tts_provider_id IS NULL AND asr_provider_id IS NULL)
    OR (audio_locked = true AND tts_provider_id IS NOT NULL AND asr_provider_id IS NOT NULL)
  )
);
`;

export async function ensureProviderPolicySchema(queryable: Queryable): Promise<void> {
  for (const sql of PROVIDER_POLICY_SCHEMA.split(';')) {
    const statement = sql.trim();
    if (statement !== '') await queryable.query(statement);
  }
}

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function mapRow(row: RawProviderPolicyRow): ProviderPolicyRow {
  return {
    scope: row.scope,
    llmLocked: row.llm_locked === true,
    llmProviderId: row.llm_provider_id,
    llmModelId: row.llm_model_id,
    audioLocked: row.audio_locked === true,
    ttsProviderId: row.tts_provider_id,
    asrProviderId: row.asr_provider_id,
    updatedAt: toDate(row.updated_at),
  };
}

export async function readProviderPolicy(
  queryable: Queryable,
  scope = 'global',
): Promise<ProviderPolicyRow | null> {
  const result = await queryable.query<RawProviderPolicyRow>(
    `SELECT scope, llm_locked, llm_provider_id, llm_model_id,
            audio_locked, tts_provider_id, asr_provider_id, updated_at
       FROM openmaic_provider_policy
      WHERE scope = $1`,
    [scope],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function upsertProviderPolicy(
  queryable: Queryable,
  input: ProviderPolicyInput,
  scope = 'global',
): Promise<void> {
  const llmProviderId = input.llmLocked ? input.llmProviderId?.trim() || null : null;
  const llmModelId = input.llmLocked ? input.llmModelId?.trim() || null : null;
  const ttsProviderId = input.audioLocked ? input.ttsProviderId?.trim() || null : null;
  const asrProviderId = input.audioLocked ? input.asrProviderId?.trim() || null : null;
  await queryable.query(
    `INSERT INTO openmaic_provider_policy
       (scope, llm_locked, llm_provider_id, llm_model_id,
        audio_locked, tts_provider_id, asr_provider_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
     ON CONFLICT (scope) DO UPDATE SET
       llm_locked = EXCLUDED.llm_locked,
       llm_provider_id = EXCLUDED.llm_provider_id,
       llm_model_id = EXCLUDED.llm_model_id,
       audio_locked = EXCLUDED.audio_locked,
       tts_provider_id = EXCLUDED.tts_provider_id,
       asr_provider_id = EXCLUDED.asr_provider_id,
       updated_at = CURRENT_TIMESTAMP`,
    [
      scope,
      input.llmLocked,
      llmProviderId,
      llmModelId,
      input.audioLocked,
      ttsProviderId,
      asrProviderId,
    ],
  );
}
