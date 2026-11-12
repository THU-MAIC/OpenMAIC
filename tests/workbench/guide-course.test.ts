// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpDocumentStoreError } from '@openmaic/storage';

const mocks = vi.hoisted(() => ({
  learnerKey: 'learner-1',
  saved: [] as { stage: { id: string } }[],
  existing: new Set<string>(),
  saveError: null as Error | null,
}));

vi.mock('@/lib/persistence/bootstrap', () => ({
  getPersistenceLearnerKey: async () => mocks.learnerKey,
}));
vi.mock('@/lib/document-store', () => ({
  mutateDocument: async (
    id: string,
    work: (doc: null, store: unknown) => Promise<void>,
  ): Promise<void> =>
    work(null, {
      loadDocument: async () => (mocks.existing.has(id) ? { stage: { id } } : null),
      saveDocument: async (document: { stage: { id: string } }) => {
        if (mocks.saveError) throw mocks.saveError;
        mocks.saved.push(document);
        mocks.existing.add(document.stage.id);
      },
    }),
}));

import {
  findGuideCourse,
  guideCourseIdFor,
  guideCourseLocale,
  isGuideCourseId,
  seedGuideCourse,
  toGuideCourseDocument,
} from '@/lib/workbench/guide-course';
import {
  currentGuideCourseIdPattern,
  guideCourseGenerationOf,
  GUIDE_SEED_GENERATION,
} from '@/lib/persistence/guide-course-id';
import { resolveCourseChatBootstrap } from '@/lib/workbench/course-chat-bootstrap';

const doc = {
  stage: { id: 'guide-openmaic-zh', name: '5 分钟学会用 OpenMAIC' },
  scenes: [{ id: 'scene-p1', stageId: 'guide-openmaic-zh', type: 'slide' }],
};

beforeEach(() => {
  localStorage.clear();
  mocks.saved = [];
  mocks.existing.clear();
  mocks.saveError = null;
  mocks.learnerKey = 'learner-1';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(doc)),
  );
});

describe('the seeded guide course', () => {
  it('re-keys the shipped document onto the owner’s id, scene ids included', () => {
    const document = toGuideCourseDocument(doc, 'stage-guide-x', 1);
    expect(document?.stage.id).toBe('stage-guide-x');
    expect(document?.scenes[0].id).toBe('stage-guide-x-scene-p1');
    expect(document?.scenes[0].stageId).toBe('stage-guide-x');
    expect(toGuideCourseDocument({ stage: {} }, 'x', 1)).toBeNull();
  });

  it('names the seed generation in its ids, the first one without a segment', () => {
    const current = guideCourseIdFor('a');
    expect(current).toMatch(/^stage-guide-[0-9a-f]{16}$/);
    expect(guideCourseGenerationOf(current)).toBe(GUIDE_SEED_GENERATION);
    const other = guideCourseIdFor('a', 'g2');
    expect(other).toMatch(/^stage-guide-g2-[0-9a-f]{16}$/);
    expect(guideCourseGenerationOf(other)).toBe('g2');
    // Only the current generation is the guide course; anything else is ordinary.
    expect(isGuideCourseId(other)).toBe(false);
    expect(isGuideCourseId('stage-guide-x')).toBe(false);
    expect(guideCourseGenerationOf('stage-other')).toBeNull();
    const pattern = new RegExp(currentGuideCourseIdPattern());
    expect(pattern.test(current)).toBe(true);
    expect(pattern.test(other)).toBe(false);
  });

  it('has one stable id per owner, and different owners different ids', () => {
    expect(guideCourseIdFor('a')).toBe(guideCourseIdFor('a'));
    expect(guideCourseIdFor('a')).not.toBe(guideCourseIdFor('b'));
    expect(isGuideCourseId(guideCourseIdFor('a'))).toBe(true);
  });

  it('reads Chinese for any zh locale and English otherwise', () => {
    expect(guideCourseLocale('zh-TW')).toBe('zh');
    expect(guideCourseLocale('ja-JP')).toBe('en');
  });

  it('is written once, and a second load (or tab) writes nothing', async () => {
    expect(await seedGuideCourse(undefined, [])).toBe('created');
    expect(await seedGuideCourse(undefined, [])).toBe('settled');
    expect(mocks.saved).toHaveLength(1);
  });

  it('is left alone when the owner already has it (another device seeded it)', async () => {
    const id = guideCourseIdFor('learner-1');
    mocks.existing.add(id);
    expect(await seedGuideCourse(undefined, [])).toBe('settled');
    expect(mocks.saved).toHaveLength(0);
  });

  it('is not seeded beside another guide course already in the library (a claimed copy)', async () => {
    const claimed = guideCourseIdFor('anonymous-before-sign-in');
    expect(claimed).not.toBe(guideCourseIdFor('learner-1'));
    expect(await seedGuideCourse(undefined, [{ id: 'stage-other' }, { id: claimed }])).toBe(
      'settled',
    );
    expect(mocks.saved).toHaveLength(0);
  });

  it('is seeded beside a copy of an older generation, which stays an ordinary course', async () => {
    const older = guideCourseIdFor('learner-1', 'g0');
    expect(await seedGuideCourse(undefined, [{ id: older }])).toBe('created');
    expect(mocks.saved.map((saved) => saved.stage.id)).toEqual([guideCourseIdFor('learner-1')]);
    expect(findGuideCourse([{ id: older }, { id: guideCourseIdFor('learner-1') }])).toBe(
      guideCourseIdFor('learner-1'),
    );
    expect(findGuideCourse([{ id: older }])).toBeNull();
  });

  it('asks for a reload when the server holds a guide course the list missed (a claim landed)', async () => {
    mocks.saveError = new HttpDocumentStoreError(403, 'GUIDE_COURSE_EXISTS', 'exists');
    expect(await seedGuideCourse(undefined, [])).toBe('present');
    mocks.saveError = null;
    // Settled: a later load writes nothing.
    expect(await seedGuideCourse(undefined, [])).toBe('settled');
    expect(mocks.saved).toHaveLength(0);
  });

  it('is not seeded again once deleted: the retired id is refused for good', async () => {
    mocks.saveError = new HttpDocumentStoreError(409, 'STAGE_TOMBSTONED', 'retired');
    expect(await seedGuideCourse(undefined, [])).toBe('settled');
    mocks.saveError = null;
    expect(await seedGuideCourse(undefined, [])).toBe('settled');
    expect(mocks.saved).toHaveLength(0);
  });

  it('tries again on a later load after a transient failure', async () => {
    mocks.saveError = new HttpDocumentStoreError(503, 'UNAVAILABLE', 'down');
    expect(await seedGuideCourse(undefined, [])).toBe('retry');
    mocks.saveError = null;
    expect(await seedGuideCourse(undefined, [])).toBe('created');
  });

  it('is off when the deployment turns it off', async () => {
    expect(await seedGuideCourse(false, [])).toBe('off');
    expect(mocks.saved).toHaveLength(0);
  });

  it('opened on its own, is shown alone like any browsed course', () => {
    // No conversation is carried beside it; the tour asks for an empty one.
    const id = guideCourseIdFor('learner-1');
    expect(resolveCourseChatBootstrap({ courseId: id, sessionId: null })).toEqual({
      kind: 'browse',
      courseId: id,
    });
    expect(
      resolveCourseChatBootstrap({ courseId: id, sessionId: null, newConversationRequested: true }),
    ).toEqual({ kind: 'draft', courseId: id });
  });
});
