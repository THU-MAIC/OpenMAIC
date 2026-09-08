import { describe, expect, it } from 'vitest';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  createTeacherAnalysisSchema,
  TEACHER_ANALYSIS_KIND,
  validateTeacherAnalysis,
  type TeacherAnalysis,
} from '@/lib/teacher/analysis';
import { isServerOnlyRuntimeKind } from '@/lib/zhongkao/runtime-kinds';

function fixture(): TeacherAnalysis {
  const report: TeacherAnalysis['report'] = {
    readiness: 'sufficient',
    observations: [
      {
        category: 'needs_verification',
        text: 'Check the fictional response against a scoring reference.',
        citations: [{ sourceId: 'source-1', blockId: 'block-1', quote: 'Response: x = 3.' }],
      },
    ],
    recommendations: [{ text: 'Ask the student to explain the step.', observationIndexes: [0] }],
    limitations: ['No answer key; independence is unknown.'],
  };
  return {
    schemaVersion: 1,
    analysisId: `teacher-analysis:v1:${'a'.repeat(64)}`,
    profileId: `teacher-student:v1:${'b'.repeat(64)}`,
    requestFingerprint: 'c'.repeat(64),
    request: {
      requestId: '13fe7cc0-4fd9-4ad4-8455-105c97352dd5',
      workKind: 'homework',
      subject: 'Math',
      title: 'Fictional homework',
      workDate: '2026-09-08',
      teacherNotes: '',
      materials: [{ materialId: `mat_${'0'.repeat(26)}`, role: 'student_work' }],
    },
    sources: [
      {
        sourceId: 'source-1',
        materialId: `mat_${'0'.repeat(26)}`,
        role: 'student_work',
        name: 'fictional.txt',
        mimeType: 'text/plain',
        sha256: 'd'.repeat(64),
        extractorId: 'plain-text',
        extractorVersion: '1',
        ocr: false,
        blocks: [{ blockId: 'block-1', text: 'Question: 2x = 6. Response: x = 3.' }],
      },
    ],
    report,
    originalReport: structuredClone(report),
    status: 'draft',
    model: { providerId: 'fictional', modelId: 'fictional-test' },
    createdAt: '2026-09-08T08:00:00.000Z',
    updatedAt: '2026-09-08T08:00:00.000Z',
    teacherComment: '',
  };
}

describe('student analysis evidence contract', () => {
  it('registers a separate protected record without adding attempts or scores', () => {
    const analysis = fixture();
    expect(APP_RUNTIME_PAYLOAD_VALIDATORS[TEACHER_ANALYSIS_KIND](analysis)).toEqual({
      valid: true,
    });
    expect(isServerOnlyRuntimeKind(TEACHER_ANALYSIS_KIND)).toBe(true);
    expect(validateTeacherAnalysis({ ...analysis, mastery: 100 }).valid).toBe(false);
  });

  it('requires student work, real dates, and unique selected material IDs', () => {
    const request = fixture().request;
    expect(createTeacherAnalysisSchema.safeParse(request).success).toBe(true);
    expect(
      createTeacherAnalysisSchema.safeParse({ ...request, workDate: '2026-02-30' }).success,
    ).toBe(false);
    expect(
      createTeacherAnalysisSchema.safeParse({
        ...request,
        materials: [{ ...request.materials[0], role: 'question_paper' }],
      }).success,
    ).toBe(false);
    expect(
      createTeacherAnalysisSchema.safeParse({
        ...request,
        materials: [...request.materials, ...request.materials],
      }).success,
    ).toBe(false);
  });

  it('rejects invented quotes, block IDs and material identities in either saved report', () => {
    for (const report of ['report', 'originalReport'] as const) {
      for (const change of [
        { quote: 'Made up answer.' },
        { blockId: 'missing' },
        { sourceId: 'missing' },
      ]) {
        const analysis = fixture();
        Object.assign(analysis[report].observations[0].citations[0], change);
        expect(validateTeacherAnalysis(analysis).valid).toBe(false);
      }
    }
  });

  it('rejects ambiguous sources and mismatched selected roles or IDs', () => {
    const changes: ((analysis: TeacherAnalysis) => void)[] = [
      (a) => a.sources.push(structuredClone(a.sources[0])),
      (a) => a.sources[0].blocks.push(structuredClone(a.sources[0].blocks[0])),
      (a) => {
        a.sources[0].role = 'answer_key';
      },
      (a) => {
        a.sources[0].materialId = `mat_${'1'.repeat(26)}`;
      },
    ];
    for (const change of changes) {
      const analysis = fixture();
      change(analysis);
      expect(validateTeacherAnalysis(analysis).valid).toBe(false);
    }
  });

  it('does not allow an answer key alone to support student performance', () => {
    const analysis = fixture();
    const answerKey = {
      ...structuredClone(analysis.sources[0]),
      sourceId: 'key',
      materialId: `mat_${'1'.repeat(26)}`,
      role: 'answer_key' as const,
    };
    analysis.sources.push(answerKey);
    analysis.request.materials.push({ materialId: answerKey.materialId, role: answerKey.role });
    analysis.report.observations[0].citations[0].sourceId = 'key';
    expect(validateTeacherAnalysis(analysis).valid).toBe(false);
    analysis.report.observations[0].category = 'learning_content';
    expect(validateTeacherAnalysis(analysis).valid).toBe(true);
  });

  it('requires explicit consistent review timestamps and bounds evidence size', () => {
    const analysis = fixture();
    analysis.status = 'reviewed';
    expect(validateTeacherAnalysis(analysis).valid).toBe(false);
    analysis.reviewedAt = analysis.updatedAt;
    expect(validateTeacherAnalysis(analysis).valid).toBe(true);
    analysis.reviewedAt = '2026-09-09T08:00:00.000Z';
    expect(validateTeacherAnalysis(analysis).valid).toBe(false);
    analysis.status = 'draft';
    analysis.reviewedAt = analysis.updatedAt;
    expect(validateTeacherAnalysis(analysis).valid).toBe(false);
    delete analysis.reviewedAt;
    analysis.sources[0].blocks.push({ blockId: 'too-large', text: 'x'.repeat(40_000) });
    expect(validateTeacherAnalysis(analysis).valid).toBe(false);
  });

  it('rejects recommendations attached to nonexistent observations', () => {
    const analysis = fixture();
    analysis.report.recommendations[0].observationIndexes = [1];
    expect(validateTeacherAnalysis(analysis).valid).toBe(false);
  });
});
