import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const state = vi.hoisted(() => ({
  pool: {} as object,
  lock: vi.fn<(pool: object) => Promise<void>>(),
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: state.pool }),
}));
vi.mock('@/lib/persistence/schema-bootstrap-lock', () => ({
  withSchemaBootstrapLock: state.lock,
}));
import { SandboxStore } from '@/lib/server/sandbox/store';
import { sessionSandboxTools } from '@/lib/server/sandbox/agent-tools';

const grant = {
  session_id: 'session',
  environment_id: '11111111-1111-4111-8111-111111111111',
  grant_id: 'grant',
  allow_writes: false,
  allow_commands: false,
};
function poolAnswering(query: () => Promise<unknown>) {
  return { query: vi.fn(query) };
}

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://schema-provision');
  state.pool = poolAnswering(async () => ({ rows: [] }));
  state.lock.mockReset();
  state.lock.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('sandbox schema provisioning', () => {
  it('runs the schema step once for repeated and concurrent opens', async () => {
    await Promise.all([SandboxStore.open(), SandboxStore.open()]);
    await SandboxStore.open();
    expect(state.lock).toHaveBeenCalledTimes(1);
  });

  it('retries a failed schema step on a later open, then retains its success', async () => {
    state.lock.mockRejectedValueOnce(new Error('migration failed'));
    await expect(SandboxStore.open()).rejects.toThrow('migration failed');
    await SandboxStore.open();
    await SandboxStore.open();
    expect(state.lock).toHaveBeenCalledTimes(2);
  });

  it('provisions a replaced pool again', async () => {
    await SandboxStore.open();
    state.pool = poolAnswering(async () => ({ rows: [] }));
    await SandboxStore.open();
    expect(state.lock).toHaveBeenCalledTimes(2);
  });
});

describe('session start without a sandbox grant', () => {
  it('neither takes the schema lock nor fails while the sandbox schema is failing', async () => {
    state.lock.mockRejectedValue(new Error('migration failed'));
    await expect(sessionSandboxTools('session', 'owner')).resolves.toEqual([]);
    expect(state.lock).not.toHaveBeenCalled();
  });

  it('treats a database without the grant table as holding no grant', async () => {
    const db = new PGlite();
    await db.waitReady;
    state.pool = { query: (text: string, params?: unknown[]) => db.query(text, params) };
    state.lock.mockRejectedValue(new Error('migration failed'));
    try {
      await expect(sessionSandboxTools('session', 'owner')).resolves.toEqual([]);
      expect(state.lock).not.toHaveBeenCalled();
      const { rows } = await db.query<{ table: string | null }>(
        "SELECT to_regclass('sandbox_session_grants')::text AS table",
      );
      expect(rows[0].table).toBeNull();
    } finally {
      await db.close();
    }
  }, 30_000);

  it('does not mistake a database failure for a missing grant', async () => {
    state.pool = poolAnswering(async () => {
      throw Object.assign(new Error('connection lost'), { code: '57P01' });
    });
    await expect(sessionSandboxTools('session', 'owner')).rejects.toThrow('connection lost');
  });

  it('returns no tools and no query without a database', async () => {
    vi.stubEnv('DATABASE_URL', '');
    await expect(sessionSandboxTools('session', 'owner')).resolves.toEqual([]);
    expect((state.pool as { query: unknown }).query).not.toHaveBeenCalled();
  });
});

describe('session start with a sandbox grant', () => {
  beforeEach(() => {
    state.pool = poolAnswering(async () => ({ rows: [grant] }));
  });

  it('provisions the schema and registers the granted tools', async () => {
    const tools = await sessionSandboxTools('session', 'owner');
    expect(tools.map(({ name }) => name)).toEqual(['sandbox_read_file', 'sandbox_list_files']);
    expect(state.lock).toHaveBeenCalledTimes(1);
  });

  it('still fails on a schema failure, as it always has', async () => {
    state.lock.mockRejectedValueOnce(new Error('migration failed'));
    await expect(sessionSandboxTools('session', 'owner')).rejects.toThrow('migration failed');
  });
});
