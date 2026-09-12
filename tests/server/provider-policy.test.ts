import { describe, expect, it } from 'vitest';

import {
  PROVIDER_POLICY_SCHEMA,
  readProviderPolicy,
  upsertProviderPolicy,
} from '@/lib/persistence/provider-policy';
import type { Queryable } from '@openmaic/storage/runtime/pg';

class FakeDb implements Queryable {
  readonly calls: Array<{ text: string; params?: unknown[] }> = [];
  rows: Record<string, unknown>[] = [];

  async query<T extends Record<string, unknown>>(text: string, params?: unknown[]) {
    this.calls.push({ text, params });
    if (text.includes('SELECT scope')) return { rows: this.rows as T[] };
    return { rows: [] as T[] };
  }
}

describe('database provider policy', () => {
  it('keeps the policy schema credential-free and constrained to one global row', () => {
    expect(PROVIDER_POLICY_SCHEMA).toContain('openmaic_provider_policy');
    expect(PROVIDER_POLICY_SCHEMA).toContain("scope = 'global'");
    expect(PROVIDER_POLICY_SCHEMA).toContain('llm_provider_id TEXT');
    expect(PROVIDER_POLICY_SCHEMA).not.toMatch(/api[_-]?key/i);
  });

  it('maps a persisted row to the policy shape', async () => {
    const db = new FakeDb();
    db.rows = [
      {
        scope: 'global',
        llm_locked: true,
        llm_provider_id: 'doubao',
        llm_model_id: 'doubao-seed-2.0-pro',
        audio_locked: true,
        tts_provider_id: 'doubao-tts',
        asr_provider_id: 'doubao-asr',
        updated_at: '2026-09-12T00:00:00.000Z',
      },
    ];
    const row = await readProviderPolicy(db);
    expect(row).toMatchObject({
      scope: 'global',
      llmLocked: true,
      llmProviderId: 'doubao',
      llmModelId: 'doubao-seed-2.0-pro',
      audioLocked: true,
      ttsProviderId: 'doubao-tts',
      asrProviderId: 'doubao-asr',
    });
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });

  it('clears stale provider ids when the operator unlocks a section', async () => {
    const db = new FakeDb();
    await upsertProviderPolicy(db, {
      llmLocked: false,
      llmProviderId: 'deepseek',
      llmModelId: 'deepseek-v4-pro',
      audioLocked: false,
      ttsProviderId: 'doubao-tts',
      asrProviderId: 'doubao-asr',
    });
    const call = db.calls.at(-1);
    expect(call?.params).toEqual(['global', false, null, null, false, null, null]);
  });
});
