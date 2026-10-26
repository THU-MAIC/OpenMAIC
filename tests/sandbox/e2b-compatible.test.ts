import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
vi.mock('server-only', () => ({}));
const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  getInfo: vi.fn(),
  connect: vi.fn(),
  kill: vi.fn(),
  setTimeout: vi.fn(),
}));
vi.mock('e2b', () => ({
  Sandbox: sdk,
  CommandExitError: class extends Error {},
  FileNotFoundError: class extends Error {},
  SandboxNotFoundError: class extends Error {},
}));
import { sandboxConfig } from '@/lib/server/sandbox/config';
import { E2BCompatibleSandboxProvider } from '@/lib/server/sandbox/providers/e2b-compatible';
import { WORKSPACE_EXCLUDES } from '@/lib/server/sandbox/workspace-archive';
import { isProjectSource, projectFiles } from '@/lib/server/pbl-v3/workspace-files';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import type { SandboxService } from '@/lib/server/sandbox/service';

function archiveFixture() {
  sdk.getInfo.mockResolvedValue({
    sandboxId: 'resource',
    state: 'running',
    endAt: new Date(Date.now() + 300000),
    network: { allowPublicTraffic: false },
    metadata: { openmaic_connection: 'test-installation', openmaic_operation: 'op' },
  });
  const run = vi.fn(
    async (
      _command: string,
      _options?: { signal?: AbortSignal; timeoutMs?: number; requestTimeoutMs?: number },
    ) => ({ stdout: '' }),
  );
  const read = vi.fn(
    async (
      _path: string,
      _options?: { signal?: AbortSignal; format?: string; requestTimeoutMs?: number },
    ) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
  );
  const remove = vi.fn(
    async (_path: string, _options?: { signal?: AbortSignal; requestTimeoutMs?: number }) =>
      undefined,
  );
  const sandbox = { commands: { run }, files: { read, remove } };
  sdk.connect.mockResolvedValue(sandbox);
  return {
    provider: new E2BCompatibleSandboxProvider(sandboxConfig()),
    sandbox,
    run,
    read,
    remove,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(process.env))
    if (key.startsWith('OPENMAIC_SANDBOX_') || key.startsWith('E2B_')) vi.stubEnv(key, undefined);
  vi.stubEnv('OPENMAIC_SANDBOX_PROVIDER', 'e2b-compatible');
  vi.stubEnv('OPENMAIC_SANDBOX_CONNECTION_ID', 'test-installation');
  vi.stubEnv('OPENMAIC_SANDBOX_TEMPLATE', 'code-template');
  vi.stubEnv('OPENMAIC_SANDBOX_API_KEY', 'test-key');
});
afterEach(() => vi.unstubAllEnvs());

it('keeps actual provider enumeration and PBL source access aligned on excluded directories', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-list-')));
  try {
    const accepted = ['src/App.java', 'src/next/page.ts', 'src/venv_helpers.py'];
    const excluded = WORKSPACE_EXCLUDES.map((name) => `src/nested/${name}/hidden.py`);
    for (const path of [...accepted, ...excluded, 'src/build/generated.py']) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), 'source');
    }
    sdk.getInfo.mockResolvedValue({
      sandboxId: 'resource',
      state: 'running',
      endAt: new Date(Date.now() + 300000),
      network: { allowPublicTraffic: false },
      metadata: { openmaic_connection: 'test-installation', openmaic_operation: 'op' },
    });
    sdk.connect.mockResolvedValue({
      commands: {
        run: async (command: string) => {
          // Execute the real generated listing script locally, substituting only its workspace root.
          const script = execFileSync(
            'python3',
            ['-c', 'import shlex,sys; print(shlex.split(sys.argv[1])[2])', command],
            { encoding: 'utf8' },
          ).replace("root='/home/user/project'", `root=${JSON.stringify(root)}`);
          return { stdout: execFileSync('python3', ['-c', script], { encoding: 'utf8' }) };
        },
      },
    });
    const provider = new E2BCompatibleSandboxProvider(sandboxConfig());
    const entries = await provider.listWorkspace('resource', 'op');
    const paths = entries.map((entry) => entry.path);
    const project = {
      ...installedProject({ id: 'greeting-python', version: '1.0.0' }),
      sourceRoots: ['src'],
    };
    for (const path of excluded) {
      expect(paths).not.toContain(path);
      expect(isProjectSource(project, path)).toBe(false);
    }
    expect(paths).toContain('src/build/generated.py'); // PBL may be stricter than generic workspaces.
    const files = await projectFiles(
      { listFiles: async () => entries } as unknown as SandboxService,
      'environment',
      project,
    );
    expect(files).toEqual([...accepted].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('E2B-compatible connection configuration', () => {
  it('defaults to the official endpoint without inheriting SDK globals', () => {
    vi.stubEnv('E2B_API_URL', 'https://unrelated.invalid');
    vi.stubEnv('E2B_DOMAIN', 'unrelated.invalid');
    expect(sandboxConfig()).toMatchObject({ apiUrl: 'https://api.e2b.dev', domain: 'e2b.app' });
  });
  it('requires an explicit API URL for another data-plane domain', () => {
    vi.stubEnv('OPENMAIC_SANDBOX_DOMAIN', 'sandboxes.example.org');
    expect(() => sandboxConfig()).toThrow();
    vi.stubEnv('OPENMAIC_SANDBOX_API_URL', 'https://control.example.org/');
    expect(sandboxConfig().apiUrl).toBe('https://control.example.org');
  });
  it.each([
    'http://api.example.org',
    'https://user:password@api.example.org',
    'https://api.example.org/path',
    'https://api.example.org?token=x',
    'https://api.example.org#fragment',
  ])('refuses ambiguous or insecure API URL %s', (url) => {
    vi.stubEnv('OPENMAIC_SANDBOX_API_URL', url);
    expect(() => sandboxConfig()).toThrow();
  });
  it.each(['host/path', 'https://example.org', 'host:443', 'bad..domain', '-bad.example'])(
    'refuses invalid sandbox domain %s',
    (domain) => {
      vi.stubEnv('OPENMAIC_SANDBOX_DOMAIN', domain);
      vi.stubEnv('OPENMAIC_SANDBOX_API_URL', 'https://api.example.org');
      expect(() => sandboxConfig()).toThrow();
    },
  );
  it('binds API URL into identity but permits same-account key rotation', () => {
    const first = sandboxConfig().fingerprint;
    vi.stubEnv('OPENMAIC_SANDBOX_API_KEY', 'rotated-test-key');
    expect(sandboxConfig().fingerprint).toBe(first);
    vi.stubEnv('OPENMAIC_SANDBOX_API_URL', 'https://other.example.org');
    expect(sandboxConfig().fingerprint).not.toBe(first);
  });
  it.each(['E2B_ACCESS_TOKEN', 'E2B_SANDBOX_URL'])('rejects data-plane override %s', (key) => {
    vi.stubEnv(key, 'unexpected');
    expect(() => sandboxConfig()).toThrow();
  });
  it('does not activate an unconfigured installation', () => {
    vi.stubEnv('OPENMAIC_SANDBOX_PROVIDER', undefined);
    expect(() => sandboxConfig()).toThrow(expect.objectContaining({ code: 'SANDBOX_DISABLED' }));
  });
  it('pins the protocol baseline instead of silently upgrading to v2 create', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.dependencies.e2b).toBe('2.31.0');
    expect(pkg.dependencies['@e2b/desktop']).toBe('2.3.1');
  });
});

it.each([
  ['https://api.e2b.dev', 'e2b.app'],
  ['https://control.example.org', 'sandboxes.example.org'],
])('uses the same adapter for %s', async (apiUrl, domain) => {
  vi.stubEnv('OPENMAIC_SANDBOX_API_URL', apiUrl);
  vi.stubEnv('OPENMAIC_SANDBOX_DOMAIN', domain);
  const config = sandboxConfig();
  const provider = new E2BCompatibleSandboxProvider(config);
  sdk.create.mockResolvedValue({
    sandboxId: 'test-resource',
    files: { makeDir: vi.fn().mockResolvedValue(undefined) },
  });
  await expect(provider.create('operation-1', 'code')).resolves.toEqual({
    id: 'test-resource',
    state: 'running',
  });
  expect(sdk.create).toHaveBeenCalledWith(
    'code-template',
    expect.objectContaining({
      apiUrl,
      domain,
      apiKey: 'test-key',
      secure: true,
      network: { allowPublicTraffic: false },
      timeoutMs: 300_000,
      metadata: { openmaic_connection: 'test-installation', openmaic_operation: 'operation-1' },
    }),
  );
  sdk.getInfo.mockResolvedValue({
    sandboxId: 'test-resource',
    state: 'running',
    metadata: { openmaic_connection: 'test-installation', openmaic_operation: 'another-operation' },
  });
  await expect(provider.destroy('test-resource', 'operation-1')).rejects.toThrow();
  expect(sdk.kill).not.toHaveBeenCalled();
  expect(provider.capabilities).toEqual({ pause: false, desktopStream: false });
});

it('initializes the workspace idempotently through the owned private connection', async () => {
  const provider = new E2BCompatibleSandboxProvider(sandboxConfig());
  const mkdir = vi.fn().mockResolvedValue(true);
  sdk.getInfo.mockResolvedValue({
    sandboxId: 'resource',
    state: 'running',
    endAt: new Date(Date.now() + 300000),
    network: { allowPublicTraffic: false },
    metadata: { openmaic_connection: 'test-installation', openmaic_operation: 'op' },
  });
  sdk.connect.mockResolvedValue({ files: { makeDir: mkdir } });
  await provider.initializeWorkspace('resource', 'op');
  await provider.initializeWorkspace('resource', 'op');
  expect(mkdir).toHaveBeenNthCalledWith(1, '/home/user/project');
  expect(mkdir).toHaveBeenNthCalledWith(2, '/home/user/project');
});

describe('checkpoint generation deadline', () => {
  it('does not connect or generate an archive after a pre-expired checkpoint deadline', async () => {
    const { provider, run } = archiveFixture();
    const controller = new AbortController();
    controller.abort(new DOMException('checkpoint deadline', 'TimeoutError'));
    await expect(
      provider.exportWorkspace('resource', 'op', controller.signal)[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(sdk.getInfo).not.toHaveBeenCalled();
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('shares the remaining cancellation signal between generation and archive download', async () => {
    const { provider, run, read, remove } = archiveFixture();
    const controller = new AbortController();
    const chunks = [];
    for await (const chunk of provider.exportWorkspace('resource', 'op', controller.signal))
      chunks.push(chunk);
    expect(chunks).toEqual([new Uint8Array([1, 2, 3])]);
    expect(run.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(read.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('stops waiting for generation at the shared deadline even if the SDK and cleanup stall', async () => {
    const { provider, run, read, remove } = archiveFixture();
    let finish!: () => void;
    run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ stdout: '' });
        }),
    );
    remove.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const next = provider
      .exportWorkspace('resource', 'op', controller.signal)
      [Symbol.asyncIterator]()
      .next();
    const failed = expect(next).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('checkpoint deadline', 'TimeoutError'));
    await failed;
    expect(run.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(read).not.toHaveBeenCalled();
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(read).not.toHaveBeenCalled();
  });

  it('does not start generation if connection completes after cancellation', async () => {
    const { provider, run, sandbox } = archiveFixture();
    let connected!: () => void;
    sdk.connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          connected = () => resolve(sandbox);
        }),
    );
    const controller = new AbortController();
    const next = provider
      .exportWorkspace('resource', 'op', controller.signal)
      [Symbol.asyncIterator]()
      .next();
    const failed = expect(next).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.waitFor(() => expect(sdk.connect).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('checkpoint deadline', 'TimeoutError'));
    await failed;
    connected();
    await new Promise((resolve) => setImmediate(resolve));
    expect(run).not.toHaveBeenCalled();
  });
});

describe('checkpoint source-read deadline', () => {
  it('starts no source I/O after a pre-expired checkpoint deadline', async () => {
    const { provider, run, read } = archiveFixture();
    const controller = new AbortController();
    controller.abort(new DOMException('checkpoint deadline', 'TimeoutError'));
    await expect(
      provider.readText('resource', 'op', 'PLAN.md', controller.signal),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(sdk.getInfo).not.toHaveBeenCalled();
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    'ownership',
    'copy-connection',
    'command',
    'download-connection',
    'download',
    'stream',
    'cleanup',
  ])('stops waiting for stalled %s I/O at the shared deadline', async (stage) => {
    const { provider, sandbox, run, read, remove } = archiveFixture();
    const blocked = vi.fn(() => new Promise<never>(() => {}));
    if (stage === 'ownership') sdk.getInfo.mockImplementationOnce(blocked);
    if (stage === 'copy-connection') sdk.connect.mockImplementationOnce(blocked);
    if (stage === 'command') run.mockImplementationOnce(blocked);
    if (stage === 'download-connection')
      sdk.connect.mockResolvedValueOnce(sandbox).mockImplementationOnce(blocked);
    if (stage === 'download') read.mockImplementationOnce(blocked);
    if (stage === 'stream')
      read.mockResolvedValueOnce(new ReadableStream({ pull: blocked, cancel: blocked }));
    if (stage === 'cleanup') remove.mockImplementationOnce(blocked);
    const controller = new AbortController();
    const failed = expect(
      provider.readText('resource', 'op', 'PLAN.md', controller.signal),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.waitFor(() => expect(blocked).toHaveBeenCalled());
    controller.abort(new DOMException('checkpoint deadline', 'TimeoutError'));
    await failed;
  });

  it('propagates caller cancellation through both source connections and the download', async () => {
    const { provider, run, read } = archiveFixture();
    const controller = new AbortController();
    expect(await provider.readText('resource', 'op', 'PLAN.md', controller.signal)).toBe(
      '\x01\x02\x03',
    );
    expect(sdk.getInfo).toHaveBeenCalledTimes(2);
    expect(sdk.connect).toHaveBeenCalledTimes(2);
    for (const call of [...sdk.getInfo.mock.calls, ...sdk.connect.mock.calls])
      expect(call[1]?.signal).toBe(controller.signal);
    expect(run.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    const downloadSignal = read.mock.calls[0]?.[1]?.signal;
    controller.abort();
    expect(downloadSignal?.aborted).toBe(true);
  });

  it('preserves the local stream timeout when the caller signal stays live', async () => {
    const { provider, read } = archiveFixture();
    read.mockImplementationOnce(() => new Promise(() => {}));
    const caller = new AbortController(),
      local = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => (ms === 30_000 ? local.signal : timeout(ms)));
    try {
      const failed = expect(
        provider.readText('resource', 'op', 'PLAN.md', caller.signal),
      ).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      local.abort(new DOMException('local stream deadline', 'TimeoutError'));
      await failed;
      expect(caller.signal.aborted).toBe(false);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('cannot start a download when a source copy command completes after cancellation', async () => {
    const { provider, run, read } = archiveFixture();
    let finish!: () => void;
    run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ stdout: '' });
        }),
    );
    const controller = new AbortController();
    const failed = expect(
      provider.readText('resource', 'op', 'PLAN.md', controller.signal),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('checkpoint deadline', 'TimeoutError'));
    await failed;
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(read).not.toHaveBeenCalled();
    expect(sdk.connect).toHaveBeenCalledTimes(1);
  });

  it.each(['pre-expired', 'stalled'])(
    'bounds %s source enumeration with the shared deadline',
    async (mode) => {
      const { provider, run } = archiveFixture();
      const controller = new AbortController();
      if (mode === 'pre-expired')
        controller.abort(new DOMException('checkpoint deadline', 'TimeoutError'));
      else run.mockImplementationOnce(() => new Promise(() => {}));
      const failed = expect(
        provider.listWorkspace('resource', 'op', controller.signal),
      ).rejects.toMatchObject({ name: 'TimeoutError' });
      if (mode === 'stalled') {
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
        expect(run.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
        controller.abort(new DOMException('checkpoint deadline', 'TimeoutError'));
      }
      await failed;
      if (mode === 'pre-expired') expect(sdk.getInfo).not.toHaveBeenCalled();
    },
  );
});

describe('checkpoint lease protection', () => {
  it.each([60_000, 300_000])(
    'preserves a longer remaining lease when renewing for %s ms',
    async (requested) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      const { provider } = archiveFixture();
      const controller = new AbortController();
      sdk.getInfo.mockResolvedValue({
        sandboxId: 'resource',
        state: 'running',
        endAt: new Date(Date.now() + 180_000),
        metadata: { openmaic_connection: 'test-installation', openmaic_operation: 'op' },
      });
      try {
        await provider.renew('resource', 'op', requested, controller.signal);
        expect(sdk.setTimeout).toHaveBeenCalledExactlyOnceWith(
          'resource',
          Math.max(requested, 180_000),
          expect.objectContaining({ signal: controller.signal }),
        );
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('starts no renewal after a pre-expired checkpoint deadline', async () => {
    const { provider } = archiveFixture();
    const controller = new AbortController();
    controller.abort(new DOMException('checkpoint deadline', 'TimeoutError'));
    await expect(
      provider.renew('resource', 'op', 180_000, controller.signal),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(sdk.getInfo).not.toHaveBeenCalled();
    expect(sdk.setTimeout).not.toHaveBeenCalled();
  });

  it('does not renew after a canceled ownership lookup completes late', async () => {
    const { provider } = archiveFixture();
    let finish!: () => void;
    sdk.getInfo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              sandboxId: 'resource',
              state: 'running',
              endAt: new Date(Date.now() + 180_000),
              metadata: { openmaic_connection: 'test-installation', openmaic_operation: 'op' },
            });
        }),
    );
    const controller = new AbortController();
    const failed = expect(
      provider.renew('resource', 'op', 180_000, controller.signal),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    controller.abort(new DOMException('checkpoint deadline', 'TimeoutError'));
    await failed;
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sdk.setTimeout).not.toHaveBeenCalled();
  });
});
