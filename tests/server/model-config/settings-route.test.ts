import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnerAuthMethod } from '@/lib/server/identity/types';

/**
 * /api/model-config on the real route, owner seam and an in-memory
 * PostgreSQL: a workspace reads and edits its own settings, keys never come
 * back, locks and revisions hold, and what it saves is what its calls use.
 */

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
  async end() {
    await this.db.close();
  }
}

const sessionMethod: OwnerAuthMethod = {
  name: 'test-session',
  authenticate: async (req) => {
    const user = req.headers.get('x-test-session');
    if (!user) return { status: 'not-applicable' };
    if (user === 'bad') return { status: 'invalid', reason: 'unknown session' };
    return {
      status: 'authenticated',
      principal: {
        ownerId: `user:${user}`,
        kind: 'user',
        roles: new Set(),
        assurance: 'verified',
      },
    };
  },
};

const SECRET = 'sk-alice-workspace-secret-4321';

describe('/api/model-config', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://model-config-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('OPENMAIC_SECRET_KEY', 'route-test-instance-secret');
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    const { configureOwnerAuthentication } = await import('@/lib/server/identity');
    configureOwnerAuthentication({ methods: [sessionMethod] });
    const { resetInstanceKeyForTests } = await import('@/lib/server/secret-box');
    resetInstanceKeyForTests();
    (await import('@/lib/server/model-config/runtime')).setDeploymentConfigForTests({
      layer: {
        source: 'deployment',
        config: {
          providers: { operator: { preset: 'deepseek', apiKey: 'sk-operator' } },
          slots: { video: null },
        },
      },
      defaults: null,
      notices: [],
    });
  });

  afterEach(async () => {
    const { resetOwnerAuthenticationForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticationForTests();
    (await import('@/lib/server/model-config/runtime')).setDeploymentConfigForTests();
    await pool.end();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function get(user: string) {
    const { GET } = await import('@/app/api/model-config/route');
    return GET(
      new Request('http://localhost/api/model-config', {
        headers: { 'x-test-session': user },
      }) as never,
    );
  }

  async function put(user: string, revision: number | null, change: unknown) {
    const { PUT } = await import('@/app/api/model-config/route');
    return PUT(
      new Request('http://localhost/api/model-config', {
        method: 'PUT',
        headers: { 'x-test-session': user, 'content-type': 'application/json' },
        body: JSON.stringify({ revision, change }),
      }) as never,
    );
  }

  it('reads and edits the workspace settings, keeping keys out of every answer', async () => {
    const initial = await (await get('alice')).json();
    expect(initial.revision).toBeNull();
    expect(initial.policy).toEqual({ allowWorkspaceProviders: true });

    let response = await put('alice', null, {
      kind: 'provider',
      id: 'mine',
      preset: 'openai',
      apiKey: SECRET,
    });
    expect(response.status).toBe(200);
    let view = await response.json();
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(view.revision).toBe(1);
    expect(view.providers).toContainEqual({
      capabilities: expect.any(Object),
      id: 'mine',
      preset: 'openai',
      source: 'workspace',
      key: { set: true, mask: '…4321' },
    });

    response = await put('alice', 1, { kind: 'slots', set: { llm: 'mine:gpt-5.6' } });
    view = await response.json();
    expect(
      view.slots.find((slot: { slot: string }) => slot.slot === 'classroom').effective,
    ).toMatchObject({
      status: 'assigned',
      source: 'workspace',
      resolvedAt: 'llm',
      modelId: 'gpt-5.6',
    });

    // Stored sealed: neither column holds the key in plain text.
    const rows = await pool.query(
      'SELECT config::text AS c, secrets::text AS s FROM workspace_model_config',
    );
    expect(JSON.stringify(rows)).not.toContain(SECRET);

    // What the workspace saved is what its calls use.
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const resolved = await resolveModel({ stage: 'quiz-grade', workspaceId: 'user:alice' });
    expect(resolved).toMatchObject({ providerId: 'openai', modelId: 'gpt-5.6', apiKey: SECRET });
  });

  it('keeps each workspace to its own settings', async () => {
    await put('alice', null, { kind: 'slots', set: { image: null } });
    const bob = await (await get('bob')).json();
    expect(bob.revision).toBeNull();
    expect(
      bob.slots.find((slot: { slot: string }) => slot.slot === 'image').assignment,
    ).toBeUndefined();
  });

  it('refuses stale revisions and locked slots', async () => {
    await put('alice', null, { kind: 'slots', set: { image: null } });
    const stale = await put('alice', null, { kind: 'slots', set: { tts: null } });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('CONFLICT');
    const locked = await put('alice', 1, { kind: 'slots', set: { video: 'operator:x' } });
    expect(locked.status).toBe(409);
    expect((await locked.json()).error.code).toBe('SLOT_LOCKED');
  });

  it('answers a refused credential with 401 and a malformed body with 400', async () => {
    expect((await get('bad')).status).toBe(401);
    const malformed = await put('alice', 'x' as never, { kind: 'slots' });
    expect(malformed.status).toBe(400);
  });

  it('imports browser settings once, keeping what the workspace already has', async () => {
    const { POST } = await import('@/app/api/model-config/import/route');
    const importFor = (user: string, body: unknown) =>
      POST(
        new Request('http://localhost/api/model-config/import', {
          method: 'POST',
          headers: { 'x-test-session': user, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }) as never,
      );
    const proposal = {
      providers: {
        mine: { preset: 'openai', apiKey: SECRET },
        operator: { preset: 'openai', apiKey: 'sk-takeover' },
        local: { preset: 'comfyui-image' },
      },
      slots: { llm: 'mine:gpt-5.6', video: 'mine:sora' },
    };

    let response = await importFor('alice', proposal);
    expect(response.status).toBe(200);
    let answer = await response.json();
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(answer.imported).toEqual(['mine', 'llm']);
    expect(answer.skipped.map((entry: { item: string }) => entry.item)).toEqual([
      'operator',
      'local',
      'video',
    ]);
    expect(answer.view.revision).toBe(1);

    // Repeating it changes nothing.
    response = await importFor('alice', proposal);
    answer = await response.json();
    expect(answer.imported).toEqual([]);
    expect(answer.view.revision).toBe(1);

    // Another owner sees none of it.
    expect((await (await get('bob')).json()).revision).toBeNull();

    expect((await importFor('alice', { providers: 'nope' })).status).toBe(400);
  });

  it('answers malformed changes with 400, never a server error', async () => {
    const { PUT } = await import('@/app/api/model-config/route');
    const raw = (body: string) =>
      PUT(
        new Request('http://localhost/api/model-config', {
          method: 'PUT',
          headers: { 'x-test-session': 'alice', 'content-type': 'application/json' },
          body,
        }) as never,
      );
    for (const body of [
      'null',
      JSON.stringify({ revision: null, change: { kind: 'slots', clear: {} } }),
      JSON.stringify({ revision: null, change: { kind: 'provider', id: 'x' } }),
      JSON.stringify({ revision: 1.5, change: { kind: 'remove-provider', id: 'x' } }),
      JSON.stringify({ revision: null, change: { kind: 'nope' } }),
    ]) {
      expect((await raw(body)).status).toBe(400);
    }
  });

  it('imports the valid items of a batch and skips the malformed ones', async () => {
    const { POST } = await import('@/app/api/model-config/import/route');
    const response = await POST(
      new Request('http://localhost/api/model-config/import', {
        method: 'POST',
        headers: { 'x-test-session': 'alice', 'content-type': 'application/json' },
        body: JSON.stringify({
          providers: {
            bad_id: { preset: 'openai', apiKey: SECRET },
            good: { preset: 'openai', apiKey: SECRET },
          },
          slots: { llm: 'good:gpt-5.6', 'course.outline': { model: 'good:gpt-5.6', bogus: 1 } },
        }),
      }) as never,
    );
    expect(response.status).toBe(200);
    const answer = await response.json();
    expect(answer.imported).toEqual(['good', 'llm']);
    expect(answer.skipped.map((entry: { item: string }) => entry.item)).toEqual([
      'bad_id',
      'course.outline',
    ]);
  });

  it('recomputes an import against a settings write that won the race', async () => {
    const persistence = await import('@/lib/persistence/workspace-model-config');
    const { POST } = await import('@/app/api/model-config/import/route');
    const importOnce = () =>
      POST(
        new Request('http://localhost/api/model-config/import', {
          method: 'POST',
          headers: { 'x-test-session': 'alice', 'content-type': 'application/json' },
          body: JSON.stringify({
            providers: { mine: { preset: 'openai', apiKey: SECRET } },
            slots: { llm: 'mine:gpt-5.6' },
          }),
        }) as never,
      );
    const save = persistence.saveWorkspaceModelConfig;
    const spy = vi.spyOn(persistence, 'saveWorkspaceModelConfig');
    // A competing write lands between this import's read and its save.
    spy.mockImplementationOnce(async (queryable, ownerId) => {
      await save(queryable, ownerId, { slots: { llm: 'operator:deepseek-v4-pro' } }, null);
      throw new persistence.WorkspaceConfigConflictError();
    });
    let answer = await (await importOnce()).json();
    expect(answer.imported).toEqual(['mine']);
    expect(answer.skipped).toEqual([
      { item: 'llm', reason: 'The workspace already sets this slot' },
    ]);
    expect(answer.view.revision).toBe(2);

    // Losing every time answers 409 and writes nothing.
    spy.mockRejectedValue(new persistence.WorkspaceConfigConflictError());
    const response = await POST(
      new Request('http://localhost/api/model-config/import', {
        method: 'POST',
        headers: { 'x-test-session': 'alice', 'content-type': 'application/json' },
        body: JSON.stringify({ providers: { other: { preset: 'openai', apiKey: SECRET } } }),
      }) as never,
    );
    expect(response.status).toBe(409);
    spy.mockRestore();
    answer = await (await get('alice')).json();
    expect(answer.revision).toBe(2);
  });
});
