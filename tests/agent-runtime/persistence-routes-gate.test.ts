import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { AgentSessionMaterial } from '@openmaic/storage';

import { createFakeDocumentStore } from './_fake-document-store';
import { makeDocument, makeSlideScene } from './_stage-fixtures';

/**
 * Two gates guard the persistence-touching routes, and each route must use the
 * right one:
 *
 *   - `persistence` (`isServerPersistenceConfigured()`, a DATABASE_URL): the
 *     course library and folders (`/api/stages/**`, `/api/folders/**`,
 *     `/api/stage-meta/**`). They need the database and nothing else, so they
 *     serve with the agent runtime on OR off.
 *   - `runtime` (`isAgentRuntimeConfigured()`, the flag AND a DATABASE_URL):
 *     agent features (materials, which only agent sessions consume).
 *
 * Neither may answer a 500 from a store that cannot connect: without a
 * DATABASE_URL both answer a clean 404. This suite drives the REAL
 * feature-flag predicates from the environment (no feature-flags mock) across
 * the four environment states:
 *
 *   - flag off, no DATABASE_URL  -> everything 404 (the browser-storage default)
 *   - flag on,  no DATABASE_URL  -> everything 404 (NOT 500)
 *   - flag off, DATABASE_URL set -> library serves; agent routes 404
 *   - flag on,  DATABASE_URL set -> everything serves
 *
 * The store seams are mocked (same facades as the per-route suites), so the
 * "serves" rows are exercised hermetically. A library route put back behind
 * the runtime gate fails the third row; an agent route moved to the
 * persistence gate fails it too.
 */
const ENV_KEYS = ['OPENMAIC_AGENT_RUNTIME_ENABLED', 'DATABASE_URL'] as const;

const STAGE_ID = 'stage-1';
const SESSION_ID = 'session-1';
const MATERIAL_ID = 'mat_00000000000000000000000000';
const FOLDER_ID = 'folder-1';

const mocks = vi.hoisted(() => ({
  resolveRequestOwnerId: vi.fn(),
  resolveOwnedSession: vi.fn(),
  listSessionMaterials: vi.fn(),
  createSourceMaterial: vi.fn(),
  getSessionMaterial: vi.fn(),
  fakeStore: null as ReturnType<typeof createFakeDocumentStore> | null,
  queryPool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
  assetStore: {
    put: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(
    mocks.resolveRequestOwnerId,
  ),
);
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    documentStore: mocks.fakeStore!.store,
    pool: mocks.queryPool,
    assetStore: mocks.assetStore,
  }),
}));
// The stage routes obtain their store through the owner-scoped seam (which
// needs a live PG pool); the gate test only exercises env-state gating, so
// hand it the same fake store the provider mock serves.
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: async () => mocks.fakeStore!.store,
}));
vi.mock('@/lib/server/agent-runtime/session-materials', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/agent-runtime/session-materials')>();
  return {
    ...actual,
    resolveOwnedSession: mocks.resolveOwnedSession,
    listSessionMaterials: mocks.listSessionMaterials,
    createSourceMaterial: mocks.createSourceMaterial,
    getSessionMaterial: mocks.getSessionMaterial,
  };
});

import { GET as getStages, POST as postStages } from '@/app/api/stages/route';
import {
  DELETE as deleteStage,
  GET as getStage,
  PATCH as patchStage,
  PUT as putStage,
} from '@/app/api/stages/[id]/route';
import { GET as getScenes } from '@/app/api/stages/[id]/scenes/route';
import { GET as getManifest } from '@/app/api/stages/[id]/manifest/route';
import { GET as getFreshness } from '@/app/api/stages/[id]/freshness/route';
import { GET as getMaterials, POST as postMaterials } from '@/app/api/materials/route';
import { GET as getMaterial } from '@/app/api/materials/[id]/route';
import { GET as getFolders, POST as postFolders } from '@/app/api/folders/route';
import { DELETE as deleteFolder, PATCH as patchFolder } from '@/app/api/folders/[id]/route';
import { POST as postFolderMembers } from '@/app/api/folders/members/route';
import { GET as getStageMeta } from '@/app/api/stage-meta/[stageId]/route';
import { GET as getStageStatus } from '@/app/api/stages/[id]/status/route';
import { POST as postGenerationComplete } from '@/app/api/stages/[id]/generation-complete/route';
import { POST as postPublish } from '@/app/api/stages/[id]/publish/route';
import { POST as postUnpublish } from '@/app/api/stages/[id]/unpublish/route';
import { GET as getAgentSessions } from '@/app/api/agent/sessions/route';
import { GET as getAgentSessionsStatus } from '@/app/api/agent/sessions/status/route';
import { GET as getAgentSession } from '@/app/api/agent/sessions/[id]/route';
import { GET as getAgentSkills } from '@/app/api/agent/skills/route';
import { GET as getOwnerEvents } from '@/app/api/agent/owner-events/route';
import { GET as getSkillExport } from '@/app/api/skills/[id]/route';

interface RouteCase {
  name: string;
  /** Which gate the route must sit behind (see the file header). */
  gate: 'persistence' | 'runtime';
  call: () => Promise<Response>;
  /** The status the route must return when the runtime is configured. */
  happyStatus: number;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const stageMetaParams = (stageId: string) => ({ params: Promise.resolve({ stageId }) });

const ROUTES: RouteCase[] = [
  {
    name: 'GET /api/stages',
    gate: 'persistence',
    call: () => getStages(new NextRequest('http://localhost/api/stages')),
    happyStatus: 200,
  },
  {
    name: 'POST /api/stages',
    gate: 'persistence',
    call: () =>
      postStages(
        new NextRequest('http://localhost/api/stages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Day 1' }),
        }),
      ),
    happyStatus: 201,
  },
  {
    name: 'GET /api/stages/[id]',
    gate: 'persistence',
    call: () =>
      getStage(new NextRequest(`http://localhost/api/stages/${STAGE_ID}`), params(STAGE_ID)),
    happyStatus: 200,
  },
  {
    name: 'PATCH /api/stages/[id]',
    gate: 'persistence',
    call: () =>
      patchStage(
        new NextRequest(`http://localhost/api/stages/${STAGE_ID}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Renamed' }),
        }),
        params(STAGE_ID),
      ),
    happyStatus: 200,
  },
  {
    name: 'PUT /api/stages/[id]',
    gate: 'persistence',
    call: () =>
      putStage(
        new NextRequest(`http://localhost/api/stages/${STAGE_ID}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(makeDocument(STAGE_ID, 'Course')),
        }),
        params(STAGE_ID),
      ),
    happyStatus: 200,
  },
  {
    name: 'DELETE /api/stages/[id]',
    gate: 'persistence',
    call: () =>
      deleteStage(
        new NextRequest(`http://localhost/api/stages/${STAGE_ID}`, { method: 'DELETE' }),
        params(STAGE_ID),
      ),
    happyStatus: 200,
  },
  {
    name: 'GET /api/stages/[id]/scenes',
    gate: 'persistence',
    call: () =>
      getScenes(
        new NextRequest(`http://localhost/api/stages/${STAGE_ID}/scenes?ids=scene-1`),
        params(STAGE_ID),
      ),
    happyStatus: 200,
  },
  {
    name: 'GET /api/stages/[id]/manifest',
    gate: 'persistence',
    call: () =>
      getManifest(
        new NextRequest(`http://localhost/api/stages/${STAGE_ID}/manifest`),
        params(STAGE_ID),
      ),
    happyStatus: 200,
  },
  {
    name: 'GET /api/stages/[id]/freshness',
    gate: 'persistence',
    call: () =>
      getFreshness(
        new NextRequest(`http://localhost/api/stages/${STAGE_ID}/freshness`),
        params(STAGE_ID),
      ),
    happyStatus: 200,
  },
  {
    name: 'GET /api/materials',
    gate: 'runtime',
    call: () =>
      getMaterials(new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}`)),
    happyStatus: 200,
  },
  {
    name: 'POST /api/materials',
    gate: 'runtime',
    call: () =>
      postMaterials(
        new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}`, {
          method: 'POST',
          headers: { 'content-type': 'application/pdf', 'x-material-filename': 'notes.pdf' },
          body: Buffer.from('hello'),
        }),
      ),
    happyStatus: 201,
  },
  {
    name: 'GET /api/materials/[id]',
    gate: 'runtime',
    call: () =>
      getMaterial(
        new NextRequest(`http://localhost/api/materials/${MATERIAL_ID}?sessionId=${SESSION_ID}`),
        params(MATERIAL_ID),
      ),
    happyStatus: 200,
  },
  {
    name: 'GET /api/folders',
    gate: 'persistence',
    call: () => getFolders(new NextRequest('http://localhost/api/folders')),
    happyStatus: 200,
  },
  {
    name: 'POST /api/folders',
    gate: 'persistence',
    call: () =>
      postFolders(
        new NextRequest('http://localhost/api/folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Day 1' }),
        }),
      ),
    happyStatus: 200,
  },
  {
    name: 'PATCH /api/folders/[id]',
    gate: 'persistence',
    call: () =>
      patchFolder(
        new NextRequest(`http://localhost/api/folders/${FOLDER_ID}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Renamed' }),
        }),
        params(FOLDER_ID),
      ),
    happyStatus: 200,
  },
  {
    name: 'DELETE /api/folders/[id]',
    gate: 'persistence',
    call: () =>
      deleteFolder(
        new NextRequest(`http://localhost/api/folders/${FOLDER_ID}`, { method: 'DELETE' }),
        params(FOLDER_ID),
      ),
    happyStatus: 200,
  },
  {
    name: 'POST /api/folders/members',
    gate: 'persistence',
    call: () =>
      postFolderMembers(
        new NextRequest('http://localhost/api/folders/members', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stageId: STAGE_ID, folderId: FOLDER_ID }),
        }),
      ),
    happyStatus: 200,
  },
  {
    name: 'GET /api/stage-meta/[stageId]',
    gate: 'persistence',
    call: () =>
      getStageMeta(
        new NextRequest(`http://localhost/api/stage-meta/${STAGE_ID}`),
        stageMetaParams(STAGE_ID),
      ),
    happyStatus: 200,
  },
  {
    name: 'GET /api/stages/[id]/status',
    gate: 'persistence',
    call: () =>
      getStageStatus(
        new NextRequest(`http://localhost/api/stages/${STAGE_ID}/status`),
        params(STAGE_ID),
      ),
    happyStatus: 200,
  },
  {
    name: 'POST /api/stages/[id]/generation-complete',
    gate: 'persistence',
    call: () =>
      postGenerationComplete(
        new NextRequest(`http://localhost/api/stages/${STAGE_ID}/generation-complete`, {
          method: 'POST',
        }),
        params(STAGE_ID),
      ),
    happyStatus: 200,
  },
  {
    name: 'POST /api/stages/[id]/publish',
    gate: 'persistence',
    call: () =>
      postPublish(
        new NextRequest(`http://localhost/api/stages/${STAGE_ID}/publish`, { method: 'POST' }),
        params(STAGE_ID),
      ),
    happyStatus: 200,
  },
  {
    name: 'POST /api/stages/[id]/unpublish',
    gate: 'persistence',
    call: () =>
      postUnpublish(
        new NextRequest(`http://localhost/api/stages/${STAGE_ID}/unpublish`, { method: 'POST' }),
        params(STAGE_ID),
      ),
    happyStatus: 200,
  },
];

/**
 * Agent-only routes that must keep answering 404 whenever the runtime is not
 * configured — in particular with a DATABASE_URL and the flag off, where the
 * library routes above serve. Their serving behavior is covered by their own
 * suites; this list only pins the gate.
 */
const AGENT_ONLY_ROUTES: { name: string; call: () => Promise<Response> }[] = [
  {
    name: 'GET /api/agent/sessions',
    call: () => getAgentSessions(new NextRequest('http://localhost/api/agent/sessions')),
  },
  {
    name: 'GET /api/agent/sessions/status',
    call: () =>
      getAgentSessionsStatus(new NextRequest('http://localhost/api/agent/sessions/status')),
  },
  {
    name: 'GET /api/agent/sessions/[id]',
    call: () =>
      getAgentSession(
        new NextRequest(`http://localhost/api/agent/sessions/${SESSION_ID}`),
        params(SESSION_ID),
      ),
  },
  {
    name: 'GET /api/agent/skills',
    call: () => getAgentSkills(new NextRequest('http://localhost/api/agent/skills')),
  },
  {
    name: 'GET /api/agent/owner-events',
    call: () => getOwnerEvents(new NextRequest('http://localhost/api/agent/owner-events')),
  },
  {
    name: 'GET /api/skills/[id]',
    call: () =>
      getSkillExport(new NextRequest('http://localhost/api/skills/skill-1'), params('skill-1')),
  },
];

interface EnvState {
  label: string;
  runtimeFlag: string | undefined;
  databaseUrl: string | undefined;
  /** Whether each gate is open (routes serve) or closed (routes answer 404). */
  open: Record<RouteCase['gate'], boolean>;
}

const STATES: EnvState[] = [
  {
    label: 'flag off, no DATABASE_URL',
    runtimeFlag: undefined,
    databaseUrl: undefined,
    open: { persistence: false, runtime: false },
  },
  {
    label: 'flag on, no DATABASE_URL',
    runtimeFlag: 'true',
    databaseUrl: undefined,
    open: { persistence: false, runtime: false },
  },
  {
    label: 'flag off, DATABASE_URL present',
    runtimeFlag: undefined,
    databaseUrl: 'postgres://persistence',
    open: { persistence: true, runtime: false },
  },
  {
    label: 'flag on, DATABASE_URL present',
    runtimeFlag: 'true',
    databaseUrl: 'postgres://runtime',
    open: { persistence: true, runtime: true },
  },
];

function material(): AgentSessionMaterial {
  return {
    id: MATERIAL_ID,
    sessionId: SESSION_ID,
    kind: 'web',
    title: 'Example',
    sourceUrl: 'https://example.com/doc',
    textAssetId: 'asset-1',
    rawAssetId: null,
    textChars: 42,
    derivedFrom: null,
    extraction: { status: 'idle' as const, attempts: 0 },
    createdAt: '2025-01-01T00:00:00.000Z',
  };
}

for (const state of STATES) {
  describe(`persistence / agent runtime gates — ${state.label}`, () => {
    const originals = new Map<string, string | undefined>();

    beforeEach(() => {
      for (const key of ENV_KEYS) {
        originals.set(key, process.env[key]);
        delete process.env[key];
      }
      if (state.runtimeFlag !== undefined)
        process.env.OPENMAIC_AGENT_RUNTIME_ENABLED = state.runtimeFlag;
      if (state.databaseUrl !== undefined) process.env.DATABASE_URL = state.databaseUrl;

      vi.clearAllMocks();
      mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
      mocks.resolveOwnedSession.mockResolvedValue({ id: SESSION_ID, ownerId: 'owner-1' });
      mocks.listSessionMaterials.mockResolvedValue([material()]);
      mocks.createSourceMaterial.mockResolvedValue(material());
      mocks.getSessionMaterial.mockResolvedValue(material());
      mocks.fakeStore = createFakeDocumentStore();
      mocks.fakeStore.docs.set(
        STAGE_ID,
        makeDocument(STAGE_ID, 'Course', [makeSlideScene('scene-1', STAGE_ID, 1)]),
      );
      // Seed the folder the folder routes rename/delete/file against.
      void mocks.fakeStore.store.createFolder(FOLDER_ID, 'Seed folder');

      // Stage-meta surfaces read/write `stage_meta` through the server
      // provider's pool. The stage belongs to the same owner the owner seam
      // resolves (`owner-1`), so the access join answers an owned, live course.
      // The owner-material upload lifecycle gets a ready row for its INSERT /
      // finalize statements.
      mocks.queryPool.connect.mockImplementation(async () => ({
        query: mocks.queryPool.query,
        release: vi.fn(),
      }));
      mocks.assetStore.put.mockResolvedValue('asset-1');
      mocks.assetStore.remove.mockResolvedValue(undefined);
      mocks.queryPool.query.mockImplementation(async (text: string) => {
        if (text.includes('owner_material')) {
          return {
            rows: [
              {
                id: MATERIAL_ID,
                owner_id: 'owner-1',
                kind: 'source',
                derived_from: null,
                mime: 'application/pdf',
                bytes: 5,
                original_name: 'notes.pdf',
                asset_id: 'asset-1',
                sha256: 'abc',
                status: 'ready',
                extraction: null,
                created_at: 1,
                deleted_at: null,
              },
            ],
          };
        }
        if (text.includes('UPDATE stage_meta')) {
          return { rows: [{ stage_id: STAGE_ID }] };
        }
        return {
          rows: [
            {
              meta_owner_id: 'owner-1',
              meta_is_public: false,
              meta_published_at: null,
              meta_generation_complete: false,
              meta_deleted_at: null,
              document_name: 'Course',
            },
          ],
        };
      });
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        const original = originals.get(key);
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      }
      originals.clear();
    });

    it.each(ROUTES.map((route) => [route.name, route] as const))('%s', async (_name, route) => {
      const response = await route.call();
      if (state.open[route.gate]) {
        expect(response.status).toBe(route.happyStatus);
      } else {
        // The 404 must come from the gate, before any owner/store work —
        // and it must be a 404, never the 500 a store without a connection
        // would have produced.
        expect(response.status).toBe(404);
      }
      // Close any stream the freshness route opened so its timers cannot
      // outlive the test.
      await response.body?.cancel().catch(() => undefined);
    });

    if (!state.open.runtime) {
      it.each(AGENT_ONLY_ROUTES.map((route) => [route.name, route] as const))(
        '%s stays behind the agent runtime gate',
        async (_name, route) => {
          const response = await route.call();
          expect(response.status).toBe(404);
          await response.body?.cancel().catch(() => undefined);
        },
      );
    }
  });
}
