import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeStore } from '@openmaic/storage';

import {
  examKnowledgeMappingObjectKey,
  examKnowledgeSuggestionsObjectKey,
  examObservationsObjectKey,
  examSnapshotObjectKey,
} from '@/lib/server/materials/object-keys';
import {
  MaterialByteStoreError,
  type MaterialByteInput,
  type MaterialByteStore,
} from '@/lib/server/materials/bytes';
import { ExamError } from '@/lib/zhongkao/exam-errors';

const runtimeMocks = vi.hoisted(() => ({
  appendExamRuntimeEvent: vi.fn(),
  loadExamRuntime: vi.fn(),
}));

vi.mock('@/lib/server/zhongkao/exam-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/zhongkao/exam-runtime')>();
  return {
    ...actual,
    appendExamRuntimeEvent: runtimeMocks.appendExamRuntimeEvent,
    loadExamRuntime: runtimeMocks.loadExamRuntime,
  };
});

import { deleteExam, type ExamServiceDeps } from '@/lib/server/zhongkao/exam-service';

const EXAM_ID = `exam:v1:${'a'.repeat(64)}`;
const PROFILE_ID = 'fictional-profile';
const DOCUMENT_ID = `exam-document:v1:${'b'.repeat(64)}`;
const RAW_KEY = examSnapshotObjectKey(EXAM_ID, DOCUMENT_ID);
const MAPPING_KEY = examKnowledgeMappingObjectKey(EXAM_ID, 1);
const SUGGESTIONS_KEY = examKnowledgeSuggestionsObjectKey(EXAM_ID, 1);
const OBSERVATIONS_KEY = examObservationsObjectKey(EXAM_ID, 1, 1);

class ExactOnlyByteStore implements MaterialByteStore {
  readonly objects = new Map<string, Buffer>();
  readonly deleteCalls: string[] = [];
  failDeleteKeyOnce?: string;

  async put(key: string, body: MaterialByteInput): Promise<void> {
    if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
      throw new Error('buffered test input required');
    }
    this.objects.set(key, Buffer.from(body));
  }

  async get(key: string): Promise<Buffer> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new MaterialByteStoreError('ENOENT', 'material bytes are unavailable');
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    if (this.failDeleteKeyOnce === key) {
      this.failDeleteKeyOnce = undefined;
      throw new MaterialByteStoreError(
        'MATERIAL_BYTE_DELETE_FAILED',
        'material byte deletion failed',
      );
    }
    this.objects.delete(key);
  }
}

function keyedMutex(): ExamServiceDeps['withExamMutationLock'] {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

interface SyntheticExamState {
  schemaVersion: number;
  examSessionId: string;
  profileId: string;
  subjectId: string;
  status: 'ready_for_extraction' | 'deleting' | 'deleted';
  revision: number;
  createdAt: string;
  requestFingerprint: string;
  documentSetFingerprint: string;
  documents: Array<{ examDocumentId: string }>;
  knowledgeSuggestions?: { generationVersion: number; status: 'generating' | 'completed' };
  knowledgeMapping?: { mappingVersion: number };
  observationProjection?: { mappingVersion: number; observationVersion: number };
  deleteRequestedEventId?: string;
  deletedEventId?: string;
}

function stateWithKnowledgeArtifacts(): SyntheticExamState {
  return {
    schemaVersion: 1,
    examSessionId: EXAM_ID,
    profileId: PROFILE_ID,
    subjectId: 'math',
    status: 'ready_for_extraction',
    revision: 20,
    createdAt: '2026-09-01T08:00:00.000Z',
    requestFingerprint: 'c'.repeat(64),
    documentSetFingerprint: 'd'.repeat(64),
    documents: [{ examDocumentId: DOCUMENT_ID }],
    knowledgeMapping: { mappingVersion: 1 },
    observationProjection: { mappingVersion: 1, observationVersion: 1 },
  };
}

function harness() {
  const byteStore = new ExactOnlyByteStore();
  const withExamMutationLock = keyedMutex();
  let current = { state: stateWithKnowledgeArtifacts(), session: {}, records: [] };

  runtimeMocks.loadExamRuntime.mockImplementation(async () => current);
  runtimeMocks.appendExamRuntimeEvent.mockImplementation(
    async (_deps: unknown, input: { event: { eventId: string; eventType: string } }) => {
      if (input.event.eventType === 'exam_delete_requested') {
        current = {
          ...current,
          state: {
            ...current.state,
            status: 'deleting',
            revision: current.state.revision + 1,
            deleteRequestedEventId: input.event.eventId,
          },
        };
      } else if (input.event.eventType === 'exam_deleted') {
        current = {
          ...current,
          state: {
            ...current.state,
            status: 'deleted',
            revision: current.state.revision + 1,
            deletedEventId: input.event.eventId,
          },
        };
      }
      return { snapshot: current, replayed: false, eventAppended: true };
    },
  );

  const deps = {
    ownerId: 'fictional-owner',
    store: {} as RuntimeStore,
    byteStore,
    withExamMutationLock,
    captureSources: vi.fn(),
    now: () => '2026-09-01T08:01:00.000Z',
  } satisfies ExamServiceDeps;
  return {
    byteStore,
    deps,
    get current() {
      return current;
    },
    setKnowledgeArtifactsPresent() {
      current = {
        ...current,
        state: {
          ...current.state,
          knowledgeMapping: { mappingVersion: 1 },
          observationProjection: { mappingVersion: 1, observationVersion: 1 },
        },
      };
    },
    setOnlyKnowledgeSuggestionsPresent(status: 'generating' | 'completed') {
      current = {
        ...current,
        state: {
          ...current.state,
          knowledgeSuggestions: { generationVersion: 1, status },
          knowledgeMapping: undefined,
          observationProjection: undefined,
        },
      };
    },
  };
}

beforeEach(() => {
  runtimeMocks.appendExamRuntimeEvent.mockReset();
  runtimeMocks.loadExamRuntime.mockReset();
});

describe('Exam deletion of private knowledge artifacts', () => {
  it.each(['generating', 'completed'] as const)(
    'deletes the exact knowledge-suggestion key while generation is %s',
    async (status) => {
      const h = harness();
      h.setOnlyKnowledgeSuggestionsPresent(status);
      for (const key of [RAW_KEY, SUGGESTIONS_KEY]) {
        await h.byteStore.put(key, Buffer.from(`private:${key}`));
      }

      await expect(deleteExam(h.deps, EXAM_ID)).resolves.toBe('deleted');

      expect(h.byteStore.objects.size).toBe(0);
      expect(h.byteStore.deleteCalls).toEqual([RAW_KEY, SUGGESTIONS_KEY]);
    },
  );

  it('retries partial knowledge-suggestion cleanup after the started event persisted', async () => {
    const h = harness();
    h.setOnlyKnowledgeSuggestionsPresent('generating');
    for (const key of [RAW_KEY, SUGGESTIONS_KEY]) {
      await h.byteStore.put(key, Buffer.from(`private:${key}`));
    }
    h.byteStore.failDeleteKeyOnce = SUGGESTIONS_KEY;

    await expect(deleteExam(h.deps, EXAM_ID)).rejects.toMatchObject({
      code: 'EXAM_DELETE_FAILED',
    });
    expect(h.current.state.status).toBe('deleting');
    expect(h.byteStore.objects.has(RAW_KEY)).toBe(false);
    expect(h.byteStore.objects.has(SUGGESTIONS_KEY)).toBe(true);

    await expect(deleteExam(h.deps, EXAM_ID)).resolves.toBe('deleted');
    expect(h.byteStore.objects.size).toBe(0);
    expect(
      runtimeMocks.appendExamRuntimeEvent.mock.calls.filter(
        ([, input]) => input.event.eventType === 'exam_delete_requested',
      ),
    ).toHaveLength(1);
  });

  it('deletes mapping and observation artifacts by exact deterministic key without prefix support', async () => {
    const h = harness();
    for (const key of [RAW_KEY, MAPPING_KEY, OBSERVATIONS_KEY]) {
      await h.byteStore.put(key, Buffer.from(`private:${key}`));
    }

    await expect(deleteExam(h.deps, EXAM_ID)).resolves.toBe('deleted');

    expect(h.byteStore.objects.size).toBe(0);
    expect(h.byteStore.deleteCalls).toEqual([RAW_KEY, MAPPING_KEY, OBSERVATIONS_KEY]);
    expect(
      runtimeMocks.appendExamRuntimeEvent.mock.calls.map(([, input]) => input.event.eventType),
    ).toEqual(['exam_delete_requested', 'exam_deleted']);
  });

  it('keeps deletion recoverable when observation cleanup fails after earlier exact deletes', async () => {
    const h = harness();
    for (const key of [RAW_KEY, MAPPING_KEY, OBSERVATIONS_KEY]) {
      await h.byteStore.put(key, Buffer.from(`private:${key}`));
    }
    h.byteStore.failDeleteKeyOnce = OBSERVATIONS_KEY;

    await expect(deleteExam(h.deps, EXAM_ID)).rejects.toMatchObject({
      code: 'EXAM_DELETE_FAILED',
    });
    expect(h.current.state.status).toBe('deleting');
    expect(h.byteStore.objects.has(RAW_KEY)).toBe(false);
    expect(h.byteStore.objects.has(MAPPING_KEY)).toBe(false);
    expect(h.byteStore.objects.has(OBSERVATIONS_KEY)).toBe(true);

    await expect(deleteExam(h.deps, EXAM_ID)).resolves.toBe('deleted');
    expect(h.byteStore.objects.size).toBe(0);
    expect(
      runtimeMocks.appendExamRuntimeEvent.mock.calls.filter(
        ([, input]) => input.event.eventType === 'exam_delete_requested',
      ),
    ).toHaveLength(1);
  });

  it('serializes a mapping-first artifact write before delete and leaves no late resurrection', async () => {
    const h = harness();
    let releaseMapping!: () => void;
    let mappingEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      mappingEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseMapping = resolve;
    });

    const mapping = h.deps.withExamMutationLock(EXAM_ID, async () => {
      mappingEntered();
      await release;
      await h.byteStore.put(MAPPING_KEY, Buffer.from('private mapping'));
      await h.byteStore.put(OBSERVATIONS_KEY, Buffer.from('private observations'));
      h.setKnowledgeArtifactsPresent();
    });
    await entered;
    const deleting = deleteExam(h.deps, EXAM_ID);
    await Promise.resolve();
    expect(h.byteStore.deleteCalls).toEqual([]);

    releaseMapping();
    await mapping;
    await expect(deleting).resolves.toBe('deleted');
    expect(h.byteStore.objects.has(MAPPING_KEY)).toBe(false);
    expect(h.byteStore.objects.has(OBSERVATIONS_KEY)).toBe(false);
    expect(h.current.state.status).toBe('deleted');

    await expect(
      h.deps.withExamMutationLock(EXAM_ID, async () => {
        if (h.current.state.status !== 'ready_for_extraction') {
          throw new ExamError('EXAM_NOT_FOUND');
        }
        await h.byteStore.put(MAPPING_KEY, Buffer.from('late mapping'));
      }),
    ).rejects.toMatchObject({ code: 'EXAM_NOT_FOUND' });
    expect(h.byteStore.objects.has(MAPPING_KEY)).toBe(false);
  });
});
