import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import {
  ensureWorkspaceModelConfigSchema,
  readWorkspaceModelConfig,
  rekeyWorkspaceModelConfig,
  saveWorkspaceModelConfig,
  WorkspaceConfigConflictError,
  WorkspaceConfigInvalidError,
} from '@/lib/persistence/workspace-model-config';
import { resetInstanceKeyForTests } from '@/lib/server/secret-box';

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }
  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }
}

const OWNER = 'user:alice';
const withKey = {
  providers: { ds: { preset: 'deepseek', apiKey: 'sk-secret-deepseek' } },
  slots: { llm: 'ds:deepseek-v4-pro' },
};

describe('workspace model configuration store', () => {
  let db: PGlite;
  let pool: ConnectableQueryable;

  beforeEach(async () => {
    resetInstanceKeyForTests();
    vi.stubEnv('OPENMAIC_SECRET_KEY', 'test-instance-secret');
    db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db) as unknown as ConnectableQueryable;
    await ensureWorkspaceModelConfigSchema(pool);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetInstanceKeyForTests();
    await db.close();
  });

  it('has nothing for a workspace that never saved', async () => {
    expect(await readWorkspaceModelConfig(pool, OWNER)).toBeNull();
  });

  it('round-trips the configuration and keeps keys out of the config column', async () => {
    expect(await saveWorkspaceModelConfig(pool, OWNER, withKey, null)).toBe(1);
    expect(await readWorkspaceModelConfig(pool, OWNER)).toEqual({
      config: withKey,
      revision: 1,
      unreadableSecrets: [],
    });
    const raw = await db.query<{ config: unknown; secrets: unknown }>(
      'SELECT config, secrets FROM workspace_model_config',
    );
    expect(JSON.stringify(raw.rows[0]!.config)).not.toContain('sk-secret');
    expect(JSON.stringify(raw.rows[0]!.secrets)).not.toContain('sk-secret');
    expect(raw.rows[0]!.config).toEqual({
      providers: { ds: { preset: 'deepseek' } },
      slots: { llm: 'ds:deepseek-v4-pro' },
    });
  });

  it('seals multi-part credentials too', async () => {
    const config = {
      providers: {
        doc: { preset: 'alidocmind', credentials: { accessKeyId: 'ak', accessKeySecret: 'sk-x' } },
      },
    };
    await saveWorkspaceModelConfig(pool, OWNER, config, null);
    expect((await readWorkspaceModelConfig(pool, OWNER))?.config).toEqual(config);
  });

  it('refuses a save based on a stale revision', async () => {
    await saveWorkspaceModelConfig(pool, OWNER, withKey, null);
    await expect(saveWorkspaceModelConfig(pool, OWNER, withKey, null)).rejects.toThrow(
      WorkspaceConfigConflictError,
    );
    expect(await saveWorkspaceModelConfig(pool, OWNER, { slots: { video: null } }, 1)).toBe(2);
    await expect(saveWorkspaceModelConfig(pool, OWNER, withKey, 1)).rejects.toThrow(
      WorkspaceConfigConflictError,
    );
  });

  it('refuses shapes the file schema refuses, and policy', async () => {
    await expect(
      saveWorkspaceModelConfig(pool, OWNER, { slots: { nope: null } } as never, null),
    ).rejects.toThrow(WorkspaceConfigInvalidError);
    await expect(
      saveWorkspaceModelConfig(pool, OWNER, { policy: { allowWorkspaceProviders: true } }, null),
    ).rejects.toThrow(/only the deployment configuration sets policy/);
    expect(await readWorkspaceModelConfig(pool, OWNER)).toBeNull();
  });

  it('reports keys sealed under another instance secret and keeps them across saves', async () => {
    await saveWorkspaceModelConfig(pool, OWNER, withKey, null);
    resetInstanceKeyForTests();
    vi.stubEnv('OPENMAIC_SECRET_KEY', 'a-different-secret');
    const read = await readWorkspaceModelConfig(pool, OWNER);
    expect(read?.unreadableSecrets).toEqual(['ds']);
    expect(read?.config.providers?.ds).toEqual({ preset: 'deepseek' });

    // A save that brings no new key keeps the sealed one...
    await saveWorkspaceModelConfig(pool, OWNER, { ...read!.config, slots: {} }, 1);
    resetInstanceKeyForTests();
    vi.stubEnv('OPENMAIC_SECRET_KEY', 'test-instance-secret');
    expect((await readWorkspaceModelConfig(pool, OWNER))?.config.providers?.ds).toEqual(
      withKey.providers.ds,
    );

    // ...and one that brings a new key replaces it.
    resetInstanceKeyForTests();
    vi.stubEnv('OPENMAIC_SECRET_KEY', 'a-different-secret');
    await saveWorkspaceModelConfig(
      pool,
      OWNER,
      { providers: { ds: { preset: 'deepseek', apiKey: 'sk-new' } } },
      2,
    );
    expect(await readWorkspaceModelConfig(pool, OWNER)).toMatchObject({
      config: { providers: { ds: { apiKey: 'sk-new' } } },
      unreadableSecrets: [],
    });
  });

  it('binds a sealed key to its provider', async () => {
    await saveWorkspaceModelConfig(
      pool,
      OWNER,
      {
        providers: {
          a: { preset: 'deepseek', apiKey: 'sk-a' },
          b: { preset: 'deepseek', apiKey: 'sk-b' },
        },
      },
      null,
    );
    // Swap the sealed values between providers: neither opens any more.
    await db.query(
      `UPDATE workspace_model_config
          SET secrets = jsonb_build_object('a', secrets->'b', 'b', secrets->'a')`,
    );
    expect((await readWorkspaceModelConfig(pool, OWNER))?.unreadableSecrets).toEqual(['a', 'b']);
  });

  describe('claims', () => {
    const ANON = 'anon:00000000-0000-4000-8000-000000000000';

    it('moves the anonymous configuration to an account without one', async () => {
      await saveWorkspaceModelConfig(pool, ANON, withKey, null);
      expect(await rekeyWorkspaceModelConfig(pool, ANON, OWNER)).toBe(1);
      expect(await readWorkspaceModelConfig(pool, ANON)).toBeNull();
      // Keys still open: the sealed value is bound to the provider, not the owner.
      expect((await readWorkspaceModelConfig(pool, OWNER))?.config).toEqual(withKey);
    });

    it("keeps the account's own configuration", async () => {
      await saveWorkspaceModelConfig(pool, ANON, withKey, null);
      await saveWorkspaceModelConfig(pool, OWNER, { slots: { video: null } }, null);
      expect(await rekeyWorkspaceModelConfig(pool, ANON, OWNER)).toBe(0);
      expect(await readWorkspaceModelConfig(pool, ANON)).toBeNull();
      expect((await readWorkspaceModelConfig(pool, OWNER))?.config).toEqual({
        slots: { video: null },
      });
    });

    it('does nothing for an owner without configuration', async () => {
      expect(await rekeyWorkspaceModelConfig(pool, ANON, OWNER)).toBe(0);
    });
  });
});

describe('instance secret file', () => {
  it('is created once in the data directory and reused', async () => {
    const { instanceKey } = await import('@/lib/server/secret-box');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmaic-secret-'));
    try {
      resetInstanceKeyForTests();
      const first = instanceKey({}, dir);
      const file = path.join(dir, 'instance-secret.key');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      resetInstanceKeyForTests();
      expect(instanceKey({}, dir).kid).toBe(first.kid);
      resetInstanceKeyForTests();
      expect(instanceKey({ OPENMAIC_SECRET_KEY: 'x' }, dir).kid).not.toBe(first.kid);
      expect(fs.readdirSync(dir)).toEqual(['instance-secret.key']);
    } finally {
      resetInstanceKeyForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a damaged instance secret file', () => {
  it.each([
    ['empty', ''],
    ['truncated', 'c2VjcmV0'],
    ['not base64', `${'!'.repeat(43)}=`],
  ])('is refused when %s', async (_label, contents) => {
    const { instanceKey } = await import('@/lib/server/secret-box');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmaic-secret-'));
    try {
      fs.writeFileSync(path.join(dir, 'instance-secret.key'), contents);
      resetInstanceKeyForTests();
      expect(() => instanceKey({}, dir)).toThrow(/is not a complete instance secret/);
    } finally {
      resetInstanceKeyForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
