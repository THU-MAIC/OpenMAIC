import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PBLProjectPackage, PBLV3Reference } from '@openmaic/dsl';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/identity/with-owner', () => ({
  withRequestOwner: async (
    _request: Request,
    handle: (principal: { ownerId: string }, headers: Headers) => Promise<Response>,
  ) => handle({ ownerId: 'export-owner' }, new Headers()),
}));
const resolver = vi.hoisted(() => ({ exportProjectPackage: vi.fn() }));
vi.mock('@/lib/server/pbl-v3/project-resolver', () => ({
  exportProjectPackage: resolver.exportProjectPackage,
  installProjectPackage: vi.fn(),
  bindPackageReferences: vi.fn(),
}));

import { POST } from '@/app/api/pbl/v3/packages/route';
import { attachClassroomProjects } from '@/lib/pbl/v3/package-client';
import { PROJECT_LIMITS } from '@/lib/pbl/v3/package-policy';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import {
  indexProjectFiles,
  packageBuiltin,
  validateProjectPackage,
} from '@/lib/server/pbl-v3/project-package';

const template = packageBuiltin(installedProject({ id: 'greeting-python', version: '1.0.0' }));
function project(id: string, fileCount = 0, largeFiles = 0): PBLProjectPackage {
  const files = { ...template.files };
  const descriptor = JSON.parse(files['project.json']);
  descriptor.id = descriptor.definition.id = id;
  files['project.json'] = JSON.stringify(descriptor);
  for (let i = 0; i < largeFiles; i++)
    files[`docs/large-${i}.md`] = 'x'.repeat(PROJECT_LIMITS.fileBytes);
  for (let i = 0; Object.keys(files).length < fileCount; i++) files[`docs/file-${i}.md`] = '';
  const bundle = indexProjectFiles(id, template.entry.version, files);
  // Every project is valid in isolation; only the classroom aggregate can exceed its budget.
  validateProjectPackage(bundle);
  return bundle;
}
function reference(bundle: PBLProjectPackage): PBLV3Reference {
  return { id: bundle.entry.id, version: bundle.entry.version };
}
function manifest(refs: PBLV3Reference[]): ClassroomManifest {
  return {
    formatVersion: 1,
    exportedAt: '',
    appVersion: '',
    stage: { name: 'Export limits', createdAt: 0, updatedAt: 0 },
    agents: [],
    mediaIndex: {},
    scenes: refs.map((ref, order) => ({
      type: 'pbl',
      title: 'Project',
      order,
      content: { type: 'pbl', projectV3: ref },
    })),
  };
}
function exportRequest(refs: PBLV3Reference[]) {
  return POST(
    new Request('http://localhost/api/pbl/v3/packages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmaic-sandbox': '1' },
      body: JSON.stringify({ action: 'export', stageId: 'classroom', refs }),
    }),
  );
}
afterEach(() => {
  resolver.exportProjectPackage.mockReset();
  vi.restoreAllMocks();
});

describe('classroom export resource limits', () => {
  it.each(['files', 'bytes', 'projects'] as const)(
    'rejects aggregate %s at the production route and before client export mutations',
    async (limit) => {
      const projects =
        limit === 'projects'
          ? Array.from({ length: PROJECT_LIMITS.projects + 1 }, (_, i) => project(`course-${i}`))
          : [
              project('course-a', limit === 'files' ? 257 : 0, limit === 'bytes' ? 9 : 0),
              project('course-b', limit === 'files' ? 257 : 0, limit === 'bytes' ? 9 : 0),
            ];
      const refs = projects.map(reference);
      const byId = new Map(projects.map((bundle) => [bundle.entry.id, bundle]));
      resolver.exportProjectPackage.mockImplementation(
        async (_ownerId: string, _stageId: string, ref: PBLV3Reference) => byId.get(ref.id),
      );
      const response = await exportRequest(refs);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'SANDBOX_INVALID_REQUEST',
          message: 'Classroom project resource limit exceeded.',
        },
      });
      expect(resolver.exportProjectPackage).toHaveBeenCalledWith(
        'export-owner',
        'classroom',
        refs[0],
      );

      // A stale server must not let the browser create an archive its importer refuses.
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ projects }));
      const classroom = manifest(refs),
        before = structuredClone(classroom),
        existing = new Blob(['existing media']),
        files = new Map([['media/existing.txt', existing]]);
      await expect(attachClassroomProjects('classroom', classroom, files)).rejects.toThrow(
        'resource limit',
      );
      expect(classroom).toEqual(before);
      expect([...files]).toEqual([['media/existing.txt', existing]]);
    },
  );

  it('counts shared content once across built-in, installed and repeated scene references', async () => {
    const bundle = project('shared-course', 257, 9);
    const builtin = reference(bundle),
      installed = {
        ...builtin,
        assetId: 'installed-course',
        checksum: bundle.entry.checksum,
      };
    resolver.exportProjectPackage.mockResolvedValue(bundle);
    const response = await exportRequest([builtin, installed]);
    expect(response.status).toBe(200);
    expect((await response.json()).projects).toHaveLength(2);

    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      expect(body.refs).toEqual([builtin, installed]);
      return Response.json({ projects: [bundle, bundle] });
    });
    const classroom = manifest([builtin, installed, builtin]),
      files = new Map<string, Blob>();
    await attachClassroomProjects('classroom', classroom, files);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(classroom.pblProjects).toEqual([bundle.entry]);
    expect(files.size).toBe(257);
    for (const scene of classroom.scenes)
      expect(scene.content).toEqual({
        type: 'pbl',
        projectV3: { ...builtin, packageId: bundle.entry.checksum },
      });
  });

  it('allows more than sixteen repeated references while keeping the existing scene bound', async () => {
    resolver.exportProjectPackage.mockResolvedValue(template);
    const ref = reference(template);
    expect((await exportRequest(Array(PROJECT_LIMITS.projects + 1).fill(ref))).status).toBe(200);
    expect((await exportRequest(Array(PROJECT_LIMITS.scenes + 1).fill(ref))).status).toBe(400);
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const classroom = manifest(Array(PROJECT_LIMITS.scenes + 1).fill(ref)),
      before = structuredClone(classroom);
    await expect(attachClassroomProjects('classroom', classroom, new Map())).rejects.toThrow(
      'project scenes',
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(classroom).toEqual(before);
  });
});
