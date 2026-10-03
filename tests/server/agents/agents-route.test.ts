import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnerAuthMethod } from '@/lib/server/identity/types';

/**
 * /api/agents and the server resolver on the real routes, owner seam and an
 * in-memory PostgreSQL: built-in agents are listed read-only and refuse every
 * change, custom agents are the owner's alone, bodies are checked with the
 * client's schema, and the legacy import is safe to repeat.
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
    return {
      status: 'authenticated',
      principal: { ownerId: `user:${user}`, kind: 'user', roles: new Set(), assurance: 'verified' },
    };
  },
};

function agent(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Agent ${id}`,
    role: 'student',
    persona: 'Asks good questions.',
    avatar: '/avatars/curious.png',
    color: '#ec4899',
    allowedActions: ['wb_open'],
    priority: 5,
    ...extra,
  };
}

describe('/api/agents', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://agents-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('ACCESS_CODE', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    const { configureOwnerAuthentication } = await import('@/lib/server/identity');
    configureOwnerAuthentication({ methods: [sessionMethod] });
  });

  afterEach(async () => {
    const { resetOwnerAuthenticationForTests } = await import('@/lib/server/identity/registry');
    resetOwnerAuthenticationForTests();
    await pool.end();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const request = (user: string, path: string, method: string, body?: unknown) =>
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'x-test-session': user, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) as never;

  async function list(user: string) {
    const { GET } = await import('@/app/api/agents/route');
    return GET(request(user, '/api/agents', 'GET'));
  }
  async function create(user: string, body: unknown) {
    const { POST } = await import('@/app/api/agents/route');
    return POST(request(user, '/api/agents', 'POST', body));
  }
  async function update(user: string, id: string, body: unknown) {
    const { PUT } = await import('@/app/api/agents/[id]/route');
    return PUT(request(user, `/api/agents/${id}`, 'PUT', body), {
      params: Promise.resolve({ id }),
    });
  }
  async function remove(user: string, id: string) {
    const { DELETE } = await import('@/app/api/agents/[id]/route');
    return DELETE(request(user, `/api/agents/${id}`, 'DELETE'), {
      params: Promise.resolve({ id }),
    });
  }
  async function importAgents(user: string, body: unknown) {
    const { POST } = await import('@/app/api/agents/import/route');
    return POST(request(user, '/api/agents/import', 'POST', body));
  }

  it('lists the built-in agents read-only, then the owner’s own', async () => {
    const before = await (await list('alice')).json();
    expect(before.agents.map((a: { id: string }) => a.id)).toEqual([
      'default-1',
      'default-2',
      'default-3',
      'default-4',
      'default-5',
      'default-6',
    ]);
    expect(before.agents.every((a: { readOnly: boolean }) => a.readOnly)).toBe(true);

    const created = await create('alice', { agent: agent('tutor') });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.agent).toMatchObject({
      ...agent('tutor'),
      isDefault: false,
      readOnly: false,
      createdAt: expect.any(String),
    });

    const after = await (await list('alice')).json();
    expect(after.agents.at(-1)).toMatchObject({ id: 'tutor', readOnly: false });
  });

  it('updates and deletes a custom agent', async () => {
    await create('alice', { agent: agent('tutor') });
    const updated = await update('alice', 'tutor', {
      agent: {
        ...agent('tutor'),
        name: 'Renamed',
        voiceDesign: { identity: 'a', texture: 'b', delivery: 'c' },
      },
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).agent).toMatchObject({ id: 'tutor', name: 'Renamed' });

    // The id is the path's; a body naming another is refused.
    const mismatched = await update('alice', 'tutor', { agent: agent('other') });
    expect(mismatched.status).toBe(400);

    expect((await remove('alice', 'tutor')).status).toBe(204);
    expect((await remove('alice', 'tutor')).status).toBe(404);
    expect((await update('alice', 'tutor', { agent: agent('tutor') })).status).toBe(404);
  });

  it('refuses to change, delete or shadow a built-in agent', async () => {
    for (const response of [
      await update('alice', 'default-1', { agent: { ...agent('default-1'), name: 'Mine' } }),
      await remove('alice', 'default-1'),
      await create('alice', { agent: agent('default-1') }),
      await create('alice', { agent: agent('default-99') }),
    ]) {
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('BUILT_IN_AGENT_READ_ONLY');
    }
  });

  it('checks bodies with the registry schema', async () => {
    const cases = [
      undefined,
      { agent: 'x' },
      { agent: { ...agent('tutor'), name: '' } },
      { agent: { ...agent('tutor'), priority: 'high' } },
      { agent: { ...agent('tutor'), priority: 1_000 } },
      { agent: { ...agent('tutor'), isGenerated: true } },
      { agent: { ...agent('has space') } },
      { agent: { ...agent('tutor'), voiceConfig: { providerId: 'x' } } },
    ];
    for (const body of cases) {
      const response = await create('alice', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const duplicate = await create('alice', { agent: agent('tutor') });
    expect(duplicate.status).toBe(201);
    const again = await create('alice', { agent: agent('tutor') });
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe('AGENT_EXISTS');
  });

  it('keeps each owner to its own agents', async () => {
    await create('alice', { agent: agent('tutor') });
    const bob = await (await list('bob')).json();
    expect(bob.agents.some((a: { id: string }) => a.id === 'tutor')).toBe(false);
    expect((await update('bob', 'tutor', { agent: agent('tutor') })).status).toBe(404);
    expect((await remove('bob', 'tutor')).status).toBe(404);
    // Bob may use the same id for an agent of his own.
    expect((await create('bob', { agent: agent('tutor', { name: 'Bob tutor' }) })).status).toBe(
      201,
    );
    const alice = await (await list('alice')).json();
    expect(alice.agents.find((a: { id: string }) => a.id === 'tutor').name).toBe('Agent tutor');
  });

  it('caps the custom agents an owner keeps', async () => {
    const { MAX_CUSTOM_AGENTS } = await import('@/lib/orchestration/registry/schema');
    const imported = await importAgents('alice', {
      agents: Array.from({ length: MAX_CUSTOM_AGENTS }, (_, index) => agent(`a-${index}`)),
    });
    expect((await imported.json()).imported).toHaveLength(MAX_CUSTOM_AGENTS);
    const over = await create('alice', { agent: agent('one-more') });
    expect(over.status).toBe(409);
    expect((await over.json()).error.code).toBe('AGENT_LIMIT_REACHED');
  });

  it('imports browser agents once, keeping what the owner already has', async () => {
    await create('alice', { agent: agent('tutor', { name: 'Server tutor' }) });
    const body = {
      agents: [
        agent('tutor', { name: 'Browser tutor' }),
        agent('buddy'),
        agent('default-1'),
        { ...agent('broken'), priority: 'high' },
      ],
    };
    const first = await (await importAgents('alice', body)).json();
    expect(first.imported).toEqual(['buddy']);
    expect(first.skipped).toEqual([
      { id: 'default-1', reason: 'built-in' },
      { id: 'broken', reason: expect.stringMatching(/^invalid: priority/) },
      { id: 'tutor', reason: 'exists' },
    ]);
    const second = await (await importAgents('alice', body)).json();
    expect(second.imported).toEqual([]);

    const agents = (await (await list('alice')).json()).agents as { id: string; name: string }[];
    expect(agents.filter((a) => !a.id.startsWith('default-'))).toEqual([
      expect.objectContaining({ id: 'tutor', name: 'Server tutor' }),
      expect.objectContaining({ id: 'buddy' }),
    ]);
    expect((await importAgents('alice', { agents: 'nope' })).status).toBe(400);
  });

  it('refuses bodies over the size limit', async () => {
    const huge = { agent: { ...agent('tutor'), persona: 'x'.repeat(300 * 1024) } };
    const response = await create('alice', huge);
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe('BODY_TOO_LARGE');
    const importing = await importAgents('alice', { agents: [], pad: 'x'.repeat(9 * 1024 * 1024) });
    expect(importing.status).toBe(413);
  });

  it('treats ids that name Object.prototype members as ordinary ids', async () => {
    for (const id of ['constructor', '__proto__', 'toString']) {
      expect((await create('alice', { agent: agent(id) })).status, id).toBe(201);
    }
    const listed = (await (await list('alice')).json()).agents as { id: string }[];
    expect(
      listed
        .slice(-3)
        .map((a) => a.id)
        .sort(),
    ).toEqual(['__proto__', 'constructor', 'toString']);

    const { resolveAgentsForOwner } = await import('@/lib/server/agents/registry');
    const resolved = await resolveAgentsForOwner('user:alice', ['toString', 'constructor']);
    expect(resolved.map((a) => [a.id, a.name])).toEqual([
      ['toString', 'Agent toString'],
      ['constructor', 'Agent constructor'],
    ]);
    // Not inherited: bob has none of them.
    await expect(
      resolveAgentsForOwner('user:bob', ['constructor', 'hasOwnProperty']),
    ).rejects.toMatchObject({
      agentIds: ['constructor', 'hasOwnProperty'],
    });
  });

  it('takes the largest schema-valid agent, a full-length CJK persona included', async () => {
    const { MAX_AGENT_JSON_BYTES, customAgentSchema } =
      await import('@/lib/orchestration/registry/schema');
    // Every string at its limit, in characters JSON escapes to six bytes.
    const worst = {
      id: 'w'.repeat(128),
      name: '\u0001'.repeat(200),
      role: '\u0001'.repeat(64),
      persona: '\u0001'.repeat(32_000),
      avatar: '\u0001'.repeat(2_048),
      color: '\u0001'.repeat(64),
      allowedActions: Array.from({ length: 64 }, () => '\u0001'.repeat(64)),
      priority: 100,
      voiceConfig: {
        providerId: '\u0001'.repeat(64),
        modelId: '\u0001'.repeat(128),
        voiceId: '\u0001'.repeat(256),
      },
      voiceDesign: {
        identity: '\u0001'.repeat(500),
        texture: '\u0001'.repeat(500),
        delivery: '\u0001'.repeat(500),
      },
    };
    expect(customAgentSchema.safeParse(worst).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(worst))).toBeLessThanOrEqual(MAX_AGENT_JSON_BYTES);
    expect((await create('alice', { agent: worst })).status).toBe(201);

    const cjk = agent('cjk', { persona: '课'.repeat(32_000) });
    expect((await create('alice', { agent: cjk })).status).toBe(201);
    const updated = await update('alice', 'cjk', { agent: { ...cjk, name: '助教' } });
    expect(updated.status).toBe(200);
    expect((await updated.json()).agent.persona).toHaveLength(32_000);
  });

  it('imports a full registry of maximum-size agents in batches', async () => {
    const { runAgentsImport, LEGACY_AGENT_REGISTRY_KEY } =
      await import('@/lib/legacy-browser-import/agents-import');
    const { MAX_CUSTOM_AGENTS } = await import('@/lib/orchestration/registry/schema');
    const { MemoryStorage } = await import('../../legacy-browser-import/harness');
    const routes: Record<string, () => Promise<{ POST: (req: never) => Promise<Response> }>> = {
      '/api/identity/legacy-import-binding': () =>
        import('@/app/api/identity/legacy-import-binding/route') as never,
      '/api/agents/import': () => import('@/app/api/agents/import/route') as never,
    };
    const fetchToRoutes = vi.fn(async (url: string, init?: RequestInit) => {
      const { POST } = await routes[url]!();
      return POST(
        new Request(`http://localhost${url}`, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string>),
            'x-test-session': 'alice',
            'sec-fetch-site': 'same-origin',
          },
        }) as never,
      );
    });
    const storage = new MemoryStorage();
    const agents = Array.from({ length: MAX_CUSTOM_AGENTS }, (_, index) =>
      agent(`big-${index}`, { persona: '课'.repeat(32_000), isDefault: false }),
    );
    storage.setItem(
      LEGACY_AGENT_REGISTRY_KEY,
      JSON.stringify({ state: { agents: Object.fromEntries(agents.map((a) => [a.id, a])) } }),
    );

    await expect(runAgentsImport({ fetch: fetchToRoutes, storage })).resolves.toEqual({
      outcome: 'imported',
      imported: MAX_CUSTOM_AGENTS,
      pending: [],
    });
    const posts = fetchToRoutes.mock.calls.filter(([url]) => url === '/api/agents/import');
    expect(posts.length).toBeGreaterThan(1);
    const listed = (await (await list('alice')).json()).agents as { id: string }[];
    expect(listed.filter((a) => a.id.startsWith('big-'))).toHaveLength(MAX_CUSTOM_AGENTS);
  }, 60_000);

  describe('the server resolver', () => {
    it('resolves built-in and custom ids in order, and names every unknown one', async () => {
      await create('alice', { agent: agent('tutor') });
      const { resolveAgentsForOwner, listAgentsForOwner, UnknownAgentsError } =
        await import('@/lib/server/agents/registry');

      const resolved = await resolveAgentsForOwner('user:alice', ['tutor', 'default-1']);
      expect(resolved.map((a) => [a.id, a.isDefault])).toEqual([
        ['tutor', false],
        ['default-1', true],
      ]);
      expect(resolved[0]!.createdAt).toBeInstanceOf(Date);

      const refusal = resolveAgentsForOwner('user:bob', ['default-2', 'tutor', 'ghost']);
      await expect(refusal).rejects.toBeInstanceOf(UnknownAgentsError);
      await expect(refusal).rejects.toMatchObject({
        code: 'UNKNOWN_AGENTS',
        agentIds: ['tutor', 'ghost'],
      });

      expect((await listAgentsForOwner('user:alice')).map((a) => a.id)).toEqual([
        'default-1',
        'default-2',
        'default-3',
        'default-4',
        'default-5',
        'default-6',
        'tutor',
      ]);
    });

    it('resolves built-in ids without the database', async () => {
      const { resolveAgentsForOwner } = await import('@/lib/server/agents/registry');
      const query = vi.spyOn(pool, 'query');
      const resolved = await resolveAgentsForOwner('user:alice', ['default-3']);
      expect(resolved.map((a) => a.id)).toEqual(['default-3']);
      expect(query).not.toHaveBeenCalled();
    });
  });
});
