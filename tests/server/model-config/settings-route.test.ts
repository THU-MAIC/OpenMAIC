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
          lock: ['video'],
        },
      },
      legacy: false,
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
    expect(initial.allowUserKeys).toBe(true);
    expect(initial).not.toHaveProperty('policy');

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
      presetName: 'OpenAI',
      presetKind: 'single',
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
    // A slot below a locked one is fixed with it.
    (await import('@/lib/server/model-config/runtime')).setDeploymentConfigForTests({
      layer: {
        source: 'deployment',
        config: {
          providers: { operator: { preset: 'deepseek', apiKey: 'sk-operator' } },
          slots: { llm: 'operator:deepseek-v4-pro' },
          lock: ['llm'],
        },
      },
      legacy: false,
      notices: [],
    });
    const below = await put('alice', 1, {
      kind: 'slots',
      set: { 'course.content.slide': 'operator:deepseek-v4-flash' },
    });
    expect(below.status).toBe(409);
    expect((await below.json()).error.code).toBe('SLOT_LOCKED');
  });

  it('refuses a thinking effort on the agent slot, and drops the one it inherits', async () => {
    const refused = await put('alice', null, {
      kind: 'slots',
      set: { agent: { model: 'operator:deepseek-v4-flash', thinking: { effort: 'high' } } },
    });
    expect(refused.status).toBe(400);
    const error = (await refused.json()).error;
    expect(error.code).toBe('INVALID_ASSIGNMENT');
    expect(error.message).toContain('the agent slot cannot set a thinking effort');
    expect((await get('alice')).status).toBe(200);
    expect((await (await get('alice')).json()).revision).toBeNull();

    // On/off without an effort is fine on the agent itself.
    const toggled = await put('alice', null, {
      kind: 'slots',
      set: { agent: { model: 'operator:deepseek-v4-flash', thinking: { mode: 'disabled' } } },
    });
    expect(toggled.status).toBe(200);

    // A level picked for the default model is saved, and the agent that
    // follows it runs without the effort.
    const saved = await put('alice', 1, {
      kind: 'slots',
      set: {
        llm: { model: 'operator:deepseek-v4-flash', thinking: { mode: 'enabled', effort: 'max' } },
      },
      clear: ['agent'],
    });
    expect(saved.status).toBe(200);
    const { resolveAgentDriverModel } =
      await import('@/lib/server/agent-runtime/agent-driver-model');
    const driver = await resolveAgentDriverModel('user:alice');
    expect(driver.connection).toMatchObject({
      modelId: 'deepseek-v4-flash',
      thinkingConfig: { mode: 'enabled' },
    });
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
    expect(answer.imported).toEqual([
      { kind: 'provider', id: 'mine' },
      { kind: 'slot', id: 'llm' },
    ]);
    expect(
      answer.skipped.map((entry: { kind: string; id: string }) => `${entry.kind}:${entry.id}`),
    ).toEqual(['provider:operator', 'provider:local', 'slot:video']);
    expect(answer.view.revision).toBe(1);

    // Repeating it changes nothing, and finds its own provider there.
    response = await importFor('alice', proposal);
    answer = await response.json();
    expect(answer.imported).toEqual([]);
    expect(answer.skipped).toContainEqual(
      expect.objectContaining({ kind: 'provider', id: 'mine', code: 'EXISTS_SAME' }),
    );
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
            typed: { preset: 'openai', apiKey: 42 },
            good: { preset: 'openai', apiKey: SECRET },
          },
          slots: { llm: 'good:gpt-5.6', 'course.outline': { model: 'good:gpt-5.6', bogus: 1 } },
        }),
      }) as never,
    );
    expect(response.status).toBe(200);
    const answer = await response.json();
    expect(answer.imported).toEqual([
      { kind: 'provider', id: 'good' },
      { kind: 'slot', id: 'llm' },
    ]);
    expect(answer.skipped.map((entry: { id: string }) => entry.id)).toEqual([
      'bad_id',
      'typed',
      'course.outline',
    ]);
  });

  it('lets the browser drop a provider only when the workspace stores the same key', async () => {
    const { POST } = await import('@/app/api/model-config/import/route');
    const importFor = (body: unknown) =>
      POST(
        new Request('http://localhost/api/model-config/import', {
          method: 'POST',
          headers: { 'x-test-session': 'alice', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }) as never,
      );
    const OTHER = 'sk-browser-other-secret-9876';
    // The workspace's `openai` holds key A, sealed in the database.
    expect(
      (
        await put('alice', null, {
          kind: 'provider',
          id: 'openai',
          preset: 'openai',
          apiKey: SECRET,
        })
      ).status,
    ).toBe(200);
    const stored = await pool.query('SELECT * FROM workspace_model_config');
    expect(stored.rows).toHaveLength(1);
    expect(JSON.stringify(stored.rows)).not.toContain(SECRET);

    const codeFor = async (body: unknown) => {
      const response = await importFor(body);
      expect(response.status).toBe(200);
      const text = await response.text();
      const answer = JSON.parse(text);
      // Neither key comes back, and the outcome says nothing of them but
      // equal or not (the view shows its usual mask).
      for (const key of [SECRET, OTHER]) {
        expect(text).not.toContain(key);
        expect(JSON.stringify(answer.skipped)).not.toContain(key.slice(-4));
      }
      expect(answer.imported).toEqual([]);
      return answer.skipped.map((entry: { kind: string; id: string; code: string }) => [
        entry.kind,
        entry.id,
        entry.code,
      ]);
    };

    // Key B under the same id: the server keeps A, and says it is not B.
    expect(await codeFor({ providers: { openai: { preset: 'openai', apiKey: OTHER } } })).toEqual([
      ['provider', 'openai', 'EXISTS_DIFFERENT'],
    ]);
    // No key, or another endpoint: not the same setting either.
    expect(await codeFor({ providers: { openai: { preset: 'openai' } } })).toEqual([
      ['provider', 'openai', 'EXISTS_DIFFERENT'],
    ]);
    expect(
      await codeFor({
        providers: {
          openai: { preset: 'openai', apiKey: SECRET, baseUrl: 'https://gateway.example.com/v1' },
        },
      }),
    ).toEqual([['provider', 'openai', 'EXISTS_DIFFERENT']]);
    // Key A: the same setting, which the browser may let go of.
    expect(await codeFor({ providers: { openai: { preset: 'openai', apiKey: SECRET } } })).toEqual([
      ['provider', 'openai', 'EXISTS_SAME'],
    ]);

    // Under another instance secret the stored key cannot be opened: nothing is confirmed.
    vi.stubEnv('OPENMAIC_SECRET_KEY', 'another-instance-secret');
    const { resetInstanceKeyForTests } = await import('@/lib/server/secret-box');
    resetInstanceKeyForTests();
    expect(await codeFor({ providers: { openai: { preset: 'openai', apiKey: SECRET } } })).toEqual([
      ['provider', 'openai', 'EXISTS_DIFFERENT'],
    ]);
  });

  it('keeps the browser settings, keys included, when the route refuses the proposal', async () => {
    const { POST } = await import('@/app/api/model-config/import/route');
    const { runModelSettingsImport } =
      await import('@/lib/legacy-browser-import/model-settings-import');
    const { MODEL_SETTINGS_IMPORT_ENDPOINT, MODEL_SETTINGS_IMPORT_KEY } =
      await import('@/lib/legacy-browser-import/model-settings');
    const { readUnimported } =
      await import('@/lib/legacy-browser-import/model-settings-unimported');
    const { BINDING_ENDPOINT } = await import('@/lib/legacy-browser-import/protocol');
    const { MemoryStorage } = await import('../../legacy-browser-import/harness');

    // A readable proposal with a valid provider and key, and one field the
    // route does not expect.
    const storage = new MemoryStorage();
    storage.setItem(
      MODEL_SETTINGS_IMPORT_KEY,
      JSON.stringify({
        providers: { mine: { preset: 'openai', apiKey: SECRET } },
        slots: { llm: 'mine:gpt-5.6' },
        unexpected: true,
      }),
    );
    const statuses: number[] = [];
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === BINDING_ENDPOINT) return Response.json({ bound: true });
      if (input !== MODEL_SETTINGS_IMPORT_ENDPOINT) throw new Error(`unexpected ${input}`);
      const headers = new Headers(init?.headers);
      headers.set('x-test-session', 'alice');
      const response = await POST(
        new Request(`http://localhost${input}`, { ...init, headers }) as never,
      );
      statuses.push(response.status);
      return response;
    });

    expect(await runModelSettingsImport({ fetch, storage })).toBe('dropped');
    expect(statuses).toEqual([400]);
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
    expect(readUnimported(storage).items).toEqual([
      expect.objectContaining({
        kind: 'provider',
        id: 'mine',
        reason: 'refused',
        settings: { preset: 'openai', apiKey: SECRET },
      }),
      expect.objectContaining({ kind: 'slot', id: 'llm', reason: 'refused' }),
    ]);
    // Nothing reached the workspace, and nothing is sent again.
    expect((await (await get('alice')).json()).revision).toBeNull();
    expect(await runModelSettingsImport({ fetch, storage })).toBe('none');
    expect(statuses).toEqual([400]);
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
    expect(answer.imported).toEqual([{ kind: 'provider', id: 'mine' }]);
    expect(answer.skipped).toEqual([
      { kind: 'slot', id: 'llm', code: 'EXISTS', reason: 'The workspace already sets this slot' },
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
