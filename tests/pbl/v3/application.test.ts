import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstalledProject } from '@/lib/server/pbl-v3/catalog';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
interface StudyFixture {
  id: string;
  owner_id: string;
  environment_id: string;
  revision: number;
  evaluation: Record<string, never> | null;
  state: { status: string };
  released?: boolean;
}
interface RunFixture {
  environmentId: string;
  epoch: number;
  commandId: string;
  sourceHash: string;
  startedAt: string;
  launchSequence?: number;
}
interface ReceiptFixture {
  hash: string;
  result: RunFixture;
}

vi.mock('server-only', () => ({}));
const mock = vi.hoisted(() => ({
  row: {} as StudyFixture,
  receipts: new Map<string, ReceiptFixture>(),
  project: {} as Pick<InstalledProject, 'application'>,
  busy: false,
  epoch: 0,
  state: 'running',
  starts: [] as string[],
  exclusive: vi.fn(),
  activity: vi.fn(),
  writer: vi.fn(),
  stop: vi.fn(),
  scope: vi.fn(),
  command: vi.fn(),
  paths: ['app.py'],
  files: { 'app.py': 'pass\n' } as Record<string, string>,
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
      markWorkspaceWriter: mock.writer,
      pool: {
        query: async (sql: string, args: string[]) => {
          if (sql.startsWith('SELECT id FROM sandbox_commands'))
            return { rows: mock.starts.includes(args[1]) ? [{ id: args[1] }] : [] };
          if (sql.startsWith('INSERT')) {
            const result = JSON.parse(args[3]);
            if (sql.includes('launchSequence'))
              result.launchSequence =
                Math.max(
                  0,
                  ...[...mock.receipts.values()].map((r) => r.result.launchSequence ?? 0),
                ) + 1;
            mock.receipts.set(args[1], { hash: args[2], result });
            return { rows: [] };
          }
          if (sql.includes('id LIKE'))
            return {
              rows: [...mock.receipts.values()]
                .filter((r) => r.result.environmentId === args[1])
                .sort(
                  (a, b) =>
                    (sql.includes('launchSequence')
                      ? (b.result.launchSequence ?? 0) - (a.result.launchSequence ?? 0)
                      : 0) || b.result.startedAt.localeCompare(a.result.startedAt),
                )
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
  startApplicationCommand: async (_id: string, body: { requestId: string }) => {
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
  readFiles: async () => mock.files,
  requireEnvironment: (row: StudyFixture) => row.environment_id,
  stageKey: () => 'sample:0',
}));
vi.mock('@/lib/server/pbl-v3/environment', () => ({
  assertEnvironmentReady: vi.fn(),
  assertEnvironmentWritable: vi.fn(),
  touchEnvironment: async () => ({ state: 'running', workspaceReady: true }),
  environmentReleaseCommitted: (row: StudyFixture) => !!row.released,
}));
vi.mock('@/lib/server/pbl-v3/workspace-files', () => ({ projectFiles: async () => mock.paths }));
import {
  applicationRequest,
  applicationFingerprint,
  applicationProbeCommand,
  assertLearningPreview,
  recordLearningPreviewActivity,
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
const owner: OwnerPrincipal = {
  ownerId: 'owner',
  kind: 'user',
  assurance: 'verified',
  roles: new Set(['sandbox:use']),
};
beforeEach(() => {
  vi.clearAllMocks();
  mock.receipts.clear();
  mock.starts = [];
  mock.epoch = 0;
  mock.busy = false;
  mock.state = 'running';
  mock.paths = ['app.py'];
  mock.files = { 'app.py': 'pass\n' };
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
  it('checks shutdown-created source paths before recording or dispatching a new writer', async () => {
    mock.stop.mockImplementationOnce(async () => {
      mock.files = Object.fromEntries(
        Array.from({ length: 256 }, (_, i) => [`src/${'x'.repeat(230)}${i}.py`, 'pass\n']),
      );
    });
    await expect(applicationRequest(owner, request('restart'))).rejects.toThrow('32 KiB');
    expect(mock.starts).toEqual([]);
    expect(mock.receipts.size).toBe(0);
    expect(mock.writer).not.toHaveBeenCalled();
  });
  it.each(['open', 'restart'])(
    'checks the current source-path budget before %s dispatch',
    async (action) => {
      mock.paths = Array.from({ length: 256 }, (_, i) => `src/${'x'.repeat(230)}${i}.py`);
      await expect(applicationRequest(owner, request(action))).rejects.toThrow('32 KiB');
      expect(mock.starts).toEqual([]);
      expect(mock.receipts.size).toBe(0);
      expect(mock.writer).not.toHaveBeenCalled();
      expect(mock.stop).not.toHaveBeenCalled();
      expect(mock.activity).not.toHaveBeenCalled();
      mock.paths = ['app.py'];
      await expect(applicationRequest(owner, request(action))).resolves.toMatchObject({
        state: 'running',
        preview: expect.any(Object),
      });
    },
  );
  it('leaves an existing application intact on an oversized restart and still permits stopping it', async () => {
    await applicationRequest(owner, request());
    vi.clearAllMocks();
    mock.paths = Array.from({ length: 256 }, (_, i) => `src/${'x'.repeat(230)}${i}.py`);
    await expect(applicationRequest(owner, request('restart', study))).rejects.toThrow('32 KiB');
    expect(mock.starts).toEqual([request().id]);
    expect(mock.receipts.size).toBe(1);
    expect(mock.writer).not.toHaveBeenCalled();
    expect(mock.stop).not.toHaveBeenCalled();
    await expect(applicationRequest(owner, request('stop', study))).resolves.toMatchObject({
      state: 'stopped',
    });
    expect(mock.stop).toHaveBeenCalledTimes(1);
  });
  it('refuses wrong owners, stale bindings, stopped epochs, undeclared apps and busy assessments before dispatch', async () => {
    await expect(applicationRequest({ ...owner, ownerId: 'other' }, request())).rejects.toThrow(
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
    expect(mock.writer).toHaveBeenCalledTimes(2);
    expect(mock.writer.mock.invocationCallOrder[0]).toBeLessThan(
      mock.activity.mock.invocationCallOrder[0],
    );
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
  it.each([0, -60_000])(
    'keeps the newest launch when the application clock changes by %s ms',
    async (clockChange) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const time = Date.parse('2026-10-29T00:00:00Z');
        vi.setSystemTime(time);
        await applicationRequest(owner, request());
        mock.command.mockImplementation(async (_env, id) => ({
          state: id === request().id ? 'cancelled' : 'running',
          stdout: '',
          stderr: '',
          exitCode: id === request().id ? -15 : null,
        }));
        vi.setSystemTime(time + clockChange);
        await expect(applicationRequest(owner, request('restart', study))).resolves.toMatchObject({
          state: 'running',
          preview: expect.any(Object),
        });
        await applicationRequest(owner, request('status'));
        // An old retry must observe the new run without dispatching the old one.
        await applicationRequest(owner, request());
        await applicationRequest(owner, request('open', env));
        expect(mock.command).toHaveBeenLastCalledWith(env, study, undefined);
        expect(mock.starts).toEqual([request().id, study]);
        expect([...mock.receipts.values()].map((r) => r.result.launchSequence)).toEqual([1, 2]);
      } finally {
        vi.useRealTimers();
      }
    },
  );
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
  it('records preview input only after checking the current binding; passive authorization is not activity', async () => {
    await assertLearningPreview('owner', 'pbl-' + study, env, 8000);
    expect(mock.activity).not.toHaveBeenCalled();
    await recordLearningPreviewActivity('owner', 'pbl-' + study, env, 8000);
    expect(mock.activity).toHaveBeenCalledWith(study, 'owner');
    mock.row.released = true;
    await expect(recordLearningPreviewActivity('owner', 'pbl-' + study, env, 8000)).rejects.toThrow(
      'revoked',
    );
    expect(mock.activity).toHaveBeenCalledTimes(1);
  });
  it('uses a bounded loopback-only GET and compares the exact saved-source fingerprint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pbl-app-probe-'));
    try {
      const files = { 'app.py': 'print("hello")\n', 'notes.txt': 'Hello 世界\n' };
      for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
      // Neither cwd nor PYTHONPATH can turn an observation into workspace code execution.
      for (const moduleName of ['json', 'hashlib', 'pathlib', 'base64', 'urllib'])
        writeFileSync(
          join(dir, moduleName + '.py'),
          "open('imported-untrusted-module', 'w').write('bad')\nraise RuntimeError('shadowed')\n",
        );
      const command = applicationProbeCommand(Object.keys(files).sort(), 65534, '/health');
      const output = JSON.parse(
        execFileSync('/bin/sh', ['-c', command], {
          cwd: dir,
          encoding: 'utf8',
          timeout: 5000,
          env: { ...process.env, PYTHONPATH: dir },
        }),
      );
      expect(output.sourceHash).toBe(applicationFingerprint(files));
      expect(output.httpStatus).toBeUndefined();
      expect(existsSync(join(dir, 'imported-untrusted-module'))).toBe(false);
      expect(existsSync(join(dir, '__pycache__'))).toBe(false);
      expect(command).toContain('NoRedirect');
      expect(command).not.toContain('POST');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
