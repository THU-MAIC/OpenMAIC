import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('server-only', () => ({}));
const mock = vi.hoisted(() => ({
  row: {} as any,
  receipts: new Map<string, any>(),
  project: {} as any,
  busy: false,
  epoch: 0,
  state: 'running',
  starts: [] as string[],
  exclusive: vi.fn(),
  activity: vi.fn(),
  stop: vi.fn(),
  scope: vi.fn(),
  command: vi.fn(),
}));
vi.mock('@/lib/server/pbl-v3/store', () => ({
  LearningStore: {
    open: async () => ({
      get: async (id: string, owner: string) => {
        if (id !== mock.row.id || owner !== mock.row.owner_id) throw Error('not found');
        return mock.row;
      },
      exclusive: mock.exclusive,
      recordActivity: mock.activity,
      pool: {
        query: async (sql: string, args: any[]) => {
          if (sql.startsWith('SELECT id FROM sandbox_commands'))
            return { rows: mock.starts.includes(args[1]) ? [{ id: args[1] }] : [] };
          if (sql.startsWith('INSERT')) {
            mock.receipts.set(args[1], { hash: args[2], result: JSON.parse(args[3]) });
            return { rows: [] };
          }
          if (sql.includes('id LIKE'))
            return {
              rows: [...mock.receipts.values()]
                .filter((r) => r.result.environmentId === args[1])
                .reverse()
                .slice(0, 1),
            };
          return { rows: [mock.receipts.get(args[1])].filter(Boolean) };
        },
      },
    }),
  },
}));
const service = {
  get: async () => ({ state: 'running', workspaceReady: true }),
  workspaceEpoch: async () => mock.epoch,
  stopApplications: mock.stop,
  startApplicationCommand: async (_id: string, body: any) => {
    mock.starts.push(body.requestId);
    return { state: mock.state };
  },
  command: mock.command,
  startCommand: async () => ({
    state: 'exited',
    exitCode: 0,
    stdout: JSON.stringify({ sourceHash: 'new-source', httpStatus: 200 }),
  }),
  preview: async () => ({ url: 'http://isolated.localhost/preview', expiresAt: Date.now() + 1000 }),
};
vi.mock('@/lib/server/sandbox/service', () => ({
  SandboxService: { forOwner: async () => service },
}));
vi.mock('@/lib/server/sandbox/preview', () => ({ previewConfig: () => ({}) }));
vi.mock('@/lib/server/sandbox/managed-workspace', () => ({
  learningWorkspaceId: (id: string) => 'pbl-' + id,
  withLearningWorkspaceAccess: async (scope: unknown, run: () => Promise<unknown>) => {
    mock.scope(scope);
    return run();
  },
}));
vi.mock('@/lib/server/pbl-v3/runtime', () => ({
  busy: async () => mock.busy,
  projectFor: () => mock.project,
  readFiles: async () => ({ 'app.py': 'pass\n' }),
  requireEnvironment: (row: any) => row.environment_id,
  stageKey: () => 'sample:0',
}));
vi.mock('@/lib/server/pbl-v3/environment', () => ({
  assertEnvironmentReady: vi.fn(),
  assertEnvironmentWritable: vi.fn(),
  touchEnvironment: async () => ({ state: 'running', workspaceReady: true }),
  environmentReleaseCommitted: (row: any) => !!row.released,
}));
vi.mock('@/lib/server/pbl-v3/workspace-files', () => ({ projectFiles: async () => ['app.py'] }));
import {
  applicationRequest,
  applicationFingerprint,
  applicationProbeCommand,
  assertLearningPreview,
} from '@/lib/server/pbl-v3/application';

const study = '12345678-1234-4234-8234-123456789012',
  env = '12345678-1234-4234-8234-123456789013';
const request = (action = 'open', id = '12345678-1234-4234-8234-123456789014') => ({
  studyId: study,
  id,
  environmentId: env,
  revision: 0,
  epoch: 0,
  action,
});
const owner = { ownerId: 'owner' } as any;
beforeEach(() => {
  vi.clearAllMocks();
  mock.receipts.clear();
  mock.starts = [];
  mock.epoch = 0;
  mock.busy = false;
  mock.state = 'running';
  mock.row = {
    id: study,
    owner_id: 'owner',
    environment_id: env,
    revision: 0,
    evaluation: null,
    state: { status: 'active' },
  };
  mock.project = {
    application: {
      title: 'Sample',
      description: 'A sample',
      argv: ['python3', 'app.py'],
      port: 8000,
      healthPath: '/health',
    },
  };
  mock.exclusive.mockImplementation(async (_id: string, run: () => Promise<unknown>) => run());
  mock.command.mockImplementation(async () => ({
    state: mock.state,
    stdout: '',
    stderr: '',
    exitCode: null,
  }));
});

describe('declared project applications', () => {
  it('refuses wrong owners, stale bindings, stopped epochs, undeclared apps and busy assessments before dispatch', async () => {
    await expect(applicationRequest({ ownerId: 'other' } as any, request())).rejects.toThrow(
      'not found',
    );
    await expect(
      applicationRequest(owner, { ...request(), environmentId: study }),
    ).rejects.toMatchObject({ reason: 'PROGRESS_CHANGED' });
    mock.epoch = 1;
    await expect(applicationRequest(owner, request())).rejects.toMatchObject({
      reason: 'WORKSPACE_STOPPED',
    });
    mock.epoch = 0;
    mock.busy = true;
    await expect(applicationRequest(owner, request())).rejects.toMatchObject({
      reason: 'STUDY_BUSY',
    });
    mock.busy = false;
    mock.row.evaluation = {};
    await expect(applicationRequest(owner, request())).rejects.toMatchObject({
      reason: 'STUDY_BUSY',
    });
    mock.row.evaluation = null;
    mock.project.application = undefined;
    await expect(applicationRequest(owner, request())).rejects.toThrow('does not declare');
    expect(mock.starts).toEqual([]);
  });
  it('keeps a durable start receipt and reuses the same command after a lost acknowledgement', async () => {
    const first = await applicationRequest(owner, request());
    expect(first).toMatchObject({
      state: 'running',
      sourceChanged: true,
      preview: { url: expect.stringContaining('isolated') },
    });
    await applicationRequest(owner, request());
    expect(mock.starts).toEqual([request().id, request().id]);
    expect(mock.receipts.size).toBe(1);
    expect(mock.scope).toHaveBeenCalledWith(
      expect.objectContaining({
        operations: ['command', 'preview'],
        environmentIds: expect.any(Function),
      }),
    );
    await expect(applicationRequest(owner, { ...request(), action: 'restart' })).rejects.toThrow(
      'reused',
    );
  });
  it('recovers a committed intent that never reserved or dispatched a command', async () => {
    mock.receipts.set('application:old', {
      hash: 'old',
      result: {
        environmentId: env,
        epoch: 0,
        commandId: study,
        sourceHash: 'old',
        startedAt: new Date().toISOString(),
      },
    });
    expect(await applicationRequest(owner, request('status'))).toMatchObject({
      state: 'stopped',
      commandState: 'not-started',
    });
    expect(mock.command).not.toHaveBeenCalled();
    await expect(applicationRequest(owner, request())).resolves.toMatchObject({ state: 'running' });
    expect(mock.starts).toEqual([request().id]);
  });
  it('does not restart for diagnostics, and permits trying the application after project completion', async () => {
    mock.row.state.status = 'completed';
    await applicationRequest(owner, request());
    const count = mock.starts.length;
    const result = await applicationRequest(owner, request('status'));
    expect(result).not.toHaveProperty('preview');
    expect(mock.starts).toHaveLength(count);
    expect(mock.activity).toHaveBeenCalledTimes(1);
  });
  it('does not resurrect an older receipt after a newer explicit restart', async () => {
    await applicationRequest(owner, request());
    await applicationRequest(owner, request('restart', study));
    await applicationRequest(owner, request());
    expect(mock.starts).toEqual([request().id, study]);
  });
  it('authorizes gateway access only for the current owner, binding and declared port', async () => {
    await expect(
      assertLearningPreview('owner', 'pbl-' + study, env, 8000),
    ).resolves.toBeUndefined();
    await expect(assertLearningPreview('owner', 'pbl-' + study, env, 9000)).rejects.toThrow(
      'revoked',
    );
    await expect(assertLearningPreview('owner', 'pbl-' + study, study, 8000)).rejects.toThrow(
      'revoked',
    );
    mock.row.released = true;
    await expect(assertLearningPreview('owner', 'pbl-' + study, env, 8000)).rejects.toThrow(
      'revoked',
    );
  });
  it('uses a bounded loopback-only GET and compares the exact saved-source fingerprint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pbl-app-probe-'));
    try {
      const files = { 'app.py': 'print("hello")\n', 'notes.txt': 'Hello 世界\n' };
      for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
      const command = applicationProbeCommand(Object.keys(files).sort(), 65534, '/health');
      const output = JSON.parse(
        execFileSync('/bin/sh', ['-c', command], { cwd: dir, encoding: 'utf8', timeout: 5000 }),
      );
      expect(output.sourceHash).toBe(applicationFingerprint(files));
      expect(output.httpStatus).toBeUndefined();
      expect(command).toContain('NoRedirect');
      expect(command).not.toContain('POST');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
