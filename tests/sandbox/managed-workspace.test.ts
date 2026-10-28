import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { SandboxService } from '@/lib/server/sandbox/service';
import {
  assertWorkspaceMutation,
  learningWorkspaceId,
  withLearningWorkspaceAccess,
} from '@/lib/server/sandbox/managed-workspace';

const id = '12345678-1234-1234-1234-123456789012';
const retired = '12345678-1234-1234-1234-123456789013';
const workspaceId = learningWorkspaceId(id);
const config = { fingerprint: 'config', lifetimeMs: 300000 };
let workspace: string;
let content: string;
const provider = { readText: vi.fn(), writeText: vi.fn(), startCommand: vi.fn() };
const store = {
  get: vi.fn(),
  exclusive: vi.fn(),
  listCommands: vi.fn(),
  listTerminals: vi.fn(),
  command: vi.fn(),
};
const service = () =>
  Reflect.construct(SandboxService, ['owner', config, store, provider]) as SandboxService;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const access = <T>(run: () => Promise<T>) =>
  withLearningWorkspaceAccess(
    {
      ownerId: 'owner',
      workspaceId,
      environmentIds: () => [id],
      operations: ['write'],
    },
    run,
  );
beforeEach(() => {
  vi.resetAllMocks();
  workspace = workspaceId;
  content = 'reviewed';
  store.get.mockImplementation(async (owner, environment) => {
    if (owner !== 'owner' || ![id, retired].includes(environment)) throw new Error('not found');
    return {
      id: environment,
      owner_id: owner,
      workspace_id: workspace,
      connection_fingerprint: 'config',
      state: 'running',
      resource_id: 'resource',
      workspace_ready: true,
    };
  });
  store.exclusive.mockImplementation(async (_id, run) => run());
  store.listCommands.mockResolvedValue([]);
  store.listTerminals.mockResolvedValue([]);
  provider.readText.mockImplementation(async () => content);
  provider.writeText.mockImplementation(async (_resource, _id, _path, text) => {
    content = text;
  });
});

describe('learning workspace service boundary', () => {
  it('quiesces registered applications before source evidence, but never treats cancellation as proof', async () => {
    const s = service();
    store.listCommands.mockResolvedValue([{ id, purpose: 'application' }]);
    const command = vi
      .spyOn(s, 'command')
      .mockResolvedValueOnce({
        id,
        state: 'running',
        stdout: '',
        stderr: '',
        exitCode: null,
        truncated: false,
      })
      .mockResolvedValue({
        id,
        state: 'cancelled',
        stdout: '',
        stderr: '',
        exitCode: -15,
        truncated: false,
      });
    const cancel = vi
      .spyOn(s, 'cancelCommand')
      .mockResolvedValue({ id, cancellationRequested: true });
    await expect(s.assertWorkspaceIdle(id)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledWith(id, id);
    expect(command.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it('does not auto-cancel ordinary commands or authorize an application without both host permissions', async () => {
    const s = service();
    store.listCommands.mockResolvedValue([{ id, purpose: null }]);
    vi.spyOn(s, 'command').mockResolvedValue({
      id,
      state: 'running',
      stdout: '',
      stderr: '',
      exitCode: null,
      truncated: false,
    });
    const cancel = vi.spyOn(s, 'cancelCommand');
    await expect(s.assertWorkspaceIdle(id)).rejects.toMatchObject({
      reason: 'WORKSPACE_COMMAND_ACTIVE',
    });
    expect(cancel).not.toHaveBeenCalled();
    await expect(
      s.startApplicationCommand(id, { requestId: id, command: 'python3 app.py' }, 0),
    ).rejects.toMatchObject({ code: 'PBL_WORKSPACE_MANAGED' });
  });
  it('blocks every generic mutation route, including grants, previews and pre-allocation workspace IDs', async () => {
    const s = service();
    const calls = [
      () => s.create(id, workspaceId),
      () => s.writeText(id, 'PLAN.md', 'bypass'),
      () => s.compareAndWriteText(id, 'PLAN.md', 'bypass', hash(content)),
      () => s.startCommand(id, { requestId: id, command: 'echo bypass > PLAN.md' }),
      () => s.createTerminal(id, { requestId: id }),
      () => s.updateTerminal(id, id, { action: 'input', data: 'echo bypass\n' }),
      () => s.desktopAction(id, { type: 'write', text: 'bypass' }),
      () => s.saveWorkspace(id, 0),
      () => s.restoreWorkspace(id),
      () => s.destroy(id),
      () => s.grantSession(id, 'ordinary-agent', true, true),
      () => s.preview(id, 3000),
      () => s.deleteSavedProject(workspaceId, 1),
    ];
    for (const run of calls)
      await expect(run()).rejects.toMatchObject({ code: 'PBL_WORKSPACE_MANAGED' });
    expect(provider.writeText).not.toHaveBeenCalled();
    expect(provider.startCommand).not.toHaveBeenCalled();
    expect(await s.readText(id, 'PLAN.md')).toBe('reviewed');
  });
  it('scopes permission to the owner, workspace, active environment and operation', async () => {
    await access(async () => {
      await service().writeText(id, 'PLAN.md', 'allowed');
      await expect(
        service().writeText(retired, 'PLAN.md', 'old environment'),
      ).rejects.toMatchObject({ code: 'PBL_WORKSPACE_MANAGED' });
      await expect(service().startCommand(id, {})).rejects.toMatchObject({
        code: 'PBL_WORKSPACE_MANAGED',
      });
      expect(() => assertWorkspaceMutation('other-owner', workspaceId, id, 'write')).toThrow(
        'learning project',
      );
      expect(() =>
        assertWorkspaceMutation('owner', learningWorkspaceId(retired), id, 'write'),
      ).toThrow('learning project');
    });
    await expect(service().writeText(id, 'PLAN.md', 'outside scope')).rejects.toThrow(
      'learning project',
    );
    expect(content).toBe('allowed');
  });
  it('revokes a scope from detached async continuations after its operation returns', async () => {
    let release!: () => void;
    let detached!: Promise<void>;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await access(async () => {
      detached = pending.then(() => service().writeText(id, 'PLAN.md', 'late'));
    });
    release();
    await expect(detached).rejects.toThrow('learning project');
  });
  it('retains ordinary workspace writes without any learning scope', async () => {
    workspace = 'ordinary-project';
    await service().writeText(id, 'main.py', 'ordinary');
    expect(content).toBe('ordinary');
  });
  it('validates the observed hash even for an identical save; no-op saves do not invalidate or write', async () => {
    const invalidate = vi.fn();
    await access(async () => {
      expect(
        await service().compareAndWriteText(id, 'PLAN.md', content, hash(content), invalidate),
      ).toBe(false);
      await expect(
        service().compareAndWriteText(id, 'PLAN.md', content, hash('stale'), invalidate),
      ).rejects.toThrow('changed');
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(provider.writeText).not.toHaveBeenCalled();
  });
  it('invalidates before a write with a lost acknowledgement; rejects before writing if invalidation fails', async () => {
    const events: string[] = [];
    provider.writeText.mockImplementationOnce(async () => {
      events.push('write');
      throw new Error('lost acknowledgement');
    });
    await access(async () => {
      await expect(
        service().compareAndWriteText(id, 'PLAN.md', 'new', hash(content), async () => {
          events.push('invalidate');
        }),
      ).rejects.toThrow('lost acknowledgement');
      await expect(
        service().compareAndWriteText(id, 'PLAN.md', 'new', hash(content), async () => {
          throw new Error('database unavailable');
        }),
      ).rejects.toThrow('database unavailable');
    });
    expect(events).toEqual(['invalidate', 'write']);
    expect(provider.writeText).toHaveBeenCalledTimes(1);
  });
  it.each(['starting', 'running', 'unknown'])(
    'refuses evidence while a legacy command is %s',
    async (state) => {
      store.listCommands.mockResolvedValue([{ id }]);
      store.command.mockResolvedValue({ id, state });
      Object.assign(provider, { readCommand: vi.fn().mockResolvedValue({ id, state }) });
      Object.assign(store, { saveCommand: vi.fn() });
      await expect(service().assertWorkspaceIdle(id)).rejects.toThrow('Stop and collect');
    },
  );
  it.each(['write', 'compare', 'manage', 'command'] as const)(
    'rechecks a revoked scope immediately before %s provider dispatch',
    async (operation) => {
      const row = await store.get('owner', id);
      let release!: () => void;
      let entered = false;
      const pause = async () => {
        entered = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      };
      const mutateFile = vi.fn();
      const reserveCommand = vi.fn(async () => {
        await pause();
        return true;
      });
      const saveCommand = vi.fn();
      Object.assign(provider, {
        mutateFile,
        listWorkspace: vi.fn(async () => [{ path: 'PLAN.md' }]),
      });
      Object.assign(store, { reserveCommand, saveCommand });
      if (operation === 'write') {
        store.get.mockResolvedValueOnce(row).mockImplementationOnce(async () => {
          await pause();
          return row;
        });
      }
      const controller = new AbortController();
      let underlying!: Promise<unknown>;
      const scoped = withLearningWorkspaceAccess(
        {
          ownerId: 'owner',
          workspaceId,
          environmentIds: () => [id],
          operations: ['write', 'command'],
          signal: controller.signal,
        },
        () => {
          const current = service();
          underlying =
            operation === 'write'
              ? current.writeText(id, 'PLAN.md', 'late')
              : operation === 'compare'
                ? current.compareAndWriteText(id, 'PLAN.md', 'late', hash(content), pause)
                : operation === 'manage'
                  ? current.mutateFile(
                      id,
                      { action: 'delete', path: 'PLAN.md', expectedHash: hash(content) },
                      pause,
                    )
                  : current.startCommand(id, { requestId: retired, command: 'echo late' });
          void underlying.catch(() => {});
          return underlying;
        },
      ).catch((error) => error);
      await vi.waitFor(() => expect(entered).toBe(true));
      controller.abort();
      await scoped;
      release();
      await expect(underlying).rejects.toMatchObject({ code: 'PBL_WORKSPACE_MANAGED' });
      expect(provider.writeText).not.toHaveBeenCalled();
      expect(provider.startCommand).not.toHaveBeenCalled();
      expect(mutateFile).not.toHaveBeenCalled();
      if (operation === 'command')
        expect(saveCommand).toHaveBeenCalledWith(
          row,
          expect.objectContaining({ id: retired, state: 'cancelled' }),
        );
    },
  );
});
