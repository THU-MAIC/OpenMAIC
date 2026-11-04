import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { SandboxService } from '@/lib/server/sandbox/service';
import { SandboxError } from '@/lib/sandbox/errors';
import type { TerminalRow } from '@/lib/server/sandbox/store';

const id = '12345678-1234-1234-1234-123456789012';
const terminalId = '22345678-1234-1234-1234-123456789012';
const replacementId = '32345678-1234-1234-1234-123456789012';
const env = {
  id,
  owner_id: 'owner-a',
  workspace_id: 'project',
  profile: 'code',
  connection_fingerprint: 'connection',
  resource_id: 'resource',
  state: 'running',
  workspace_ready: true,
  created_at: new Date(),
  updated_at: new Date(),
};
let terminal: TerminalRow;
let locked = false;
const provider = {
  renew: vi.fn(),
  createTerminal: vi.fn(),
  findTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  exportWorkspace: vi.fn(),
};
const store = {
  get: vi.fn(),
  exclusive: vi.fn(),
  reserveTerminal: vi.fn(),
  terminal: vi.fn(),
  setTerminal: vi.fn(),
  listCommands: vi.fn(),
  listTerminals: vi.fn(),
  saveCheckpoint: vi.fn(),
};
const service = () =>
  Reflect.construct(SandboxService, [
    'owner-a',
    { fingerprint: 'connection', lifetimeMs: 300_000 },
    store,
    provider,
  ]) as SandboxService;

beforeEach(() => {
  vi.resetAllMocks();
  provider.renew.mockResolvedValue(undefined);
  locked = false;
  terminal = { id: terminalId, state: 'creating', pid: null };
  store.get.mockResolvedValue(env);
  store.exclusive.mockImplementation(async (_id, action) => {
    if (locked) throw new SandboxError('SANDBOX_BUSY', 429, 'busy');
    locked = true;
    try {
      return await action();
    } finally {
      locked = false;
    }
  });
  store.reserveTerminal.mockImplementation(async (_env, requestId) => {
    expect(locked).toBe(true);
    if (requestId !== terminal.id) {
      if (terminal.state !== 'closed') throw new Error('active terminal');
      terminal = { id: requestId, state: 'creating', pid: null };
    }
    return { row: { ...terminal }, created: true };
  });
  store.terminal.mockImplementation(async () => ({ ...terminal }));
  store.setTerminal.mockImplementation(async (_env, _id, state, pid) => {
    if (terminal.state !== 'closed') terminal = { ...terminal, state, pid: pid ?? terminal.pid };
    return { ...terminal };
  });
  store.listCommands.mockResolvedValue([]);
  store.listTerminals.mockImplementation(async () => [{ ...terminal }]);
  store.saveCheckpoint.mockResolvedValue({ revision: 1 });
  provider.createTerminal.mockRejectedValue(new Error('allocation failed'));
  provider.findTerminal.mockResolvedValue(null);
});

it('explicitly closes a no-match reservation, permitting checkpointing and a new terminal', async () => {
  const svc = service();
  expect(await svc.createTerminal(id, { requestId: terminalId })).toMatchObject({
    state: 'unknown',
  });
  expect(await svc.terminal(id, terminalId)).toMatchObject({ state: 'unknown' });
  await expect(svc.saveWorkspace(id, 0)).rejects.toThrow('Close terminals');
  expect(await svc.closeTerminal(id, terminalId)).toEqual({ id: terminalId, state: 'closed' });
  expect(provider.closeTerminal).not.toHaveBeenCalled();
  await expect(svc.saveWorkspace(id, 0)).resolves.toMatchObject({ checkpoint: { revision: 1 } });
  provider.createTerminal.mockResolvedValue(42);
  await expect(svc.createTerminal(id, { requestId: replacementId })).resolves.toMatchObject({
    state: 'running',
  });
});

it.each(['lookup failed', 'ambiguous allocation'])(
  'retains an unresolved reservation on %s',
  async (message) => {
    terminal.state = 'unknown';
    provider.findTerminal.mockRejectedValue(new Error(message));
    await expect(service().closeTerminal(id, terminalId)).rejects.toThrow(message);
    expect(terminal).toMatchObject({ state: 'unknown', pid: null });
    expect(store.setTerminal).not.toHaveBeenCalled();
  },
);

it('recovers and kills an allocated PTY whose create acknowledgement was lost', async () => {
  terminal.state = 'unknown';
  provider.findTerminal.mockResolvedValue(42);
  provider.closeTerminal.mockImplementation(async () => {
    expect(locked).toBe(true);
  });
  await expect(service().closeTerminal(id, terminalId)).resolves.toMatchObject({ state: 'closed' });
  expect(provider.closeTerminal).toHaveBeenCalledWith('resource', id, 42, terminalId);
});

it('retains a discovered PTY when process cleanup fails', async () => {
  terminal.state = 'unknown';
  provider.findTerminal.mockResolvedValue(42);
  provider.closeTerminal.mockRejectedValue(new Error('cleanup failed'));
  await expect(service().closeTerminal(id, terminalId)).rejects.toThrow('cleanup failed');
  expect(terminal).toMatchObject({ state: 'running', pid: 42 });
  await expect(service().saveWorkspace(id, 0)).rejects.toThrow('Close terminals');
});

it('does not retire a reservation while creation holds the environment lock', async () => {
  let finish!: (pid: number) => void;
  provider.createTerminal.mockImplementation(
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
  );
  const creating = service().createTerminal(id, { requestId: terminalId });
  await vi.waitFor(() => expect(provider.createTerminal).toHaveBeenCalledOnce());
  await expect(service().closeTerminal(id, terminalId)).rejects.toMatchObject({
    code: 'SANDBOX_BUSY',
  });
  expect(provider.findTerminal).not.toHaveBeenCalled();
  finish(42);
  await creating;
  expect(terminal).toMatchObject({ state: 'running', pid: 42 });
});

it('closing an already closed terminal is idempotent and does not query the provider', async () => {
  terminal.state = 'closed';
  await expect(service().closeTerminal(id, terminalId)).resolves.toMatchObject({ state: 'closed' });
  expect(provider.findTerminal).not.toHaveBeenCalled();
  expect(provider.closeTerminal).not.toHaveBeenCalled();
});
