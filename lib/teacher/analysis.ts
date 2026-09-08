import { z } from 'zod';

export const TEACHER_ANALYSIS_KIND = 'teacherStudentAnalysis';
export const TEACHER_ANALYSIS_MODEL_STAGE = 'teacher-student-analysis' as const;
export const TEACHER_ANALYSIS_MAX_SOURCE_CHARS = 40_000;
export const TEACHER_ANALYSIS_MAX_FILES = 6;

const text = (max: number) => z.string().trim().min(1).max(max);
const materialId = z.string().regex(/^mat_[0-9abcdefghjkmnpqrstvwxyz]{26}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  );
export const analysisWorkKindSchema = z.enum([
  'homework',
  'monthly_exam',
  'midterm_exam',
  'final_exam',
  'other_exam',
]);
export const analysisSourceRoleSchema = z.enum([
  'student_work',
  'question_paper',
  'answer_key',
  'teaching_material',
]);
export const analysisCategorySchema = z.enum([
  'learning_content',
  'demonstrated',
  'needs_practice',
  'needs_verification',
]);

export const createTeacherAnalysisSchema = z
  .object({
    requestId: z.string().uuid(),
    workKind: analysisWorkKindSchema,
    subject: text(40),
    title: text(120),
    workDate: date,
    teacherNotes: z.string().trim().max(3_000),
    materials: z
      .array(z.object({ materialId, role: analysisSourceRoleSchema }).strict())
      .min(1)
      .max(TEACHER_ANALYSIS_MAX_FILES),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.materials.map((item) => item.materialId)).size !== value.materials.length) {
      context.addIssue({
        code: 'custom',
        path: ['materials'],
        message: 'Duplicate source material',
      });
    }
    if (!value.materials.some((item) => item.role === 'student_work')) {
      context.addIssue({
        code: 'custom',
        path: ['materials'],
        message: 'Student work is required',
      });
    }
  });

export const analysisSourceSchema = z
  .object({
    sourceId: text(40),
    materialId,
    role: analysisSourceRoleSchema,
    name: text(512),
    mimeType: text(150),
    sha256: hash,
    extractorId: text(80),
    extractorVersion: text(80),
    ocr: z.boolean(),
    blocks: z
      .array(
        z
          .object({
            blockId: text(100),
            text: text(TEACHER_ANALYSIS_MAX_SOURCE_CHARS),
            pageNumber: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

export const analysisCitationSchema = z
  .object({
    sourceId: text(40),
    blockId: text(100),
    quote: text(600),
  })
  .strict();

export const teacherAnalysisReportSchema = z
  .object({
    readiness: z.enum(['sufficient', 'insufficient']),
    observations: z
      .array(
        z
          .object({
            category: analysisCategorySchema,
            text: text(800),
            citations: z.array(analysisCitationSchema).min(1).max(4),
          })
          .strict(),
      )
      .max(16),
    recommendations: z
      .array(
        z
          .object({
            text: text(600),
            observationIndexes: z.array(z.number().int().min(0).max(15)).max(16),
          })
          .strict(),
      )
      .max(8),
    limitations: z.array(text(400)).min(1).max(8),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [index, recommendation] of value.recommendations.entries()) {
      if (recommendation.observationIndexes.some((item) => item >= value.observations.length)) {
        context.addIssue({
          code: 'custom',
          path: ['recommendations', index],
          message: 'Unknown observation',
        });
      }
    }
    if (value.readiness === 'sufficient' && value.observations.length === 0) {
      context.addIssue({ code: 'custom', path: ['observations'], message: 'Evidence is required' });
    }
  });

export const teacherAnalysisSchema = z
  .object({
    schemaVersion: z.literal(1),
    analysisId: z.string().regex(/^teacher-analysis:v1:[a-f0-9]{64}$/),
    profileId: z.string().regex(/^teacher-student:v1:[a-f0-9]{64}$/),
    request: createTeacherAnalysisSchema,
    requestFingerprint: hash,
    status: z.enum(['draft', 'reviewed', 'withdrawn']),
    sources: z.array(analysisSourceSchema).min(1).max(TEACHER_ANALYSIS_MAX_FILES),
    report: teacherAnalysisReportSchema,
    originalReport: teacherAnalysisReportSchema,
    model: z.object({ providerId: text(100), modelId: text(200) }).strict(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    reviewedAt: z.string().datetime().optional(),
    teacherComment: z.string().trim().max(3_000),
  })
  .strict();

export const updateTeacherAnalysisSchema = z
  .object({
    expectedUpdatedAt: z.string().datetime(),
    action: z.enum(['save_draft', 'confirm_review', 'withdraw']),
    report: teacherAnalysisReportSchema,
    teacherComment: z.string().trim().max(3_000),
  })
  .strict();

export type CreateTeacherAnalysis = z.infer<typeof createTeacherAnalysisSchema>;
export type TeacherAnalysisSource = z.infer<typeof analysisSourceSchema>;
export type TeacherAnalysisReport = z.infer<typeof teacherAnalysisReportSchema>;
export type TeacherAnalysis = z.infer<typeof teacherAnalysisSchema>;
export type UpdateTeacherAnalysis = z.infer<typeof updateTeacherAnalysisSchema>;
export type TeacherAnalysisCategory = z.infer<typeof analysisCategorySchema>;
export type TeacherAnalysisSourceRole = z.infer<typeof analysisSourceRoleSchema>;

/** A textual reference proves a quote exists, not that the model's interpretation is correct. */
export function validateAnalysisCitations(
  report: TeacherAnalysisReport,
  sources: TeacherAnalysisSource[],
): boolean {
  return report.observations.every(
    (observation) =>
      observation.citations.every((citation) => {
        const source = sources.find((item) => item.sourceId === citation.sourceId);
        const block = source?.blocks.find((item) => item.blockId === citation.blockId);
        return Boolean(block?.text.includes(citation.quote));
      }) &&
      (observation.category === 'learning_content' ||
        observation.citations.some(
          (citation) =>
            sources.find((item) => item.sourceId === citation.sourceId)?.role === 'student_work',
        )),
  );
}

export function validateTeacherAnalysis(value: unknown) {
  const parsed = teacherAnalysisSchema.safeParse(value);
  if (!parsed.success)
    return {
      valid: false as const,
      errors: parsed.error.issues.map((issue) => ({
        path: '/' + issue.path.join('/'),
        message: issue.message,
      })),
    };
  const analysis = parsed.data;
  const uniqueSources =
    new Set(analysis.sources.map((source) => source.sourceId)).size === analysis.sources.length &&
    new Set(analysis.sources.map((source) => source.materialId)).size === analysis.sources.length &&
    analysis.sources.every(
      (source) =>
        new Set(source.blocks.map((block) => block.blockId)).size === source.blocks.length,
    );
  const matchingMaterials =
    analysis.sources.length === analysis.request.materials.length &&
    analysis.request.materials.every((material) =>
      analysis.sources.some(
        (source) => source.materialId === material.materialId && source.role === material.role,
      ),
    );
  const sourceChars = analysis.sources.reduce(
    (sum, source) => sum + source.blocks.reduce((total, block) => total + block.text.length, 0),
    0,
  );
  if (
    !uniqueSources ||
    !matchingMaterials ||
    sourceChars > TEACHER_ANALYSIS_MAX_SOURCE_CHARS ||
    !validateAnalysisCitations(analysis.report, analysis.sources) ||
    !validateAnalysisCitations(analysis.originalReport, analysis.sources)
  ) {
    return {
      valid: false as const,
      errors: [{ path: '/sources', message: 'Invalid source evidence' }],
    };
  }
  if (
    Date.parse(analysis.updatedAt) < Date.parse(analysis.createdAt) ||
    (analysis.status === 'draft' && analysis.reviewedAt !== undefined) ||
    (analysis.status === 'reviewed' && analysis.reviewedAt === undefined) ||
    (analysis.reviewedAt !== undefined &&
      (Date.parse(analysis.reviewedAt) < Date.parse(analysis.createdAt) ||
        Date.parse(analysis.reviewedAt) > Date.parse(analysis.updatedAt)))
  ) {
    return {
      valid: false as const,
      errors: [{ path: '/status', message: 'Invalid review state' }],
    };
  }
  return { valid: true as const };
}

export type TeacherAnalysisErrorCode =
  | 'ANALYSIS_INPUT_INVALID'
  | 'ANALYSIS_ORIGIN_REJECTED'
  | 'ANALYSIS_NOT_FOUND'
  | 'ANALYSIS_CONFLICT'
  | 'ANALYSIS_LIMIT_REACHED'
  | 'ANALYSIS_UNAVAILABLE'
  | 'ANALYSIS_SOURCE_INVALID'
  | 'ANALYSIS_INPUT_TOO_LARGE'
  | 'ANALYSIS_OCR_REQUIRED'
  | 'ANALYSIS_EXTRACTION_FAILED'
  | 'ANALYSIS_MODEL_UNAVAILABLE'
  | 'ANALYSIS_OUTPUT_INVALID'
  | 'ANALYSIS_CANCELED'
  | 'ANALYSIS_STORAGE_CORRUPT';

const statuses: Record<TeacherAnalysisErrorCode, number> = {
  ANALYSIS_INPUT_INVALID: 400,
  ANALYSIS_ORIGIN_REJECTED: 403,
  ANALYSIS_NOT_FOUND: 404,
  ANALYSIS_CONFLICT: 409,
  ANALYSIS_LIMIT_REACHED: 409,
  ANALYSIS_UNAVAILABLE: 503,
  ANALYSIS_SOURCE_INVALID: 409,
  ANALYSIS_INPUT_TOO_LARGE: 413,
  ANALYSIS_OCR_REQUIRED: 422,
  ANALYSIS_EXTRACTION_FAILED: 422,
  ANALYSIS_MODEL_UNAVAILABLE: 503,
  ANALYSIS_OUTPUT_INVALID: 502,
  ANALYSIS_CANCELED: 408,
  ANALYSIS_STORAGE_CORRUPT: 409,
};

export class TeacherAnalysisError extends Error {
  readonly status: number;
  constructor(readonly code: TeacherAnalysisErrorCode) {
    super(code);
    this.name = 'TeacherAnalysisError';
    this.status = statuses[code];
  }
}
