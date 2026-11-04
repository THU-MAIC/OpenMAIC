import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerPrincipal } from '@/lib/server/identity';
import { SandboxError } from '@/lib/sandbox/errors';
vi.mock('server-only', () => ({}));
const state = vi.hoisted(() => ({
  principal: {} as unknown,
  config: vi.fn(),
  sandboxEnabled: vi.fn(),
  createDocument: vi.fn(),
  loadDocument: vi.fn(),
  beforeAssetAllocate: vi.fn(),
  install: vi.fn(),
  exportPackage: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('@/lib/server/identity/with-owner', () => ({
  withRequestOwner: async (
    _: Request,
    handle: (principal: unknown, headers: Headers) => Promise<Response>,
  ) => handle(state.principal, new Headers()),
}));
vi.mock('@/lib/server/sandbox/settings', () => ({
  resolvedSandboxConfig: state.config,
  sandboxWorkspaceEnabled: state.sandboxEnabled,
}));
vi.mock('@/lib/server/sandbox/store', () => ({ SandboxStore: { open: vi.fn(async () => ({})) } }));
vi.mock('@/lib/server/sandbox/providers/e2b-compatible', () => ({
  E2BCompatibleSandboxProvider: class {},
}));
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: async () => ({
    createDocument: state.createDocument,
    loadDocument: state.loadDocument,
  }),
}));
vi.mock('@/lib/server/persistence-hooks/registry', () => ({
  getPersistenceHooks: () => ({ name: 'test', beforeAssetAllocate: state.beforeAssetAllocate }),
}));
vi.mock('@/lib/server/pbl-v3/project-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/pbl-v3/project-resolver')>()),
  installProjectPackage: state.install,
  exportProjectPackage: state.exportPackage,
}));
vi.mock('next/navigation', () => ({ notFound: state.notFound }));
vi.mock('@/app/pbl-v3/pbl-examples', () => ({ default: () => null }));

import { POST as sampleRoute } from '@/app/api/pbl/v3/route';
import { POST as packagesRoute } from '@/app/api/pbl/v3/packages/route';
import PBLExamplesPage from '@/app/pbl-v3/page';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { packageBuiltin } from '@/lib/server/pbl-v3/project-package';

const authorized: OwnerPrincipal = {
  ownerId: 'owner',
  kind: 'user',
  assurance: 'verified',
  roles: new Set(['sandbox:use']),
};
const anonymous: OwnerPrincipal = {
  ownerId: 'anonymous-owner',
  kind: 'anonymous',
  assurance: 'unverified-legacy',
  roles: new Set(),
};
const unauthorized: OwnerPrincipal = { ...authorized, roles: new Set() };
const disabled = new SandboxError('SANDBOX_DISABLED', 503, 'Sandbox provider is not configured.');
const classroomId = 'pbl-00000000-0000-4000-8000-000000000000';

function post(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-openmaic-sandbox': '1',
      origin: 'http://localhost',
    },
    body: JSON.stringify(body),
  });
}
const openSample = () => sampleRoute(post('/api/pbl/v3', { action: 'sample', id: classroomId }));

const bundle = packageBuiltin(installedProject({ id: 'greeting-python', version: '1.0.0' }));
const packagedRef = {
  id: bundle.entry.id,
  version: bundle.entry.version,
  packageId: bundle.entry.checksum,
};
const installRequest = () =>
  packagesRoute(
    post('/api/pbl/v3/packages', {
      action: 'install',
      projects: [bundle],
      scenes: [{ content: { type: 'pbl', projectV3: packagedRef } }],
    }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('OWNER_SINGLE_USER', 'false');
  vi.stubEnv('OWNER_SINGLE_USER_ID', '');
  state.notFound.mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND');
  });
  state.config.mockResolvedValue({});
  state.loadDocument.mockResolvedValue(null);
  state.install.mockImplementation(async () => ({
    id: bundle.entry.id,
    version: bundle.entry.version,
    assetId: 'asset',
    checksum: bundle.entry.checksum,
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe('creating a sample classroom', () => {
  it.each([
    ['anonymous', anonymous],
    ['unauthorized', unauthorized],
  ])('refuses an %s principal before reading sandbox settings', async (_, principal) => {
    state.principal = principal;
    const response = await openSample();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: 'SANDBOX_FORBIDDEN',
        message: 'This identity is not allowed to use sandboxes.',
      },
    });
    expect(state.config).not.toHaveBeenCalled();
    expect(state.createDocument).not.toHaveBeenCalled();
  });

  it('refuses an authorized principal while the sandbox is off', async () => {
    state.principal = authorized;
    state.config.mockRejectedValue(disabled);
    const response = await openSample();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'SANDBOX_DISABLED', message: 'Sandbox provider is not configured.' },
    });
    expect(state.createDocument).not.toHaveBeenCalled();
  });

  it('creates the classroom for an authorized principal', async () => {
    state.principal = authorized;
    const response = await openSample();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ classroomId });
    expect(state.createDocument).toHaveBeenCalledTimes(1);
  });
});

describe('the sample page', () => {
  it('is not found while the sandbox is off', async () => {
    state.sandboxEnabled.mockResolvedValue(false);
    await expect(PBLExamplesPage()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('renders while the sandbox is on', async () => {
    state.sandboxEnabled.mockResolvedValue(true);
    await expect(PBLExamplesPage()).resolves.toBeTruthy();
    expect(state.notFound).not.toHaveBeenCalled();
  });
});

describe('project packages stay available to classroom import and export', () => {
  it.each([
    ['sandbox off', authorized, true],
    ['anonymous', anonymous, false],
    ['unauthorized', unauthorized, false],
    ['authorized', authorized, false],
  ])('installs for a principal that is %s', async (_, principal, off) => {
    state.principal = principal;
    if (off) state.config.mockRejectedValue(disabled);
    const response = await installRequest();
    expect(response.status).toBe(200);
    expect(state.install).toHaveBeenCalledWith(principal.ownerId, expect.anything());
  });

  it('applies the upload admission hook before storing anything', async () => {
    state.principal = anonymous;
    state.beforeAssetAllocate.mockResolvedValue(
      Response.json({ error: { code: 'UPLOADS_CLOSED' } }, { status: 403 }),
    );
    const response = await installRequest();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: 'UPLOADS_CLOSED' } });
    expect(state.beforeAssetAllocate).toHaveBeenCalledWith(
      anonymous,
      expect.objectContaining({ operation: 'create', method: 'POST' }),
    );
    expect(state.install).not.toHaveBeenCalled();
  });

  it('does not store a package that fails validation, nor consult admission for it', async () => {
    state.principal = anonymous;
    const response = await packagesRoute(
      post('/api/pbl/v3/packages', {
        action: 'install',
        projects: [{ ...bundle, files: { ...bundle.files, 'project.json': '{}' } }],
        scenes: [{ content: { type: 'pbl', projectV3: packagedRef } }],
      }),
    );
    expect(response.ok).toBe(false);
    expect(state.beforeAssetAllocate).not.toHaveBeenCalled();
    expect(state.install).not.toHaveBeenCalled();
  });

  it('exports for the requesting owner without admission', async () => {
    state.principal = anonymous;
    state.exportPackage.mockResolvedValue(bundle);
    const ref = { id: bundle.entry.id, version: bundle.entry.version };
    const response = await packagesRoute(
      post('/api/pbl/v3/packages', { action: 'export', stageId: 'course', refs: [ref] }),
    );
    expect(response.status).toBe(200);
    expect(state.exportPackage).toHaveBeenCalledWith('anonymous-owner', 'course', ref);
    expect(state.beforeAssetAllocate).not.toHaveBeenCalled();
  });

  it('keeps the CSRF boundary', async () => {
    state.principal = anonymous;
    const request = post('/api/pbl/v3/packages', { action: 'install' });
    request.headers.delete('x-openmaic-sandbox');
    const response = await packagesRoute(request);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'SANDBOX_CSRF' } });
  });
});
