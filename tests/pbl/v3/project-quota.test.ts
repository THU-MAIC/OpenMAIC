import { afterEach, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import JSZip from 'jszip';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/identity/with-owner', () => ({
  withRequestOwner: async (
    _request: Request,
    handle: (principal: { ownerId: string }, headers: Headers) => Promise<Response>,
  ) => handle({ ownerId: 'quota-owner' }, new Headers()),
}));

import { POST } from '@/app/api/pbl/v3/packages/route';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { packageBuiltin } from '@/lib/server/pbl-v3/project-package';
import { installClassroomProjects } from '@/lib/pbl/v3/package-client';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('preserves storage-full errors from real allocation through the package route and browser client', async () => {
  vi.stubEnv('ASSET_QUOTA_BYTES', '1');
  vi.stubEnv('ASSET_S3_BUCKET', '');
  vi.stubEnv('DATABASE_URL', 'postgres://project-quota-regression');
  const db = new PGlite();
  await db.waitReady;
  const pool = {
    query: (text: string, params?: unknown[]) => db.query(text, params),
    connect: async () => ({
      query: (text: string, params?: unknown[]) => db.query(text, params),
      release() {},
    }),
    end: async () => {},
  };
  try {
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    const bundle = packageBuiltin(installedProject({ id: 'greeting-python', version: '1.0.0' }));
    const zip = new JSZip();
    for (const [path, text] of Object.entries(bundle.files))
      zip.file(`${bundle.entry.root}/${path}`, text);
    // Use a decoded archive so central-directory size validation follows the real import path.
    const archive = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
    const manifest: ClassroomManifest = {
      formatVersion: 2,
      requiredCapabilities: ['pbl-v3-projects@1'],
      exportedAt: '',
      appVersion: '',
      agents: [],
      mediaIndex: {},
      stage: { name: 'Quota test', createdAt: 1, updatedAt: 1 },
      pblProjects: [bundle.entry],
      scenes: [
        {
          type: 'pbl',
          title: 'Project',
          order: 0,
          content: {
            type: 'pbl',
            projectV3: {
              id: bundle.entry.id,
              version: bundle.entry.version,
              packageId: bundle.entry.checksum,
            },
          },
        },
      ],
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const response = await POST(new Request('http://localhost/api/pbl/v3/packages', init));
      expect(response.status).toBe(507);
      return response;
    });
    await expect(installClassroomProjects(archive, manifest)).rejects.toMatchObject({
      code: 'ASSET_QUOTA_EXCEEDED',
      status: 507,
      message: 'Storage is full. Free storage space before importing this project.',
    });
    expect((await db.query('SELECT 1 FROM asset_entries')).rows).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM pbl_project_installations')).rows).toHaveLength(0);
  } finally {
    await db.close();
  }
}, 30_000);
