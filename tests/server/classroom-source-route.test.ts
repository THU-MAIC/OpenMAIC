import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ after: vi.fn(), createJob: vi.fn(), runJob: vi.fn() }));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: mocks.after,
}));
vi.mock('@/lib/server/classroom-job-store', () => ({
  createClassroomGenerationJob: mocks.createJob,
}));
vi.mock('@/lib/server/classroom-job-runner', () => ({ runClassroomGenerationJob: mocks.runJob }));
vi.mock('@/lib/server/classroom-storage', () => ({ buildRequestOrigin: () => 'http://localhost' }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
const source = {
  title: '画布裁剪',
  content: '完整题面\n.>_<.\n',
  code: 'cin >> row;  \r\n',
  correctedCode: 'cout << row;\r\n',
  language: 'cpp',
  analysis: { summary: 'hypothesis' },
  referenceValidation: {
    status: 'stored-passed',
    scope: 'original_validation_run_current_suite_not_revalidated_for_classroom',
    codeHash: 'historical',
  },
};
describe('native async classroom source transport', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.createJob.mockResolvedValue({ status: 'pending', step: 'queued', message: 'queued' });
  });
  async function post(body: Record<string, unknown>) {
    const { POST } = await import('@/app/api/generate-classroom/route');
    return POST({ json: async () => body } as Parameters<typeof POST>[0]);
  }
  it('keeps complete source and explicit flag in the same job payload/background call', async () => {
    const body = {
      requirement: 'complete requirement  \r\n',
      codeContextRequired: true,
      codemateSource: source,
    };
    expect((await post(body)).status).toBe(202);
    expect(mocks.createJob.mock.calls[0][1]).toEqual(body);
    expect(mocks.createJob.mock.calls[0][1].codemateSource).toBe(source);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.runJob.mock.calls[0][1]).toBe(mocks.createJob.mock.calls[0][1]);
  });
  it('rejects required missing/incomplete source before scheduling any paid work', async () => {
    expect((await post({ requirement: 'request', codeContextRequired: true })).status).toBe(400);
    expect(
      (
        await post({
          requirement: 'request',
          codeContextRequired: true,
          codemateSource: { ...source, content: '' },
        })
      ).status,
    ).toBe(400);
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.runJob).not.toHaveBeenCalled();
  });
  it('preserves ordinary non-code classroom compatibility', async () => {
    expect((await post({ requirement: 'Teach photosynthesis' })).status).toBe(202);
    expect(mocks.createJob.mock.calls[0][1]).toEqual({ requirement: 'Teach photosynthesis' });
  });
});
