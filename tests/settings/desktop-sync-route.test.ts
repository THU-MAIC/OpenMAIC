import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class WorkspaceConfigConflictError extends Error {}
  return {
    readWorkspaceModelConfig: vi.fn(),
    saveWorkspaceModelConfig: vi.fn(),
    WorkspaceConfigConflictError,
  };
});

vi.mock('@/lib/config/feature-flags', () => ({
  isServerPersistenceConfigured: () => true,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: {} }),
}));
vi.mock('@/lib/persistence/workspace-model-config', () => ({
  readWorkspaceModelConfig: mocks.readWorkspaceModelConfig,
  saveWorkspaceModelConfig: mocks.saveWorkspaceModelConfig,
  WorkspaceConfigConflictError: mocks.WorkspaceConfigConflictError,
}));
vi.mock('@/lib/server/identity/with-owner', () => ({
  withRequestOwner: async (
    request: NextRequest,
    handler: (principal: { ownerId: string }, headers: Headers) => Promise<Response>,
  ) => handler({ ownerId: request.headers.get('x-test-owner') ?? 'missing-owner' }, new Headers()),
}));

const TOKEN = 'desktop-test-token';
const SOURCE = 'user:web';
const TARGET = 'user:desktop';

function request(
  method: 'GET' | 'POST',
  {
    owner,
    desktop = false,
    body,
    id,
  }: { owner: string; desktop?: boolean; body?: unknown; id?: string },
) {
  const url = new URL('http://localhost:3000/api/desktop-sync');
  if (id) url.searchParams.set('id', id);
  return new NextRequest(url, {
    method,
    headers: {
      'x-test-owner': owner,
      ...(desktop ? { 'x-openmaic-desktop-sync': TOKEN } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function route() {
  return import('@/app/api/desktop-sync/route');
}

async function createTransfer(config: unknown, revision = 3) {
  mocks.readWorkspaceModelConfig.mockResolvedValueOnce({
    config,
    revision,
    unreadableSecrets: [],
  });
  const { POST } = await route();
  const response = await POST(request('POST', { owner: SOURCE, body: { action: 'create' } }));
  return { response, id: ((await response.clone().json()) as { id: string }).id };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  vi.stubEnv('OPENMAIC_DESKTOP_SYNC_ENABLED', '1');
  vi.stubEnv('OPENMAIC_DESKTOP_SYNC_TOKEN', TOKEN);
  mocks.readWorkspaceModelConfig.mockReset();
  mocks.saveWorkspaceModelConfig.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

describe('desktop model configuration transfer', () => {
  it('keeps discovery read-only and never returns provider credentials', async () => {
    const config = {
      providers: { openai: { preset: 'openai', apiKey: 'sk-real-secret' } },
      slots: { llm: 'openai:gpt-5' },
    };
    const { response, id } = await createTransfer(config);
    expect(response.status).toBe(202);
    expect(await response.clone().text()).not.toContain('sk-real-secret');

    mocks.readWorkspaceModelConfig.mockClear();
    const { GET } = await route();
    const discovered = await GET(request('GET', { owner: TARGET, desktop: true }));
    expect(discovered.status).toBe(200);
    expect(await discovered.json()).toMatchObject({ id });
    expect(mocks.readWorkspaceModelConfig).not.toHaveBeenCalled();
    expect(mocks.saveWorkspaceModelConfig).not.toHaveBeenCalled();
  });

  it('copies the opened server configuration to the registered desktop owner', async () => {
    const config = {
      providers: { openai: { preset: 'openai', apiKey: 'sk-real-secret' } },
      slots: { llm: 'openai:gpt-5' },
    };
    const { id } = await createTransfer(config);
    mocks.readWorkspaceModelConfig.mockResolvedValueOnce({
      config: { slots: { llm: null } },
      revision: 7,
      unreadableSecrets: [],
    });
    mocks.saveWorkspaceModelConfig.mockResolvedValueOnce(8);
    const { POST, GET } = await route();

    expect(
      (
        await POST(
          request('POST', {
            owner: TARGET,
            desktop: true,
            body: { action: 'register', id },
          }),
        )
      ).status,
    ).toBe(200);
    const applied = await POST(
      request('POST', { owner: TARGET, desktop: true, body: { action: 'apply', id } }),
    );
    expect(applied.status).toBe(200);
    expect(await applied.json()).toEqual({ saved: true, revision: 8 });

    expect(mocks.saveWorkspaceModelConfig).toHaveBeenCalledWith({}, TARGET, config, 7);
    expect(await (await GET(request('GET', { owner: SOURCE, id }))).json()).toEqual({
      applied: false,
    });
    expect(
      await (await GET(request('GET', { owner: TARGET, desktop: true }))).json(),
    ).toMatchObject({
      id,
    });

    const repeated = await POST(
      request('POST', { owner: TARGET, desktop: true, body: { action: 'apply', id } }),
    );
    expect(await repeated.json()).toEqual({ saved: true, revision: 8 });
    expect(mocks.saveWorkspaceModelConfig).toHaveBeenCalledTimes(1);

    const confirmed = await POST(
      request('POST', { owner: TARGET, desktop: true, body: { action: 'confirm', id } }),
    );
    expect(confirmed.status).toBe(200);
    expect(await (await GET(request('GET', { owner: SOURCE, id }))).json()).toEqual({
      applied: true,
    });
    const repeatedConfirm = await POST(
      request('POST', { owner: TARGET, desktop: true, body: { action: 'confirm', id } }),
    );
    expect(repeatedConfirm.status).toBe(200);
  });

  it('refuses a source configuration whose sealed credentials cannot be opened', async () => {
    mocks.readWorkspaceModelConfig.mockResolvedValueOnce({
      config: { providers: { openai: { preset: 'openai' } } },
      revision: 4,
      unreadableSecrets: ['openai'],
    });
    const { POST } = await route();
    const response = await POST(request('POST', { owner: SOURCE, body: { action: 'create' } }));

    expect(response.status).toBe(409);
    expect(mocks.saveWorkspaceModelConfig).not.toHaveBeenCalled();
  });

  it('does not overwrite a desktop revision that changes after registration', async () => {
    const { id } = await createTransfer({ slots: { llm: null } });
    mocks.readWorkspaceModelConfig.mockResolvedValueOnce({
      config: { slots: {} },
      revision: 11,
      unreadableSecrets: [],
    });
    mocks.saveWorkspaceModelConfig.mockRejectedValueOnce(new mocks.WorkspaceConfigConflictError());
    const { POST, GET } = await route();
    await POST(request('POST', { owner: TARGET, desktop: true, body: { action: 'register', id } }));
    const applied = await POST(
      request('POST', { owner: TARGET, desktop: true, body: { action: 'apply', id } }),
    );

    expect(applied.status).toBe(409);
    expect(mocks.saveWorkspaceModelConfig).toHaveBeenCalledWith(
      {},
      TARGET,
      { slots: { llm: null } },
      11,
    );
    expect(mocks.readWorkspaceModelConfig).toHaveBeenCalledTimes(2);
    const status = await GET(request('GET', { owner: SOURCE, id }));
    expect(await status.json()).toEqual({
      applied: false,
      error: 'Desktop settings changed during synchronization',
    });
  });

  it('requires the Electron-injected credential for registration', async () => {
    const { id } = await createTransfer({ slots: {} });
    const { POST } = await route();
    const response = await POST(
      request('POST', { owner: TARGET, body: { action: 'register', id } }),
    );
    expect(response.status).toBe(403);
  });

  it('allows only one source creation while the source read is in flight', async () => {
    let finishRead!: (value: {
      config: { slots: Record<string, never> };
      revision: number;
      unreadableSecrets: never[];
    }) => void;
    mocks.readWorkspaceModelConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const { POST } = await route();
    const first = POST(request('POST', { owner: SOURCE, body: { action: 'create' } }));
    await Promise.resolve();

    const second = await POST(request('POST', { owner: 'user:other', body: { action: 'create' } }));
    expect(second.status).toBe(409);

    finishRead({ config: { slots: {} }, revision: 1, unreadableSecrets: [] });
    expect((await first).status).toBe(202);
  });

  it('serializes concurrent apply requests for the same transfer', async () => {
    const { id } = await createTransfer({ slots: { llm: null } });
    mocks.readWorkspaceModelConfig.mockResolvedValueOnce({
      config: { slots: {} },
      revision: 2,
      unreadableSecrets: [],
    });
    let finishSave!: (revision: number) => void;
    mocks.saveWorkspaceModelConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    const { POST } = await route();
    await POST(request('POST', { owner: TARGET, desktop: true, body: { action: 'register', id } }));
    const first = POST(
      request('POST', { owner: TARGET, desktop: true, body: { action: 'apply', id } }),
    );
    await Promise.resolve();
    const second = await POST(
      request('POST', { owner: TARGET, desktop: true, body: { action: 'apply', id } }),
    );

    expect(second.status).toBe(409);
    expect(mocks.saveWorkspaceModelConfig).toHaveBeenCalledTimes(1);
    finishSave(3);
    expect((await first).status).toBe(200);
  });

  it('refuses a stale snapshot when source and desktop resolve to the same owner', async () => {
    const { id } = await createTransfer({ slots: { llm: null } }, 5);
    mocks.readWorkspaceModelConfig.mockResolvedValueOnce({
      config: { slots: { llm: 'openai:gpt-5' } },
      revision: 6,
      unreadableSecrets: [],
    });
    const { POST, GET } = await route();
    const registered = await POST(
      request('POST', { owner: SOURCE, desktop: true, body: { action: 'register', id } }),
    );

    expect(registered.status).toBe(409);
    expect(mocks.saveWorkspaceModelConfig).not.toHaveBeenCalled();
    const status = await GET(request('GET', { owner: SOURCE, id }));
    expect(await status.json()).toEqual({
      applied: false,
      error: 'Source settings changed during synchronization',
    });
  });

  it('rechecks a same-owner revision before confirming without a write', async () => {
    const { id } = await createTransfer({ slots: { llm: null } }, 5);
    mocks.readWorkspaceModelConfig
      .mockResolvedValueOnce({
        config: { slots: { llm: null } },
        revision: 5,
        unreadableSecrets: [],
      })
      .mockResolvedValueOnce({
        config: { slots: { llm: 'openai:gpt-5' } },
        revision: 6,
        unreadableSecrets: [],
      });
    const { POST } = await route();
    expect(
      (
        await POST(
          request('POST', { owner: SOURCE, desktop: true, body: { action: 'register', id } }),
        )
      ).status,
    ).toBe(200);
    const applied = await POST(
      request('POST', { owner: SOURCE, desktop: true, body: { action: 'apply', id } }),
    );

    expect(applied.status).toBe(409);
    expect(mocks.saveWorkspaceModelConfig).not.toHaveBeenCalled();
  });
});
