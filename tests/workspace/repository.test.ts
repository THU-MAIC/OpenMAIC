import { beforeEach, describe, expect, it, vi } from 'vitest';

interface TestAgentConfig extends Record<string, unknown> {
  id: string;
  avatar: string;
  voiceConfig?: { providerId: string; voiceId: string };
}

interface TestStage extends Record<string, unknown> {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  agentIds?: string[];
  generatedAgentConfigs?: TestAgentConfig[];
}

interface TestScene extends Record<string, unknown> {
  id: string;
  stageId: string;
  order: number;
  type: string;
  content: { type: string; elements: Record<string, unknown>[] };
  actions: Record<string, unknown>[];
  createdAt: number;
  updatedAt: number;
}

interface TestDocument extends Record<string, unknown> {
  dslVersion: number;
  stage: TestStage;
  scenes: TestScene[];
}

const memory = vi.hoisted(() => {
  type Row = Record<string, unknown>;

  const documents = new Map<string, Row>();
  const legacyDocuments = new Map<string, Row>();
  const courseMetadata = new Map<string, Row>();
  const teacherVariants = new Map<string, Row>();
  const importJobs = new Map<string, Row>();
  const controls = {
    failMetadataPut: false,
    failMetadataAdd: false,
    failDocumentDelete: false,
  };

  const clone = <T>(value: T): T => structuredClone(value);

  function table(
    rows: Map<string, Row>,
    primaryKey: string,
    controlsForTable: { put?: keyof typeof controls; add?: keyof typeof controls } = {},
  ) {
    const maybeFail = (operation: 'put' | 'add') => {
      const control = controlsForTable[operation];
      if (control && controls[control]) throw new Error(`forced metadata ${operation} failure`);
    };
    return {
      async get(key: string) {
        const row = rows.get(key);
        return row ? clone(row) : undefined;
      },
      async add(row: Row) {
        maybeFail('add');
        const key = String(row[primaryKey]);
        if (rows.has(key)) throw new Error(`duplicate key: ${key}`);
        rows.set(key, clone(row));
        return key;
      },
      async put(row: Row) {
        maybeFail('put');
        const key = String(row[primaryKey]);
        rows.set(key, clone(row));
        return key;
      },
      async delete(key: string) {
        rows.delete(key);
      },
      async toArray() {
        return [...rows.values()].map(clone);
      },
      where(index: string) {
        return {
          equals(value: unknown) {
            return {
              async toArray() {
                return [...rows.values()].filter((row) => row[index] === value).map(clone);
              },
              async modify(patch: Row) {
                for (const [key, row] of rows) {
                  if (row[index] === value) rows.set(key, { ...row, ...clone(patch) });
                }
              },
            };
          },
        };
      },
      orderBy(index: string) {
        const sorted = () =>
          [...rows.values()].sort((a, b) => Number(a[index] ?? 0) - Number(b[index] ?? 0));
        return {
          reverse() {
            return { toArray: async () => sorted().reverse().map(clone) };
          },
        };
      },
    };
  }

  const courseMetadataTable = table(courseMetadata, 'stageId', {
    put: 'failMetadataPut',
    add: 'failMetadataAdd',
  });
  const teacherVariantsTable = table(teacherVariants, 'stageId');
  const importJobsTable = table(importJobs, 'id');

  const documentStore = {
    async listDocuments() {
      return [...documents.values()].map((document) => {
        const stage = document.stage as Row;
        const scenes = document.scenes as Row[];
        return {
          id: String(stage.id),
          name: String(stage.name),
          description: stage.description as string | undefined,
          sceneCount: scenes.length,
          createdAt: Number(stage.createdAt),
          updatedAt: Number(stage.updatedAt),
        };
      });
    },
    async loadDocument(id: string) {
      const document = documents.get(id);
      return document ? clone(document) : null;
    },
    async saveDocument(document: Row) {
      const stage = document.stage as Row;
      documents.set(String(stage.id), clone(document));
    },
    async deleteDocument(id: string) {
      if (controls.failDocumentDelete) throw new Error('forced document delete failure');
      documents.delete(id);
    },
  };

  const db = {
    courseMetadata: courseMetadataTable,
    teacherVariants: teacherVariantsTable,
    importJobs: importJobsTable,
    async transaction(...args: unknown[]) {
      const work = args.at(-1) as () => Promise<unknown>;
      const snapshots = [courseMetadata, teacherVariants, importJobs].map(
        (rows) => new Map([...rows].map(([key, value]) => [key, clone(value)])),
      );
      try {
        return await work();
      } catch (error) {
        [courseMetadata, teacherVariants, importJobs].forEach((rows, index) => {
          rows.clear();
          for (const [key, value] of snapshots[index]) rows.set(key, value);
        });
        throw error;
      }
    },
  };

  const accessDocument = async (id: string) => {
    let document = documents.get(id);
    if (!document) {
      const legacy = legacyDocuments.get(id);
      if (legacy) {
        document = clone(legacy);
        documents.set(id, document);
      }
    }
    return { document: document ? clone(document) : null, readOnlyLegacy: false };
  };

  const mutateDocument = async (
    id: string,
    work: (document: Row | null, store: typeof documentStore) => Promise<unknown>,
  ) => work((await documentStore.loadDocument(id)) as Row | null, documentStore);

  const reset = () => {
    for (const rows of [documents, legacyDocuments, courseMetadata, teacherVariants, importJobs]) {
      rows.clear();
    }
    controls.failMetadataPut = false;
    controls.failMetadataAdd = false;
    controls.failDocumentDelete = false;
  };

  return {
    documents,
    legacyDocuments,
    courseMetadata,
    teacherVariants,
    controls,
    documentStore,
    db,
    accessDocument,
    mutateDocument,
    reset,
    clone,
  };
});

vi.mock('@/lib/document-store', () => ({
  getDocumentStore: () => memory.documentStore,
  getLegacyDocumentStore: () => ({
    listStages: async () =>
      [...memory.legacyDocuments.values()].map((document) =>
        memory.clone((document.stage ?? {}) as Record<string, unknown>),
      ),
  }),
  accessDocument: memory.accessDocument,
  mutateDocument: memory.mutateDocument,
}));

vi.mock('@/lib/utils/database', () => ({ db: memory.db }));

import {
  createTeacherVariant,
  getWorkspaceCourse,
  listWorkspaceCourses,
  upsertCourseMetadata,
} from '@/lib/workspace/repository';

function makeDocument(id: string, title: string, updatedAt = 1000): TestDocument {
  return {
    dslVersion: 1,
    stage: {
      id,
      name: title,
      description: `${title} summary`,
      createdAt: 100,
      updatedAt,
    },
    scenes: [
      {
        id: `${id}-scene-1`,
        stageId: id,
        order: 0,
        type: 'slide',
        content: { type: 'slide', elements: [] },
        actions: [],
        createdAt: 100,
        updatedAt,
      },
    ],
  };
}

describe('workspace repository document-store integration', () => {
  beforeEach(() => {
    memory.reset();
    vi.useRealTimers();
  });

  it('lists canonical and legacy-only documents and materializes their metadata', async () => {
    memory.documents.set('canonical', makeDocument('canonical', 'Canonical'));
    memory.legacyDocuments.set('legacy', makeDocument('legacy', 'Legacy'));

    const courses = await listWorkspaceCourses({ sort: 'title_asc' });

    expect(courses.map((course) => course.stage.id)).toEqual(['canonical', 'legacy']);
    expect(courses.map((course) => course.sceneCount)).toEqual([1, 1]);
    expect(memory.documents.has('legacy')).toBe(true);
    expect(memory.courseMetadata.get('legacy')).toMatchObject({
      stageId: 'legacy',
      title: 'Legacy',
      source: { kind: 'legacy' },
    });
    await expect(getWorkspaceCourse('legacy')).resolves.toMatchObject({
      stage: { id: 'legacy' },
      metadata: { title: 'Legacy' },
    });
  });

  it('updates the authoritative stage and normalized workspace metadata together', async () => {
    memory.documents.set('course', makeDocument('course', 'Old'));
    vi.useFakeTimers();
    vi.setSystemTime(5000);

    const metadata = await upsertCourseMetadata('course', {
      title: '  New title  ',
      summary: 'New summary',
      tags: [' demo ', 'demo', 'physics'],
    });

    expect(metadata).toMatchObject({
      title: 'New title',
      summary: 'New summary',
      tags: ['demo', 'physics'],
      updatedAt: 5000,
    });
    expect((memory.documents.get('course')?.stage as Record<string, unknown>) ?? {}).toMatchObject({
      name: 'New title',
      description: 'New summary',
      updatedAt: 5000,
    });
  });

  it('restores the document stage when the metadata write fails', async () => {
    memory.documents.set('course', makeDocument('course', 'Old', 1200));
    await getWorkspaceCourse('course');
    memory.controls.failMetadataPut = true;
    vi.useFakeTimers();
    vi.setSystemTime(5000);

    await expect(
      upsertCourseMetadata('course', { title: 'New title', summary: 'New summary' }),
    ).rejects.toThrow('forced metadata put failure');

    expect(memory.documents.get('course')?.stage).toEqual({
      id: 'course',
      name: 'Old',
      description: 'Old summary',
      createdAt: 100,
      updatedAt: 1200,
    });
    expect(memory.courseMetadata.get('course')).toMatchObject({ title: 'Old' });
  });

  it('remaps course, scene and agent ids while sharing allocated asset references', async () => {
    const source = makeDocument('base', 'Base');
    source.stage.agentIds = ['preset-agent'];
    source.stage.generatedAgentConfigs = [
      {
        id: 'generated-agent',
        name: 'Guide',
        role: 'teacher',
        persona: 'Patient',
        avatar: 'ast_shared_avatar',
        color: '#123456',
        priority: 1,
        voiceConfig: { providerId: 'demo', voiceId: 'voice-stable' },
      },
    ];
    source.scenes.push({
      ...source.scenes[0],
      id: 'base-scene-2',
      order: 1,
      content: {
        type: 'slide',
        elements: [
          { id: 'image-1', type: 'image', src: 'ast_shared_image', linkedSceneId: 'base-scene-1' },
        ],
      },
      actions: [{ type: 'discussion', topic: 'Discuss', agentId: 'generated-agent' }],
      pblState: { thread: { agentId: 'preset-agent' }, sceneId: 'base-scene-1' },
    });
    memory.documents.set('base', source);
    vi.useFakeTimers();
    vi.setSystemTime(9000);

    const created = await createTeacherVariant('base', {
      stageId: 'variant',
      name: 'My variant',
    });
    const cloned = memory.documents.get('variant')!;
    const clonedStage = cloned.stage as TestStage;
    const clonedScenes = cloned.scenes as TestScene[];
    const clonedSecond = clonedScenes[1] as TestScene & {
      pblState: { thread: { agentId: string }; sceneId: string };
    };
    const clonedElement = clonedSecond.content.elements[0] as Record<string, unknown>;

    expect(created.metadata.kind).toBe('teacher_variant');
    expect(clonedStage.id).toBe('variant');
    expect(clonedScenes.map((scene) => scene.id)).not.toContain('base-scene-1');
    expect(clonedScenes.every((scene) => scene.stageId === 'variant')).toBe(true);
    expect(clonedElement.src).toBe('ast_shared_image');
    expect(clonedStage.generatedAgentConfigs?.[0].avatar).toBe('ast_shared_avatar');
    expect(clonedStage.agentIds?.[0]).not.toBe('preset-agent');
    expect(clonedStage.generatedAgentConfigs?.[0].id).not.toBe('generated-agent');
    expect(clonedSecond.actions[0]).toMatchObject({
      agentId: clonedStage.generatedAgentConfigs?.[0].id,
    });
    expect(clonedSecond.pblState.thread.agentId).toBe(clonedStage.agentIds?.[0]);
    expect(clonedSecond.pblState.sceneId).toBe(clonedScenes[0].id);
    expect(clonedElement.linkedSceneId).toBe(clonedScenes[0].id);
    expect(clonedStage.generatedAgentConfigs?.[0].voiceConfig?.voiceId).toBe('voice-stable');
    expect(memory.documents.get('base')).toEqual(source);
  });

  it('removes the cloned document and rolls back lineage if metadata persistence fails', async () => {
    memory.documents.set('base', makeDocument('base', 'Base'));
    await getWorkspaceCourse('base');
    memory.controls.failMetadataAdd = true;

    await expect(createTeacherVariant('base', { stageId: 'variant' })).rejects.toThrow(
      'forced metadata add failure',
    );

    expect(memory.documents.has('variant')).toBe(false);
    expect(memory.teacherVariants.has('variant')).toBe(false);
    expect(memory.courseMetadata.has('variant')).toBe(false);
  });

  it('reports both failures when variant document compensation also fails', async () => {
    memory.documents.set('base', makeDocument('base', 'Base'));
    await getWorkspaceCourse('base');
    memory.controls.failMetadataAdd = true;
    memory.controls.failDocumentDelete = true;

    await expect(createTeacherVariant('base', { stageId: 'variant' })).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [
        expect.objectContaining({ message: 'forced metadata add failure' }),
        expect.objectContaining({ message: 'forced document delete failure' }),
      ],
    });
  });
});
