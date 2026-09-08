import { randomUUID } from 'node:crypto';

import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  createTeacherAnalysis,
  getTeacherAnalysis,
  listTeacherAnalyses,
  updateTeacherAnalysis,
  type TeacherAnalysisServiceDeps,
} from '@/lib/server/teacher/analysis-service';
import { createTeacherStudent, getTeacherStudent } from '@/lib/server/teacher/students';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';
import {
  TEACHER_ANALYSIS_KIND,
  TeacherAnalysisError,
  validateTeacherAnalysis,
  type CreateTeacherAnalysis,
  type TeacherAnalysis,
  type TeacherAnalysisReport,
} from '@/lib/teacher/analysis';
import { loadStudyAttempts, zhongkaoStageId } from '@/lib/zhongkao/runtime';

const NOW = '2026-09-08T08:00:00.000Z';
const MATERIAL_ID = `mat_${'a'.repeat(26)}`;
const REQUEST: CreateTeacherAnalysis = {
  requestId: '13fe7cc0-4fd9-4ad4-8455-105c97352dd5',
  workKind: 'homework',
  subject: 'Math',
  title: 'Fictional algebra practice',
  workDate: '2026-09-08',
  teacherNotes: '',
  materials: [{ materialId: MATERIAL_ID, role: 'student_work' }],
};
const REPORT: TeacherAnalysisReport = {
  readiness: 'sufficient',
  observations: [
    {
      category: 'needs_verification',
      text: 'Verify the recorded equation before drawing conclusions.',
      citations: [{ sourceId: 'source-1', blockId: 'block-1', quote: '2x = 6; x = 4' }],
    },
  ],
  recommendations: [{ text: 'Review an additional independent attempt.', observationIndexes: [0] }],
  limitations: ['One piece of work cannot establish a persistent weakness.'],
};

beforeAll(() => vi.stubGlobal('IDBKeyRange', IDBKeyRange));

async function harness() {
  const options = {
    indexedDB: new IDBFactory(),
    dbName: `fictional-teacher-analysis-${Math.random()}`,
    payloadValidators: {
      ...APP_RUNTIME_PAYLOAD_VALIDATORS,
      [TEACHER_ANALYSIS_KIND]: validateTeacherAnalysis,
    },
  };
  const store = new BrowserRuntimeStore(options);
  const generate = vi.fn(async () => ({
    sources: [
      {
        sourceId: 'source-1',
        materialId: MATERIAL_ID,
        role: 'student_work' as const,
        name: 'fictional-homework.txt',
        mimeType: 'text/plain',
        sha256: 'a'.repeat(64),
        extractorId: 'fictional-text',
        extractorVersion: '1',
        ocr: false,
        blocks: [{ blockId: 'block-1', text: '2x = 6; x = 4' }],
      },
    ],
    report: structuredClone(REPORT),
    model: { providerId: 'fictional-provider', modelId: 'fictional-model' },
  }));
  const deps: TeacherAnalysisServiceDeps = {
    store,
    ownerId: 'fictional-teacher-a',
    now: () => NOW,
    generate,
  };
  const { student } = await createTeacherStudent(deps, {
    requestId: randomUUID(),
    nickname: 'Fictional analysis student',
    grade: null,
    examYear: null,
    region: null,
  });
  return { deps, store, options, generate, student, profileId: student.profile.profileId };
}

function edit(
  analysis: TeacherAnalysis,
  action: 'save_draft' | 'confirm_review' | 'withdraw',
  changes = {},
) {
  return {
    expectedUpdatedAt: analysis.updatedAt,
    action,
    report: analysis.report,
    teacherComment: analysis.teacherComment,
    ...changes,
  };
}

function wrappedStore(store: RuntimeStore, append: RuntimeStore['appendRecord']): RuntimeStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'appendRecord') return append;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('teacher analysis drafts with real runtime persistence', () => {
  it('persists source evidence and original output across reload without changing profile or attempts', async () => {
    const h = await harness();
    expect(await listTeacherAnalyses(h.deps, h.profileId)).toEqual([]);
    const result = await createTeacherAnalysis(h.deps, h.profileId, REQUEST);
    expect(result.replayed).toBe(false);
    expect(result.analysis.status).toBe('draft');
    expect(result.analysis.originalReport).toEqual(REPORT);
    expect(result.analysis).not.toHaveProperty('reviewedAt');
    const reloaded = { ...h.deps, store: new BrowserRuntimeStore(h.options) };
    expect(await getTeacherAnalysis(reloaded, h.profileId, result.analysis.analysisId)).toEqual(
      result.analysis,
    );
    expect(await listTeacherAnalyses(reloaded, h.profileId)).toEqual([result.analysis]);
    expect(await getTeacherStudent(h.deps, h.profileId)).toEqual(h.student);
    expect(
      await loadStudyAttempts(h.profileId, {
        store: h.store,
        learnerKey: resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
      }),
    ).toEqual([]);
  });

  it('replays a request before invoking the generator and preserves later teacher edits', async () => {
    const h = await harness();
    const { analysis } = await createTeacherAnalysis(h.deps, h.profileId, REQUEST);
    const saved = await updateTeacherAnalysis(
      h.deps,
      h.profileId,
      analysis.analysisId,
      edit(analysis, 'save_draft', { teacherComment: 'Fictional review note' }),
    );
    expect(
      await createTeacherAnalysis({ ...h.deps, generate: undefined }, h.profileId, REQUEST),
    ).toEqual({ analysis: saved, replayed: true });
    expect(h.generate).toHaveBeenCalledTimes(1);
    await expect(
      createTeacherAnalysis(h.deps, h.profileId, { ...REQUEST, title: 'Changed title' }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_CONFLICT' });
  });

  it('isolates both teacher and student partitions before generation', async () => {
    const h = await harness();
    const { analysis } = await createTeacherAnalysis(h.deps, h.profileId, REQUEST);
    const otherOwner = { ...h.deps, ownerId: 'fictional-teacher-b' };
    for (const operation of [
      () => listTeacherAnalyses(otherOwner, h.profileId),
      () => getTeacherAnalysis(otherOwner, h.profileId, analysis.analysisId),
      () =>
        updateTeacherAnalysis(
          otherOwner,
          h.profileId,
          analysis.analysisId,
          edit(analysis, 'withdraw'),
        ),
      () => createTeacherAnalysis(otherOwner, h.profileId, { ...REQUEST, requestId: randomUUID() }),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'ANALYSIS_NOT_FOUND' });
    const other = (
      await createTeacherStudent(h.deps, {
        requestId: randomUUID(),
        nickname: 'Fictional B',
        grade: null,
        examYear: null,
        region: null,
      })
    ).student;
    await expect(
      getTeacherAnalysis(h.deps, other.profile.profileId, analysis.analysisId),
    ).rejects.toMatchObject({ code: 'ANALYSIS_NOT_FOUND' });
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it('requires saved edits before confirmation and retains the original report through withdrawal', async () => {
    const h = await harness();
    const { analysis } = await createTeacherAnalysis(h.deps, h.profileId, REQUEST);
    const report = structuredClone(REPORT);
    report.observations[0].text =
      'Teacher corrected interpretation, still awaiting another attempt.';
    await expect(
      updateTeacherAnalysis(
        h.deps,
        h.profileId,
        analysis.analysisId,
        edit(analysis, 'confirm_review', { report }),
      ),
    ).rejects.toMatchObject({ code: 'ANALYSIS_CONFLICT' });
    const saved = await updateTeacherAnalysis(
      h.deps,
      h.profileId,
      analysis.analysisId,
      edit(analysis, 'save_draft', { report, teacherComment: 'Checked transcription.' }),
    );
    const reviewed = await updateTeacherAnalysis(
      h.deps,
      h.profileId,
      analysis.analysisId,
      edit(saved, 'confirm_review'),
    );
    expect(reviewed).toMatchObject({
      status: 'reviewed',
      originalReport: REPORT,
      report,
      reviewedAt: reviewed.updatedAt,
    });
    const withdrawn = await updateTeacherAnalysis(
      h.deps,
      h.profileId,
      analysis.analysisId,
      edit(reviewed, 'withdraw'),
    );
    expect(withdrawn).toMatchObject({
      status: 'withdrawn',
      sources: analysis.sources,
      originalReport: REPORT,
      model: analysis.model,
      reviewedAt: reviewed.reviewedAt,
    });
    expect((await listTeacherAnalyses(h.deps, h.profileId))[0].status).toBe('withdrawn');
    await expect(
      updateTeacherAnalysis(
        h.deps,
        h.profileId,
        analysis.analysisId,
        edit(withdrawn, 'save_draft'),
      ),
    ).rejects.toMatchObject({ code: 'ANALYSIS_CONFLICT' });
    const sessions = await h.store.listSessions(
      zhongkaoStageId(h.profileId),
      resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
    );
    const session = sessions.find((item) => item.kind === TEACHER_ANALYSIS_KIND)!;
    expect(await h.store.listRecords(session.id)).toHaveLength(4);
  });

  it('returns edited reviewed work to draft and advances timestamps with a fixed clock', async () => {
    const h = await harness();
    const { analysis } = await createTeacherAnalysis(h.deps, h.profileId, REQUEST);
    const reviewed = await updateTeacherAnalysis(
      h.deps,
      h.profileId,
      analysis.analysisId,
      edit(analysis, 'confirm_review'),
    );
    const draft = await updateTeacherAnalysis(
      h.deps,
      h.profileId,
      analysis.analysisId,
      edit(reviewed, 'save_draft', { teacherComment: 'Reopened for review' }),
    );
    expect(draft.status).toBe('draft');
    expect(draft).not.toHaveProperty('reviewedAt');
    expect(Date.parse(draft.updatedAt)).toBeGreaterThan(Date.parse(reviewed.updatedAt));
    await expect(
      updateTeacherAnalysis(h.deps, h.profileId, analysis.analysisId, edit(analysis, 'withdraw')),
    ).rejects.toMatchObject({ code: 'ANALYSIS_CONFLICT' });
  });

  it('commits one result for competing identical requests and one edit for a shared revision', async () => {
    const h = await harness();
    const results = await Promise.all([
      createTeacherAnalysis(h.deps, h.profileId, REQUEST),
      createTeacherAnalysis(h.deps, h.profileId, REQUEST),
    ]);
    expect(results[0].analysis).toEqual(results[1].analysis);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(await listTeacherAnalyses(h.deps, h.profileId)).toHaveLength(1);
    const analysis = results[0].analysis;
    const updates = await Promise.allSettled([
      updateTeacherAnalysis(
        h.deps,
        h.profileId,
        analysis.analysisId,
        edit(analysis, 'save_draft', { teacherComment: 'Edit A' }),
      ),
      updateTeacherAnalysis(
        h.deps,
        h.profileId,
        analysis.analysisId,
        edit(analysis, 'save_draft', { teacherComment: 'Edit B' }),
      ),
    ]);
    expect(updates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(updates.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'ANALYSIS_CONFLICT' },
    });
  });

  it('recovers append response loss without another stored result or a second model request', async () => {
    const h = await harness();
    let armed = true;
    h.deps.store = wrappedStore(h.store, async (record, options) => {
      const committed = await h.store.appendRecord(record, options);
      if (armed && record.id.startsWith('teacher-analysis-create:')) {
        armed = false;
        throw new Error('PRIVATE_STORAGE_DIAGNOSTIC');
      }
      return committed;
    });
    const created = await createTeacherAnalysis(h.deps, h.profileId, REQUEST);
    expect(created.analysis.status).toBe('draft');
    expect(await createTeacherAnalysis(h.deps, h.profileId, REQUEST)).toEqual({
      analysis: created.analysis,
      replayed: true,
    });
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(await listTeacherAnalyses(h.deps, h.profileId)).toHaveLength(1);
  });

  it('stores no report after failed generation or cancellation before and after extraction', async () => {
    const h = await harness();
    const controller = new AbortController();
    controller.abort(new Error('PRIVATE_ABORT_REASON'));
    await expect(
      createTeacherAnalysis(h.deps, h.profileId, REQUEST, controller.signal),
    ).rejects.toMatchObject({ code: 'ANALYSIS_CANCELED' });
    expect(h.generate).not.toHaveBeenCalled();
    const later = new AbortController();
    const generate = async () => {
      const output = await h.generate();
      later.abort();
      return output;
    };
    await expect(
      createTeacherAnalysis({ ...h.deps, generate }, h.profileId, REQUEST, later.signal),
    ).rejects.toMatchObject({ code: 'ANALYSIS_CANCELED' });
    await expect(
      createTeacherAnalysis(
        {
          ...h.deps,
          generate: async () => {
            throw new Error('PRIVATE_MODEL_ENDPOINT');
          },
        },
        h.profileId,
        REQUEST,
      ),
    ).rejects.toMatchObject({
      code: 'ANALYSIS_MODEL_UNAVAILABLE',
      message: 'ANALYSIS_MODEL_UNAVAILABLE',
    });
    expect(await listTeacherAnalyses(h.deps, h.profileId)).toEqual([]);
  });

  it('rejects unsupported request fields, forged quotations and source substitutions', async () => {
    const h = await harness();
    await expect(
      createTeacherAnalysis(h.deps, h.profileId, { ...REQUEST, ownerId: 'injected' }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_INPUT_INVALID' });
    const generated = await h.generate();
    generated.report.observations[0].citations[0].quote = 'A quote that does not exist';
    await expect(
      createTeacherAnalysis({ ...h.deps, generate: async () => generated }, h.profileId, REQUEST),
    ).rejects.toMatchObject({ code: 'ANALYSIS_OUTPUT_INVALID' });
    const { analysis } = await createTeacherAnalysis(h.deps, h.profileId, REQUEST);
    await expect(
      updateTeacherAnalysis(
        h.deps,
        h.profileId,
        analysis.analysisId,
        edit(analysis, 'save_draft', { report: generated.report }),
      ),
    ).rejects.toMatchObject({ code: 'ANALYSIS_INPUT_INVALID' });
    await expect(
      updateTeacherAnalysis(h.deps, h.profileId, analysis.analysisId, {
        ...edit(analysis, 'save_draft'),
        sources: [],
      }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_INPUT_INVALID' });
    expect(await getTeacherAnalysis(h.deps, h.profileId, analysis.analysisId)).toEqual(analysis);
  });

  it('enforces the per-student limit before generating an additional report', async () => {
    const h = await harness();
    for (let index = 0; index < 100; index += 1) {
      await createTeacherAnalysis(h.deps, h.profileId, { ...REQUEST, requestId: randomUUID() });
    }
    await expect(createTeacherAnalysis(h.deps, h.profileId, REQUEST)).rejects.toEqual(
      new TeacherAnalysisError('ANALYSIS_LIMIT_REACHED'),
    );
    expect(h.generate).toHaveBeenCalledTimes(100);
    expect(await listTeacherAnalyses(h.deps, h.profileId)).toHaveLength(100);
  }, 15_000);

  it.each([
    'changed-confirmed-report',
    'changed-confirmed-comment',
    'different-confirmation-time',
    'repeat-confirmation',
    'changed-withdrawn-report',
    'changed-withdrawn-comment',
    'dropped-withdrawn-review-time',
  ])('fails closed on a schema-valid but illegal history transition: %s', async (mutation) => {
    const h = await harness();
    let { analysis } = await createTeacherAnalysis(h.deps, h.profileId, REQUEST);
    if (mutation === 'repeat-confirmation' || mutation === 'dropped-withdrawn-review-time') {
      analysis = await updateTeacherAnalysis(
        h.deps,
        h.profileId,
        analysis.analysisId,
        edit(analysis, 'confirm_review'),
      );
    }
    const updatedAt = new Date(Date.parse(analysis.updatedAt) + 1).toISOString();
    const next: TeacherAnalysis = {
      ...analysis,
      status: mutation.includes('withdrawn') ? 'withdrawn' : 'reviewed',
      updatedAt,
      reviewedAt: mutation.includes('withdrawn') ? analysis.reviewedAt : updatedAt,
    };
    if (mutation.endsWith('report')) {
      next.report = structuredClone(next.report);
      next.report.observations[0].text = 'Changed without saving the draft first.';
    }
    if (mutation.endsWith('comment')) next.teacherComment = 'Changed without saving first.';
    if (mutation === 'different-confirmation-time') next.reviewedAt = analysis.createdAt;
    if (mutation === 'dropped-withdrawn-review-time') delete next.reviewedAt;
    expect(validateTeacherAnalysis(next).valid).toBe(true);
    const sessions = await h.store.listSessions(
      zhongkaoStageId(h.profileId),
      resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
    );
    const session = sessions.find((item) => item.kind === TEACHER_ANALYSIS_KIND)!;
    await h.store.appendRecord({
      id: `fictional-illegal-transition:${randomUUID()}`,
      sessionId: session.id,
      createdAt: updatedAt,
      payload: next,
    });
    await expect(listTeacherAnalyses(h.deps, h.profileId)).rejects.toMatchObject({
      code: 'ANALYSIS_STORAGE_CORRUPT',
    });
    await expect(
      getTeacherAnalysis(h.deps, h.profileId, analysis.analysisId),
    ).rejects.toMatchObject({ code: 'ANALYSIS_STORAGE_CORRUPT' });
  });
});
