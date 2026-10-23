import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  scene: vi.fn(),
  resolve: vi.fn(),
  sandbox: vi.fn(),
}));
vi.mock('@/lib/server/sandbox/http', () => ({
  sandboxPrincipalResponse: (_r: Request, fn: (p: unknown) => unknown) =>
    fn({ ownerId: 'owner-a' }),
}));
vi.mock('@/lib/server/sandbox/service', () => ({ SandboxService: { forOwner: mocks.sandbox } }));
vi.mock('@/lib/server/pbl-v3/store', () => ({
  LearningStore: { open: async () => ({ findForScene: mocks.find }) },
}));
vi.mock('@/lib/server/pbl-v3/project-resolver', () => ({ resolveProject: mocks.resolve }));
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: async () => ({ getScene: mocks.scene }),
}));
vi.mock('@/lib/server/pbl-v3/runtime', () => ({
  projectFor: (row: { project: unknown }) => row.project,
}));
import { GET } from '@/app/api/pbl/v3/route';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
const project = installedProject({ id: 'greeting-python-lab', version: '1.1.0' });
const request = () =>
  new Request('http://localhost/api/pbl/v3?project=1&stageId=course&sceneId=scene');
beforeEach(() => {
  vi.clearAllMocks();
  mocks.find.mockResolvedValue(null);
  mocks.scene.mockResolvedValue({ content: { type: 'pbl', projectV3: project.ref } });
  mocks.resolve.mockResolvedValue(project);
});
it('reads authorized project metadata without creating a study or touching a sandbox', async () => {
  const response = await GET(request());
  expect(await response.json()).toMatchObject({
    hero: { title: project.definition.title, milestoneCount: 2 },
    started: false,
  });
  expect(mocks.find).toHaveBeenCalledWith('owner-a', 'course', 'scene');
  expect(mocks.scene).toHaveBeenCalledWith('course', 'scene');
  expect(mocks.resolve).toHaveBeenCalledWith('owner-a', 'course', project.ref, undefined, 'scene');
  expect(mocks.sandbox).not.toHaveBeenCalled();
});
it('uses the retained study project after scene edits and never renews its environment', async () => {
  mocks.find.mockResolvedValue({ project });
  expect(await (await GET(request())).json()).toMatchObject({ started: true });
  expect(mocks.scene).not.toHaveBeenCalled();
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.sandbox).not.toHaveBeenCalled();
});
it('rejects a missing or inaccessible project instead of showing a fake entrance', async () => {
  mocks.scene.mockResolvedValue(null);
  await expect(GET(request())).rejects.toMatchObject({ code: 'PBL_NOT_FOUND' });
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.sandbox).not.toHaveBeenCalled();
});
