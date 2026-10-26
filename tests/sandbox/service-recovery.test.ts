import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { SandboxService } from '@/lib/server/sandbox/service';
import { SandboxError } from '@/lib/sandbox/errors';
import { createHash } from 'node:crypto';
const archiveHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const id = '12345678-1234-1234-1234-123456789012';
const bytes = Buffer.from(JSON.stringify({ version: 1, files: [], directories: [] }));
const config = {
  fingerprint: 'test-fingerprint',
  lifetimeMs: 300000,
  maxActive: 5,
  maxActivePerOwner: 1,
};
let row: Record<string, unknown>;
let saved: {
  revision: number;
  archive_hash: string;
  object_id: string;
  created_at: Date;
} | null;
const provider = {
  create: vi.fn(),
  find: vi.fn(),
  inspect: vi.fn(),
  destroy: vi.fn(),
  renew: vi.fn(),
  exportWorkspace: vi.fn(),
  importWorkspace: vi.fn(),
  initializeWorkspace: vi.fn(),
};
const store = {
  get: vi.fn(),
  reserve: vi.fn(),
  reconciliationCandidates: vi.fn(),
  transition: vi.fn(),
  exclusive: vi.fn(),
  listCommands: vi.fn(),
  listTerminals: vi.fn(),
  checkpoint: vi.fn(),
  saveCheckpoint: vi.fn(),
  readCheckpoint: vi.fn(),
  assertCheckpointReadable: vi.fn(),
  restoreState: vi.fn(),
};
const service = () =>
  Reflect.construct(SandboxService, ['owner-a', config, store, provider]) as SandboxService;
beforeEach(() => {
  vi.resetAllMocks();
  row = {
    id,
    owner_id: 'owner-a',
    workspace_id: 'project',
    profile: 'code',
    connection_fingerprint: config.fingerprint,
    resource_id: 'cloud-id',
    state: 'running',
    workspace_ready: true,
    restore_hash: null,
    preview_epoch: 0,
    created_at: new Date(),
    updated_at: new Date(),
  };
  saved = null;
  store.reconciliationCandidates.mockImplementation(async () => [{ ...row }]);
  store.get.mockImplementation(async (owner, key) => {
    if (owner !== 'owner-a' || key !== id) throw new Error('not found');
    return { ...row };
  });
  store.reserve.mockImplementation(async () => ({ row: { ...row }, created: true }));
  store.transition.mockImplementation(async (_row, from, state, resource = row.resource_id) => {
    if (from.includes(row.state)) {
      row.state = state;
      row.resource_id = resource;
    }
    return { ...row };
  });
  store.exclusive.mockImplementation(async (_id, fn) => fn());
  store.listCommands.mockResolvedValue([]);
  store.listTerminals.mockResolvedValue([]);
  store.checkpoint.mockImplementation(async () => saved);
  store.restoreState.mockImplementation(async (_row, hash, ready) => {
    row.restore_hash = hash;
    row.workspace_ready = ready;
  });
  store.saveCheckpoint.mockImplementation(async (_row, revision, source) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of source) chunks.push(chunk);
    const data = Buffer.concat(chunks),
      hash = archiveHash(data);
    saved = {
      revision: revision + 1,
      archive_hash: hash,
      object_id: 'object',
      created_at: new Date(),
    };
    return { revision: revision + 1 };
  });
  provider.exportWorkspace.mockImplementation(async function* () {
    yield bytes;
  });
  provider.importWorkspace.mockResolvedValue(undefined);
  provider.initializeWorkspace.mockResolvedValue(undefined);
  store.readCheckpoint.mockImplementation(async function* () {
    yield bytes;
  });
  provider.destroy.mockResolvedValue(undefined);
  provider.renew.mockResolvedValue(undefined);
});
describe('sandbox recovery semantics', () => {
  it.each([60_000, 300_000])(
    'protects checkpoint work with a sufficient lease when configured for %s ms',
    async (lifetimeMs) => {
      const target = Reflect.construct(SandboxService, [
        'owner-a',
        { ...config, lifetimeMs },
        store,
        provider,
      ]) as SandboxService;
      provider.exportWorkspace.mockImplementation(async function* () {
        expect(provider.renew).toHaveBeenCalledWith(
          'cloud-id',
          id,
          Math.max(lifetimeMs, 180_000),
          expect.any(AbortSignal),
        );
        yield bytes;
      });
      await expect(target.saveWorkspace(id, 0)).resolves.toMatchObject({
        checkpoint: { revision: 1 },
      });
    },
  );

  it('never exports, commits or releases when checkpoint lease protection fails', async () => {
    provider.renew.mockRejectedValue(new Error('renewal unavailable'));
    await expect(service().saveWorkspace(id, 0, true)).rejects.toThrow('renewal unavailable');
    expect(provider.exportWorkspace).not.toHaveBeenCalled();
    expect(store.saveCheckpoint).not.toHaveBeenCalled();
    expect(provider.destroy).not.toHaveBeenCalled();
    expect(saved).toBeNull();
  });

  it('does not renew or export after an already-expired checkpoint deadline', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('checkpoint deadline', 'TimeoutError'));
    await expect(service().saveWorkspace(id, 0, false, controller.signal)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(provider.renew).not.toHaveBeenCalled();
    expect(provider.exportWorkspace).not.toHaveBeenCalled();
  });

  it('stops waiting for a stalled lease renewal at the shared checkpoint deadline', async () => {
    provider.renew.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const failed = expect(
      service().saveWorkspace(id, 0, true, controller.signal),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.waitFor(() => expect(provider.renew).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('checkpoint deadline', 'TimeoutError'));
    await failed;
    expect(provider.exportWorkspace).not.toHaveBeenCalled();
    expect(store.saveCheckpoint).not.toHaveBeenCalled();
    expect(provider.destroy).not.toHaveBeenCalled();
  });

  it('releases confirmed expired environments without deleting their checkpoint', async () => {
    saved = {
      revision: 1,
      archive_hash: archiveHash(bytes),
      object_id: 'object',
      created_at: new Date(),
    };
    provider.inspect.mockResolvedValue(null);
    expect((await service().reconcile(id)).state).toBe('destroyed');
    expect(saved.revision).toBe(1);
    expect(provider.destroy).not.toHaveBeenCalled();
  });
  it('recovers capacity on a bounded retry after provider-confirmed expiry', async () => {
    store.reserve.mockRejectedValueOnce(new SandboxError('SANDBOX_LIMIT', 429, 'full'));
    store.reserve.mockImplementationOnce(async () => {
      expect(row.state).toBe('destroyed');
      return { row: { ...row }, created: false };
    });
    provider.inspect.mockResolvedValue(null);
    await service().create(id, 'project');
    expect(store.reconciliationCandidates).toHaveBeenCalledWith(config.fingerprint);
    expect(store.reserve).toHaveBeenCalledTimes(2);
    expect(provider.destroy).not.toHaveBeenCalled();
  });
  it.each(['live', 'timeout', 'locked'])(
    'does not free capacity when a candidate is %s',
    async (kind) => {
      store.reserve.mockRejectedValue(new SandboxError('SANDBOX_LIMIT', 429, 'full'));
      if (kind === 'timeout') provider.inspect.mockRejectedValue(new Error('timeout'));
      else provider.inspect.mockResolvedValue({ id: 'cloud-id', state: 'running' });
      if (kind === 'locked') store.exclusive.mockRejectedValue(new Error('busy'));
      await expect(service().create(id, 'project')).rejects.toMatchObject({
        code: 'SANDBOX_LIMIT',
      });
      expect(row.state).toBe('running');
      expect(provider.destroy).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
      expect(store.reserve).toHaveBeenCalledTimes(2);
    },
  );
  it('does not release an uncertain create or a changed binding during capacity reconciliation', async () => {
    store.reserve.mockRejectedValue(new SandboxError('SANDBOX_LIMIT', 429, 'full'));
    row.resource_id = null;
    row.state = 'unknown';
    await expect(service().create(id, 'project')).rejects.toMatchObject({ code: 'SANDBOX_LIMIT' });
    expect(row.state).toBe('unknown');
    row.resource_id = 'cloud-id';
    row.connection_fingerprint = 'different';
    await expect(service().create(id, 'project')).rejects.toMatchObject({ code: 'SANDBOX_LIMIT' });
    expect(provider.inspect).not.toHaveBeenCalled();
  });
  it('retains a bound environment when its expiry cannot be confirmed', async () => {
    provider.inspect.mockRejectedValue(new Error('network'));
    await expect(service().reconcile(id)).rejects.toThrow('network');
    expect(row.state).toBe('running');
  });
  it('retains unknown allocation instead of retrying create', async () => {
    row.state = 'creating';
    row.resource_id = null;
    provider.create.mockRejectedValue(new Error('timeout'));
    expect((await service().create(id, 'project')).state).toBe('unknown');
    store.reserve.mockResolvedValue({ row: { ...row }, created: false });
    await service().create(id, 'project');
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
  it('does not infer failed creation from an empty provider list', async () => {
    row.state = 'creating';
    row.resource_id = null;
    provider.find.mockResolvedValue([]);
    expect((await service().reconcile(id)).state).toBe('unknown');
    expect(provider.create).not.toHaveBeenCalled();
  });
  it('rejects ambiguous discovery', async () => {
    row.state = 'unknown';
    row.resource_id = null;
    provider.find.mockResolvedValue([
      { id: 'one', state: 'running' },
      { id: 'two', state: 'running' },
    ]);
    await expect(service().reconcile(id)).rejects.toThrow('Multiple resources');
  });
  it('never releases after export or checkpoint persistence failure', async () => {
    provider.exportWorkspace.mockImplementation(async function* () {
      throw new Error('export failed');
    });
    await expect(service().saveWorkspace(id, 0, true)).rejects.toThrow();
    expect(provider.destroy).not.toHaveBeenCalled();
    provider.exportWorkspace.mockImplementation(async function* () {
      yield bytes;
    });
    store.saveCheckpoint.mockRejectedValue(new Error('PG failed'));
    await expect(service().saveWorkspace(id, 0, true)).rejects.toThrow();
    expect(provider.destroy).not.toHaveBeenCalled();
  });
  it('commits the checkpoint before deletion and retains it on deletion uncertainty', async () => {
    provider.destroy.mockImplementation(async () => {
      expect(saved?.archive_hash).toBe(archiveHash(bytes));
      throw new Error('delete timeout');
    });
    await expect(service().saveWorkspace(id, 0, true)).rejects.toThrow();
    expect(saved).not.toBeNull();
    expect(row.state).toBe('destroying');
  });
  it('blocks access after incomplete restore and permits retry', async () => {
    saved = {
      revision: 1,
      archive_hash: archiveHash(bytes),
      object_id: 'object',
      created_at: new Date(),
    };
    row.workspace_ready = false;
    provider.importWorkspace.mockRejectedValueOnce(new Error('interrupted'));
    await expect(service().restoreWorkspace(id)).rejects.toThrow();
    expect(row.workspace_ready).toBe(false);
    await expect(service().readText(id, 'x')).rejects.toThrow('not running');
    await service().restoreWorkspace(id);
    expect(row.workspace_ready).toBe(true);
  });
  it('rejects corrupted checkpoint and restored output', async () => {
    saved = { revision: 1, archive_hash: 'wrong', object_id: 'object', created_at: new Date() };
    await expect(service().restoreWorkspace(id)).rejects.toThrow('checksum');
    row.restore_hash = null;
    saved.archive_hash = archiveHash(bytes);
    provider.exportWorkspace.mockImplementation(async function* () {
      yield Buffer.from('{}');
    });
    await expect(service().restoreWorkspace(id)).rejects.toThrow('checksum');
    expect(row.workspace_ready).toBe(false);
  });
  it('refuses a changed provider binding', async () => {
    row.connection_fingerprint = 'other';
    await expect(service().get(id)).rejects.toThrow('different provider');
    expect(provider.inspect).not.toHaveBeenCalled();
  });
  it('returns a destroyed creation operation after provider reconfiguration', async () => {
    row.state = 'destroyed';
    row.connection_fingerprint = 'previous-configuration';
    store.reserve.mockResolvedValue({ row: { ...row }, created: false });
    await expect(service().create(id, 'project')).resolves.toMatchObject({
      id,
      state: 'destroyed',
    });
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.inspect).not.toHaveBeenCalled();
    expect(provider.initializeWorkspace).not.toHaveBeenCalled();
  });
  it.each(['running', 'creating', 'unknown', 'destroying'])(
    'still rejects a cached %s operation from another configuration',
    async (state) => {
      row.state = state;
      row.connection_fingerprint = 'previous-configuration';
      store.reserve.mockResolvedValue({ row: { ...row }, created: false });
      await expect(service().create(id, 'project')).rejects.toThrow('different provider');
      expect(provider.create).not.toHaveBeenCalled();
    },
  );
});

it('checks saved-project storage before reserving capacity or allocating compute', async () => {
  saved = {
    revision: 1,
    archive_hash: archiveHash(bytes),
    object_id: 'object',
    created_at: new Date(),
  };
  store.assertCheckpointReadable.mockRejectedValue(new Error('storage unavailable'));
  await expect(service().create(id, 'project')).rejects.toThrow('storage unavailable');
  expect(store.reserve).not.toHaveBeenCalled();
  expect(provider.create).not.toHaveBeenCalled();
});
it('keeps a failed initialization bound, unavailable, and retryable without another allocation', async () => {
  row.state = 'creating';
  row.resource_id = null;
  row.workspace_ready = false;
  provider.create.mockResolvedValue({ id: 'cloud-id', state: 'running' });
  provider.initializeWorkspace.mockRejectedValueOnce(new Error('mkdir failed'));
  await expect(service().create(id, 'project')).rejects.toThrow('mkdir failed');
  expect(row).toMatchObject({ state: 'running', resource_id: 'cloud-id', workspace_ready: false });
  await expect(service().readText(id, 'x')).rejects.toThrow('not running');
  provider.inspect.mockResolvedValue({ id: 'cloud-id', state: 'running' });
  expect((await service().reconcile(id)).workspaceReady).toBe(true);
  expect(provider.initializeWorkspace).toHaveBeenCalledTimes(2);
  expect(provider.create).toHaveBeenCalledTimes(1);
});
it('initializes a discovered allocation before exposing it as ready', async () => {
  row.state = 'unknown';
  row.resource_id = null;
  row.workspace_ready = false;
  provider.find.mockResolvedValue([{ id: 'cloud-id', state: 'running' }]);
  provider.initializeWorkspace.mockRejectedValueOnce(new Error('mkdir failed'));
  await expect(service().reconcile(id)).rejects.toThrow('mkdir failed');
  expect(row.workspace_ready).toBe(false);
  await service().destroy(id);
  expect(row.state).toBe('destroyed');
});
it('can delete an unknown allocation without initializing or restoring it', async () => {
  row.state = 'unknown';
  row.resource_id = null;
  row.workspace_ready = false;
  provider.find.mockResolvedValue([{ id: 'cloud-id', state: 'running' }]);
  await service().destroy(id);
  expect(row.state).toBe('destroyed');
  expect(provider.initializeWorkspace).not.toHaveBeenCalled();
});
