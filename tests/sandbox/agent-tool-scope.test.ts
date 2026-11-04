import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { buildSandboxTools } from '@/lib/server/sandbox/agent-tools';
import type { SandboxService } from '@/lib/server/sandbox/service';
const id = '12345678-1234-1234-1234-123456789012';
const service = { get: vi.fn(), startCommand: vi.fn(), listFiles: vi.fn() };
const tool = () =>
  buildSandboxTools({
    sessionId: 'session-a',
    environmentId: id,
    allowCommands: true,
    resolveService: async () => service as unknown as SandboxService,
  }).find((x) => x.name === 'sandbox_run')!;
beforeEach(() => {
  vi.resetAllMocks();
  service.get.mockResolvedValue({});
  service.startCommand.mockResolvedValue({ stdout: '', stderr: '', state: 'running' });
});
describe('agent command scope', () => {
  it('normalizes project-relative cwd and uses a stable operation ID', async () => {
    await tool().execute('call-a', { command: 'pwd', cwd: 'src' } as never);
    expect(service.startCommand).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ cwd: '/home/user/project/src' }),
    );
    const first = service.startCommand.mock.calls[0][1].requestId;
    await tool().execute('call-a', { command: 'pwd', cwd: 'src' } as never);
    expect(service.startCommand.mock.calls[1][1].requestId).toBe(first);
  });
  it('refuses traversal before command dispatch', async () => {
    expect(
      await tool().execute('call-a', { command: 'pwd', cwd: '../other' } as never),
    ).toMatchObject({ isError: true });
    expect(service.startCommand).not.toHaveBeenCalled();
  });
});

const listTool = () =>
  buildSandboxTools({
    sessionId: 's',
    environmentId: id,
    resolveService: async () => service as unknown as SandboxService,
  }).find((t) => t.name === 'sandbox_list_files')!;
function output(result: Awaited<ReturnType<ReturnType<typeof listTool>['execute']>>) {
  const text = (result.content[0] as { text: string }).text;
  expect(text.length).toBeLessThanOrEqual(16000);
  return JSON.parse(text.split('\n')[2]);
}
it('paginates 4096 files with a strict escaped-character budget and no omissions', async () => {
  const files = Array.from({ length: 4096 }, (_, i) => ({
    path: String(i).padStart(4, '0') + 'a'.repeat(200),
    bytes: 1,
  }));
  service.listFiles.mockResolvedValue(files);
  let cursor = 0;
  const seen: string[] = [];
  do {
    const value = output(await listTool().execute('list', { cursor, limit: 100 } as never));
    seen.push(...value.files.map((f: { path: string }) => f.path));
    expect(value.truncated).toBe(value.nextCursor !== null);
    cursor = value.nextCursor;
  } while (cursor !== null);
  expect(seen).toEqual(files.map((f) => f.path));
});
it('counts JSON escaping and enforces the requested entry count', async () => {
  service.listFiles.mockResolvedValue(
    Array.from({ length: 20 }, (_, i) => ({ path: String(i) + '\u0001'.repeat(2040), bytes: 1 })),
  );
  const value = output(await listTool().execute('list', { limit: 10 } as never));
  expect(value.files).toHaveLength(1);
  expect(value.nextCursor).toBe(1);
});
it.each([{ limit: 101 }, { limit: 0 }, { cursor: -1 }, { cursor: 0.5 }])(
  'refuses invalid listing input %j',
  async (params) => {
    expect(await listTool().execute('list', params as never)).toMatchObject({ isError: true });
    expect(service.listFiles).not.toHaveBeenCalled();
  },
);
