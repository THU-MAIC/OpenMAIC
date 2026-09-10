/**
 * Multi-stage curriculum tools: stages, durable folders, renaming, listing,
 * and cross-stage outline reads.
 *
 * Pins:
 *  - create_stage is idempotent by construction: the SAME call id replays onto
 *    the stage it already minted (nothing re-minted), a different call id mints
 *    a different stage, and a document at the derived id this session did NOT
 *    mint is refused fail-closed;
 *  - create_stage mints the document skeleton through the store with
 *    server-job producer semantics;
 *  - mutations and listings are owner-scoped while reads are capability-by-id;
 *  - every execute takes pi's 3rd `signal` argument and re-checks it at each
 *    IO boundary: a pre-aborted signal throws before any work;
 *  - read_stage_outline renders the outline/scene UNION view (planned pages
 *    while generation is incomplete, pure scenes once complete).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';

import {
  buildCurriculumTools,
  CURRICULUM_ALLOWLIST,
  CURRICULUM_TOOLS_PROMPT,
  probeStageAccess,
  type CurriculumToolDeps,
  type StageAccess,
} from '@/lib/server/agent-runtime/curriculum-tools';
import type { CourseDocument, CourseStore } from '@/lib/server/agent-runtime/course-tools';
import { withPlainJsonDocumentWrites } from '@/lib/document-store/plain-json-store';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { Scene } from '@/lib/types/stage';

interface ToolResultShape {
  isError?: boolean;
  content: { type: string; text: string }[];
  details?: Record<string, unknown>;
}

function makeStore(initial: CourseDocument | null = null): CourseStore {
  let doc = initial;
  const folders = new Map<
    string,
    { id: string; name: string; createdAt: number; updatedAt: number }
  >();
  let folderId: string | undefined;
  const store = {
    async loadDocument() {
      return doc;
    },
    async saveDocument(next: CourseDocument) {
      doc = next;
    },
    async putScene(_stageId: string, scene: Scene) {
      if (!doc) throw new Error('no document');
      const scenes = doc.scenes.filter((s) => s.id !== scene.id);
      scenes.push(scene);
      scenes.sort((a, b) => a.order - b.order);
      doc = { ...doc, scenes };
    },
    async createFolder(id: string, name: string, limit = 50) {
      const existing = [...folders.values()].find(
        (folder) => folder.name.toLowerCase() === name.toLowerCase(),
      );
      if (existing) return { folder: existing, reused: true };
      if (folders.size >= limit) throw new Error('folder limit');
      const folder = { id, name, createdAt: 1, updatedAt: 1 };
      folders.set(id, folder);
      return { folder, reused: false };
    },
    async listFolders() {
      return [...folders.values()];
    },
    async moveDocumentToFolder(_stageId: string, targetFolderId: string) {
      if (!doc || !folders.has(targetFolderId)) return false;
      folderId = targetFolderId;
      return true;
    },
    async listDocuments(targetFolderId?: string) {
      if (!doc || (targetFolderId !== undefined && folderId !== targetFolderId)) return [];
      return [
        {
          id: doc.stage.id,
          name: doc.stage.name,
          createdAt: doc.stage.createdAt,
          updatedAt: doc.stage.updatedAt,
          sceneCount: doc.scenes.length,
          ...(folderId ? { folderId } : {}),
        },
      ];
    },
  };
  return store as unknown as CourseStore;
}

/**
 * A store keyed by stage id (the naive `makeStore` ignores the stage id, which
 * is exactly right for most tests but cannot tell a replay of the same stage
 * from a genuinely different one).
 */
function makeKeyedStore(): CourseStore & { docs: Map<string, CourseDocument> } {
  const docs = new Map<string, CourseDocument>();
  const folders = new Map<
    string,
    { id: string; name: string; createdAt: number; updatedAt: number }
  >();
  const memberships = new Map<string, string>();
  const store = {
    docs,
    async loadDocument(stageId: string) {
      return docs.get(stageId) ?? null;
    },
    async saveDocument(next: CourseDocument) {
      docs.set(next.stage.id, next);
    },
    async putScene(stageId: string, scene: Scene) {
      const doc = docs.get(stageId);
      if (!doc) throw new Error('no document');
      const scenes = doc.scenes.filter((s) => s.id !== scene.id);
      scenes.push(scene);
      scenes.sort((a, b) => a.order - b.order);
      docs.set(stageId, { ...doc, scenes });
    },
    async createFolder(id: string, name: string) {
      const existing = [...folders.values()].find(
        (folder) => folder.name.toLowerCase() === name.toLowerCase(),
      );
      if (existing) return { folder: existing, reused: true };
      const folder = { id, name, createdAt: 1, updatedAt: 1 };
      folders.set(id, folder);
      return { folder, reused: false };
    },
    async listFolders() {
      return [...folders.values()];
    },
    async moveDocumentToFolder(stageId: string, folderId: string) {
      if (!docs.has(stageId) || !folders.has(folderId)) return false;
      memberships.set(stageId, folderId);
      return true;
    },
    async listDocuments(folderId?: string) {
      return [...docs.values()]
        .filter((doc) => folderId === undefined || memberships.get(doc.stage.id) === folderId)
        .map((doc) => ({
          id: doc.stage.id,
          name: doc.stage.name,
          createdAt: doc.stage.createdAt,
          updatedAt: doc.stage.updatedAt,
          sceneCount: doc.scenes.length,
          ...(memberships.get(doc.stage.id) ? { folderId: memberships.get(doc.stage.id) } : {}),
        }));
    },
  };
  return store as unknown as CourseStore & { docs: Map<string, CourseDocument> };
}

function ownedDoc(stageId: string, name: string): CourseDocument {
  return {
    stage: { id: stageId, name, createdAt: 1, updatedAt: 1 },
    scenes: [],
    outline: {
      outlines: [
        { id: 'p1', order: 1, title: 'Intro', description: 'd', keyPoints: [], type: 'slide' },
        { id: 'p2', order: 2, title: 'Deep Dive', description: 'd', keyPoints: [], type: 'quiz' },
      ],
      requirement: 'a course',
      generationComplete: false,
      producer: 'server-job',
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

const OWNED: StageAccess = { kind: 'owned', stage: { stageId: 'stage-b', name: 'Course B' } };

function makeDeps(overrides: Partial<CurriculumToolDeps> = {}): CurriculumToolDeps {
  return {
    store: makeStore(ownedDoc('stage-b', 'Course B')),
    ownerId: 'user:u1',
    sessionId: 'session-1',
    stageAccess: async () => OWNED,
    ...overrides,
  } as CurriculumToolDeps;
}

async function runTool(
  deps: CurriculumToolDeps,
  name: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResultShape> {
  const tools = buildCurriculumTools(deps);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} not registered`);
  return (await tool.execute('call-1', params as never, signal)) as ToolResultShape;
}

describe('create_stage', () => {
  it('emits courseLink after creating the stage', async () => {
    const onStageLink = vi.fn();
    const result = await runTool(makeDeps({ store: makeStore(), onStageLink }), 'create_stage', {
      title: 'Day 1',
    });
    expect(result.isError).toBeUndefined();
    expect(onStageLink).toHaveBeenCalledWith(
      expect.objectContaining({
        stageId: result.details?.stageId,
        url: expect.stringMatching(/^\/classroom\//),
      }),
    );
  });

  it('mints a server-job document skeleton and returns the classroom url', async () => {
    const store = makeStore();
    const deps = makeDeps({ store });
    const result = await runTool(deps, 'create_stage', {
      title: 'Day 1 — Python',
      brief: 'basics',
    });

    expect(result.isError).toBeUndefined();
    expect(result.details?.url).toMatch(/^\/classroom\/stage-/);
    expect(result.details?.title).toBe('Day 1 — Python');

    const doc = (
      store as unknown as { loadDocument(): Promise<CourseDocument | null> }
    ).loadDocument();
    const saved = await doc;
    expect(saved?.stage.name).toBe('Day 1 — Python');
    expect(saved?.stage.description).toBe('basics');
    expect(saved?.scenes).toEqual([]);
    expect(saved?.outline).toMatchObject({
      outlines: [],
      requirement: 'Day 1 — Python',
      generationComplete: true,
      producer: 'server-job',
      producerRef: 'session-1',
    });
  });

  it('omits description and producerRef when not provided', async () => {
    const store = makeStore();
    const deps = makeDeps({ store, sessionId: '' });
    const result = await runTool(deps, 'create_stage', { title: 'Course' });
    expect(result.isError).toBeUndefined();
    const saved = await (
      store as unknown as { loadDocument(): Promise<CourseDocument | null> }
    ).loadDocument();
    expect(saved?.stage.description).toBeUndefined();
    expect((saved?.outline as { producerRef?: string }).producerRef).toBeUndefined();
  });

  it('rejects an empty title', async () => {
    const deps = makeDeps();
    const result = await runTool(deps, 'create_stage', { title: '   ' });
    expect(result.isError).toBe(true);
    expect(result.details?.error).toBe('empty-title');
  });

  it('throws before any work when the run signal is already aborted', async () => {
    const store = makeStore();
    const save = vi.spyOn(store as unknown as { saveDocument(): Promise<void> }, 'saveDocument');
    const controller = new AbortController();
    controller.abort();
    const deps = makeDeps({ store });
    await expect(
      runTool(deps, 'create_stage', { title: 'Course' }, controller.signal),
    ).rejects.toThrow('aborted');
    expect(save).not.toHaveBeenCalled();
  });

  it('replaying the SAME call id is idempotent: same stage id, existing stage returned, nothing re-minted', async () => {
    // A crash between saveDocument and the result checkpoint makes the resume
    // path re-issue the same tool call. The stage id derives from
    // (sessionId, callId), so the retry lands on the stage the original minted
    // instead of casting a second orphan course.
    const store = makeKeyedStore();
    const save = vi.spyOn(store, 'saveDocument');
    const deps = makeDeps({ store });
    const tools = buildCurriculumTools(deps);
    const createStage = tools.find((t) => t.name === 'create_stage');
    if (!createStage) throw new Error('create_stage not registered');

    const first = (await createStage.execute('call-9', {
      title: 'Day 1 — Python',
    } as never)) as ToolResultShape;
    expect(first.isError).toBeUndefined();
    expect(save).toHaveBeenCalledTimes(1);

    const second = (await createStage.execute('call-9', {
      title: 'Day 1 — Python',
    } as never)) as ToolResultShape;
    expect(second.isError).toBeUndefined();
    expect(second.details?.stageId).toBe(first.details?.stageId);
    expect(second.details?.reused).toBe(true);
    expect(second.details?.url).toBe(first.details?.url);
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.docs.size).toBe(1);
  });

  it('a DIFFERENT call id derives a DIFFERENT stage id (a genuinely new create)', async () => {
    const store = makeKeyedStore();
    const deps = makeDeps({ store });
    const createStage = buildCurriculumTools(deps).find((t) => t.name === 'create_stage');
    if (!createStage) throw new Error('create_stage not registered');

    const a = (await createStage.execute('call-a', {
      title: 'Day 1',
    } as never)) as ToolResultShape;
    const b = (await createStage.execute('call-b', {
      title: 'Day 1',
    } as never)) as ToolResultShape;
    expect(a.isError).toBeUndefined();
    expect(b.isError).toBeUndefined();
    expect(a.details?.stageId).not.toBe(b.details?.stageId);
    expect(store.docs.size).toBe(2);
    expect(a.details?.stageId).toMatch(/^stage-[A-Za-z0-9_-]{10}$/);
  });

  it('refuses to confirm a stage at the derived id that this session did NOT mint', async () => {
    // Same call id but the existing document carries a foreign producer ref:
    // fail-closed — never confirm or overwrite a document that is not this
    // session's own mint.
    const foreign = ownedDoc('stage-whatever', 'Someone else');
    foreign.outline = {
      outlines: [],
      requirement: 'x',
      generationComplete: false,
      producer: 'server-job',
      producerRef: 'other-session',
      createdAt: 1,
      updatedAt: 1,
    };
    const deps = makeDeps({ store: makeStore(foreign) });
    const result = await runTool(deps, 'create_stage', { title: 'Day 1' });
    expect(result.isError).toBe(true);
    expect(result.details?.refused).toBe(true);
  });
});

describe('folder organization and rename tools', () => {
  it('creates an empty folder, creates a stage in it, renames it, moves it, and lists it', async () => {
    const store = makeKeyedStore();
    const deps = makeDeps({ store });
    const firstFolder = await runTool(deps, 'create_folder', { name: 'Week One' });
    const firstFolderId = firstFolder.details?.folderId as string;

    const empty = await runTool(deps, 'list_folder_stages', { folderId: firstFolderId });
    expect(empty.details).toEqual({ courses: [], count: 0 });

    const created = await runTool(deps, 'create_stage', {
      title: 'Day 1',
      folderId: firstFolderId,
    });
    const stageId = created.details?.stageId as string;
    expect(created.details).toMatchObject({ folderId: firstFolderId, archived: true });

    const renamed = await runTool(deps, 'rename_stage', { stageId, name: 'Day 1 revised' });
    expect(renamed.details).toMatchObject({ stageId, title: 'Day 1 revised' });

    const secondFolder = await runTool(deps, 'create_folder', { name: 'Week Two' });
    const secondFolderId = secondFolder.details?.folderId as string;
    const moved = await runTool(deps, 'move_to_folder', { stageId, folderId: secondFolderId });
    expect(moved.details).toEqual({ stageId, folderId: secondFolderId });

    const listed = await runTool(deps, 'list_folder_stages', { folderId: secondFolderId });
    expect(listed.details?.courses).toEqual([
      expect.objectContaining({ stageId, title: 'Day 1 revised', folderId: secondFolderId }),
    ]);
  });

  it('reuses folders by case-insensitive name and move_to_folder is idempotent', async () => {
    const store = makeKeyedStore();
    const deps = makeDeps({ store });
    const first = await runTool(deps, 'create_folder', { name: 'Series' });
    const repeated = await runTool(deps, 'create_folder', { name: 'series' });
    expect(repeated.details).toMatchObject({ folderId: first.details?.folderId, reused: true });

    const created = await runTool(deps, 'create_stage', { title: 'Course' });
    const args = { stageId: created.details?.stageId, folderId: first.details?.folderId };
    expect((await runTool(deps, 'move_to_folder', args)).isError).toBeUndefined();
    expect((await runTool(deps, 'move_to_folder', args)).isError).toBeUndefined();
  });

  it('validates folder names and stage names with the shared display-width rule', async () => {
    const deps = makeDeps();
    await expect(runTool(deps, 'create_folder', { name: '   ' })).resolves.toMatchObject({
      isError: true,
      details: { error: 'empty' },
    });
    await expect(runTool(deps, 'create_folder', { name: 'a'.repeat(41) })).resolves.toMatchObject({
      isError: true,
      details: { error: 'tooLong' },
    });
    await expect(
      runTool(deps, 'rename_stage', { stageId: 'stage-b', name: 'a'.repeat(41) }),
    ).resolves.toMatchObject({ isError: true, details: { error: 'name-too-long' } });
  });

  it('marks rename_stage sequential', () => {
    const rename = buildCurriculumTools(makeDeps()).find((tool) => tool.name === 'rename_stage');
    expect(rename?.executionMode).toBe('sequential');
  });
});

describe('folder tool cross-owner isolation through the bound PostgreSQL store', () => {
  let db: PGlite;

  class PGlitePool {
    constructor(readonly database: PGlite) {}

    query(text: string, params?: unknown[]) {
      return this.database.query(text, params);
    }

    async connect() {
      return {
        query: (text: string, params?: unknown[]) => this.database.query(text, params),
        release() {},
      };
    }
  }

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureDocumentSchema(db);
    await ensureStageMetaSchema(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function ownerTools(ownerId: string, sessionId: string) {
    const store = withPlainJsonDocumentWrites(
      createOwnerBoundDocumentStore({
        pool: new PGlitePool(db),
        ownerId,
        validateScene: validateAppScene,
        validateStage: validateAppStage,
      }),
    ) as unknown as CourseStore;
    const stageAccess = (stageId: string) => probeStageAccess(ownerId, stageId, db);
    return { store, tools: buildCurriculumTools({ store, ownerId, sessionId, stageAccess }) };
  }

  async function execute(
    tools: ReturnType<typeof buildCurriculumTools>,
    name: string,
    callId: string,
    params: Record<string, unknown>,
  ): Promise<ToolResultShape> {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`${name} not registered`);
    return (await tool.execute(callId, params as never)) as ToolResultShape;
  }

  it('keeps create, create-with-folder, move, rename, and list owner-scoped', async () => {
    const alice = ownerTools('anon:alice', 'session-alice');
    const bob = ownerTools('anon:bob', 'session-bob');
    const aliceFolder = await execute(alice.tools, 'create_folder', 'folder-a', { name: 'Alice' });
    const bobFolder = await execute(bob.tools, 'create_folder', 'folder-b', { name: 'Bob' });
    const aliceFolderId = aliceFolder.details?.folderId as string;
    const bobFolderId = bobFolder.details?.folderId as string;

    expect(await alice.store.listFolders()).toEqual([
      expect.objectContaining({ id: aliceFolderId, name: 'Alice' }),
    ]);
    expect(await bob.store.listFolders()).toEqual([
      expect.objectContaining({ id: bobFolderId, name: 'Bob' }),
    ]);

    const aliceStage = await execute(alice.tools, 'create_stage', 'stage-a', {
      title: 'Alice stage',
      folderId: aliceFolderId,
    });
    const aliceStageId = aliceStage.details?.stageId as string;
    const refusedCreate = await execute(bob.tools, 'create_stage', 'stage-b', {
      title: 'Bob stage',
      folderId: aliceFolderId,
    });
    expect(refusedCreate).toMatchObject({ isError: true, details: { refused: true } });

    const foreignStageMove = await execute(bob.tools, 'move_to_folder', 'move-1', {
      stageId: aliceStageId,
      folderId: bobFolderId,
    });
    expect(foreignStageMove).toMatchObject({ isError: true, details: { refused: true } });

    const foreignFolderMove = await execute(alice.tools, 'move_to_folder', 'move-2', {
      stageId: aliceStageId,
      folderId: bobFolderId,
    });
    expect(foreignFolderMove).toMatchObject({ isError: true, details: { refused: true } });

    const foreignRename = await execute(bob.tools, 'rename_stage', 'rename-1', {
      stageId: aliceStageId,
      name: 'Stolen',
    });
    expect(foreignRename).toMatchObject({ isError: true, details: { refused: true } });

    const foreignFolderList = await execute(bob.tools, 'list_folder_stages', 'list-1', {
      folderId: aliceFolderId,
    });
    expect(foreignFolderList).toMatchObject({ isError: true, details: { refused: true } });
    const bobList = await execute(bob.tools, 'list_folder_stages', 'list-2', {});
    expect(bobList.details).toEqual({ courses: [], count: 0 });
  });
});

describe('read_stage_outline', () => {
  it('returns the title and page-list summary of an owned course (not content)', async () => {
    const deps = makeDeps();
    const result = await runTool(deps, 'read_stage_outline', { stageId: 'stage-b' });
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      stageId: 'stage-b',
      title: 'Course B',
      pageCount: 2,
      pages: [
        { order: 1, title: 'Intro', type: 'slide' },
        { order: 2, title: 'Deep Dive', type: 'quiz' },
      ],
    });
  });

  it('refuses a stage id that does not resolve to a document', async () => {
    const deps = makeDeps({ store: makeStore(null) });
    const result = await runTool(deps, 'read_stage_outline', { stageId: 'stage-x' });
    expect(result.isError).toBe(true);
    expect(result.details?.refused).toBe(true);
    expect(result.content[0].text).toContain('Course document not found');
  });

  it('falls back to the persisted scene list when there is no outline snapshot', async () => {
    const doc = ownedDoc('stage-b', 'Course B');
    doc.outline = undefined;
    doc.scenes = [
      { id: 's1', stageId: 'stage-b', order: 1, title: 'Scene 1', type: 'slide' } as Scene,
    ];
    const deps = makeDeps({ store: makeStore(doc) });
    const result = await runTool(deps, 'read_stage_outline', { stageId: 'stage-b' });
    expect(result.details?.pages).toEqual([{ order: 1, title: 'Scene 1', type: 'slide' }]);
  });

  it('derives the page list from REAL scenes when pages exist, ignoring a drifted outline snapshot', async () => {
    // The reviewer scenario: an import at order 2 shifts scenes 2/3 to 3/4
    // but the outline snapshot keeps [1,2,2,3]. Deriving from the scenes must
    // yield [1,2,3,4] with no duplicated page numbers.
    const doc = ownedDoc('stage-b', 'Course B');
    doc.scenes = [
      { id: 's1', stageId: 'stage-b', order: 1, title: 'Page one', type: 'slide' } as Scene,
      { id: 's2', stageId: 'stage-b', order: 2, title: 'Inserted', type: 'slide' } as Scene,
      { id: 's3', stageId: 'stage-b', order: 3, title: 'Page two', type: 'slide' } as Scene,
      { id: 's4', stageId: 'stage-b', order: 4, title: 'Page three', type: 'quiz' } as Scene,
    ];
    doc.outline = {
      outlines: [
        { id: 'p1', order: 1, title: 'Page one', description: 'd', keyPoints: [], type: 'slide' },
        {
          id: 'p2',
          order: 2,
          title: 'Page two',
          description: 'd',
          keyPoints: [],
          type: 'slide',
        },
        { id: 'p3', order: 2, title: 'Inserted', description: 'd', keyPoints: [], type: 'slide' },
        {
          id: 'p4',
          order: 3,
          title: 'Page three',
          description: 'd',
          keyPoints: [],
          type: 'quiz',
        },
      ],
      requirement: 'a course',
      generationComplete: true,
      producer: 'server-job',
      createdAt: 1,
      updatedAt: 1,
    };
    const deps = makeDeps({ store: makeStore(doc) });
    const result = await runTool(deps, 'read_stage_outline', { stageId: 'stage-b' });
    expect(result.isError).toBeUndefined();
    const pages = result.details?.pages as { order: number; title: string }[];
    expect(pages.map((p) => p.order)).toEqual([1, 2, 3, 4]);
    expect(new Set(pages.map((p) => p.order)).size).toBe(4);
    expect(pages.map((p) => p.title)).toEqual(['Page one', 'Inserted', 'Page two', 'Page three']);
    expect(result.details?.pageCount).toBe(4);
  });

  it('union view: while generation is incomplete, planned pages without a scene are appended as a planned tail (R2-P2-3)', async () => {
    const doc = ownedDoc('stage-b', 'Course B');
    doc.outline = {
      outlines: [
        { id: 'p1', order: 1, title: 'Intro', description: 'd', keyPoints: [], type: 'slide' },
        { id: 'p2', order: 2, title: 'Deep Dive', description: 'd', keyPoints: [], type: 'quiz' },
        { id: 'p3', order: 3, title: 'Wrap-up', description: 'd', keyPoints: [], type: 'slide' },
      ],
      requirement: 'a course',
      generationComplete: false,
      producer: 'server-job',
      createdAt: 1,
      updatedAt: 1,
    };
    doc.scenes = [
      {
        id: 's1',
        stageId: 'stage-b',
        order: 1,
        title: 'Intro',
        type: 'slide',
        outlineId: 'p1',
      } as Scene,
    ];
    const deps = makeDeps({ store: makeStore(doc) });
    const result = await runTool(deps, 'read_stage_outline', { stageId: 'stage-b' });
    expect(result.isError).toBeUndefined();
    expect(result.details?.pageCount).toBe(3);
    expect(result.details?.pages).toEqual([
      { order: 1, title: 'Intro', type: 'slide' },
      { order: 2, title: 'Deep Dive', type: 'quiz' },
      { order: 3, title: 'Wrap-up', type: 'slide' },
    ]);
    // The human-readable text marks the not-yet-landed pages as planned.
    const text = result.content[0].text;
    expect(text).toContain('- 1. Intro [slide]');
    expect(text).not.toContain('- 1. Intro [slide] (planned)');
    expect(text).toContain('- 2. Deep Dive [quiz] (planned)');
    expect(text).toContain('- 3. Wrap-up [slide] (planned)');
  });

  it('a COMPLETED outline is pure scenes: the planned tail can never resurface (R2-P2-3)', async () => {
    const doc = ownedDoc('stage-b', 'Course B');
    doc.outline = {
      outlines: [
        { id: 'p1', order: 1, title: 'Intro', description: 'd', keyPoints: [], type: 'slide' },
        { id: 'p2', order: 2, title: 'Deep Dive', description: 'd', keyPoints: [], type: 'quiz' },
        { id: 'p3', order: 3, title: 'Wrap-up', description: 'd', keyPoints: [], type: 'slide' },
      ],
      requirement: 'a course',
      generationComplete: true,
      producer: 'server-job',
      createdAt: 1,
      updatedAt: 1,
    };
    doc.scenes = [
      {
        id: 's1',
        stageId: 'stage-b',
        order: 1,
        title: 'Intro',
        type: 'slide',
        outlineId: 'p1',
      } as Scene,
    ];
    const deps = makeDeps({ store: makeStore(doc) });
    const result = await runTool(deps, 'read_stage_outline', { stageId: 'stage-b' });
    expect(result.details?.pageCount).toBe(1);
    expect(result.details?.pages).toEqual([{ order: 1, title: 'Intro', type: 'slide' }]);
    expect(result.content[0].text).not.toContain('(planned)');
  });

  it('a real page WITHOUT outlineId pairs by order — the plan is not duplicated (R3-P2-2)', async () => {
    const doc = ownedDoc('stage-b', 'Course B');
    doc.scenes = [
      { id: 's1', stageId: 'stage-b', order: 1, title: 'Intro', type: 'slide' } as Scene,
    ];
    doc.outline = {
      outlines: [
        { id: 'p1', order: 1, title: 'Intro', description: 'd', keyPoints: [], type: 'slide' },
        { id: 'p2', order: 2, title: 'Deep Dive', description: 'd', keyPoints: [], type: 'quiz' },
      ],
      requirement: 'a course',
      generationComplete: false,
      producer: 'server-job',
      createdAt: 1,
      updatedAt: 1,
    };
    const deps = makeDeps({ store: makeStore(doc) });
    const result = await runTool(deps, 'read_stage_outline', { stageId: 'stage-b' });
    expect(result.isError).toBeUndefined();
    expect(result.details?.pageCount).toBe(2);
    expect(result.details?.pages).toEqual([
      { order: 1, title: 'Intro', type: 'slide' },
      { order: 2, title: 'Deep Dive', type: 'quiz' },
    ]);
    const text = result.content[0].text;
    // Page 1 appears exactly once, as the REAL page (not planned).
    expect(text).toContain('- 1. Intro [slide]');
    expect(text).not.toContain('- 1. Intro [slide] (planned)');
    expect(text).toContain('- 2. Deep Dive [quiz] (planned)');
  });

  it('a duplicated outlineId consumes only the FIRST plan entry — the twin is not swallowed (R3-P2-2)', async () => {
    const doc = ownedDoc('stage-b', 'Course B');
    doc.scenes = [
      {
        id: 's1',
        stageId: 'stage-b',
        order: 1,
        title: 'Page one',
        type: 'slide',
        outlineId: 'dup',
      } as Scene,
    ];
    doc.outline = {
      outlines: [
        { id: 'dup', order: 1, title: 'Page one', description: 'd', keyPoints: [], type: 'slide' },
        { id: 'dup', order: 2, title: 'Page two', description: 'd', keyPoints: [], type: 'slide' },
      ],
      requirement: 'a course',
      generationComplete: false,
      producer: 'server-job',
      createdAt: 1,
      updatedAt: 1,
    };
    const deps = makeDeps({ store: makeStore(doc) });
    const result = await runTool(deps, 'read_stage_outline', { stageId: 'stage-b' });
    expect(result.isError).toBeUndefined();
    expect(result.details?.pageCount).toBe(2);
    expect(result.details?.pages).toEqual([
      { order: 1, title: 'Page one', type: 'slide' },
      { order: 2, title: 'Page two', type: 'slide' },
    ]);
    expect(result.content[0].text).toContain('- 2. Page two [slide] (planned)');
  });

  it('merges a mid-deck scene by order: scenes [2] + plan [1,2,3] read [planned 1, real 2, planned 3] (R3-P2-3)', async () => {
    const doc = ownedDoc('stage-b', 'Course B');
    doc.scenes = [{ id: 's2', stageId: 'stage-b', order: 2, title: 'Mid', type: 'slide' } as Scene];
    doc.outline = {
      outlines: [
        { id: 'p1', order: 1, title: 'Intro', description: 'd', keyPoints: [], type: 'slide' },
        { id: 'p2', order: 2, title: 'Mid', description: 'd', keyPoints: [], type: 'slide' },
        { id: 'p3', order: 3, title: 'Wrap-up', description: 'd', keyPoints: [], type: 'slide' },
      ],
      requirement: 'a course',
      generationComplete: false,
      producer: 'server-job',
      createdAt: 1,
      updatedAt: 1,
    };
    const deps = makeDeps({ store: makeStore(doc) });
    const result = await runTool(deps, 'read_stage_outline', { stageId: 'stage-b' });
    expect(result.isError).toBeUndefined();
    expect(result.details?.pageCount).toBe(3);
    expect(result.details?.pages).toEqual([
      { order: 1, title: 'Intro', type: 'slide' },
      { order: 2, title: 'Mid', type: 'slide' },
      { order: 3, title: 'Wrap-up', type: 'slide' },
    ]);
    const text = result.content[0].text;
    expect(text).toContain('- 1. Intro [slide] (planned)');
    expect(text).toContain('- 2. Mid [slide]');
    expect(text).not.toContain('- 2. Mid [slide] (planned)');
    expect(text).toContain('- 3. Wrap-up [slide] (planned)');
  });
});

describe('curriculum allowlist', () => {
  it('registers the complete curriculum toolset', () => {
    for (const name of [
      'create_stage',
      'create_folder',
      'move_to_folder',
      'rename_stage',
      'list_folder_stages',
      'read_stage_outline',
    ]) {
      expect(CURRICULUM_ALLOWLIST).toContain(name);
    }
    expect(CURRICULUM_ALLOWLIST.size).toBe(6);
  });

  it('exposes all tools from the toolset', () => {
    const tools = buildCurriculumTools(makeDeps());
    expect(tools.map((t) => t.name)).toEqual([
      'create_stage',
      'create_folder',
      'move_to_folder',
      'rename_stage',
      'list_folder_stages',
      'read_stage_outline',
    ]);
  });

  it('prompt block teaches explicit stage ids, folders, renaming, and outline chaining', () => {
    expect(CURRICULUM_TOOLS_PROMPT).toContain('`create_stage`');
    expect(CURRICULUM_TOOLS_PROMPT).toContain('`read_stage_outline`');
    expect(CURRICULUM_TOOLS_PROMPT).toContain('`create_folder`');
    expect(CURRICULUM_TOOLS_PROMPT).toContain('`list_folder_stages`');
    expect(CURRICULUM_TOOLS_PROMPT).toContain('`move_to_folder`');
    expect(CURRICULUM_TOOLS_PROMPT).toContain('`rename_stage`');
  });
});
