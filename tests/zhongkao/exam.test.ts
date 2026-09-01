import { describe, expect, it } from 'vitest';

import {
  EXAM_TITLE_MAX_LENGTH,
  canonicalizeExamDocuments,
  examRequestSemanticFacts,
  parseExamCreateRequest,
  validateExamCreateRequest,
  type ExamCreateRequest,
  type ExamDocumentRole,
} from '@/lib/zhongkao/exam';
import { ExamError } from '@/lib/zhongkao/exam-errors';

const MATERIAL_IDS = {
  question_paper: `mat_${'0'.repeat(26)}`,
  student_response: `mat_${'1'.repeat(26)}`,
  answer_key: `mat_${'2'.repeat(26)}`,
} as const;

function request(overrides: Partial<ExamCreateRequest> = {}): ExamCreateRequest {
  return {
    clientRequestId: 'exam-request-001',
    profileId: 'student-alpha',
    subjectId: 'math',
    title: 'Fictional August practice exam',
    documents: [
      { role: 'question_paper', ownerMaterialId: MATERIAL_IDS.question_paper },
      { role: 'student_response', ownerMaterialId: MATERIAL_IDS.student_response },
      { role: 'answer_key', ownerMaterialId: MATERIAL_IDS.answer_key },
    ],
    ...overrides,
  };
}

describe('Exam create request', () => {
  it('normalizes title and canonicalizes role order', () => {
    const parsed = parseExamCreateRequest({
      ...request(),
      title: '  Fictional August practice exam  ',
      documents: request().documents.toReversed(),
    });

    expect(parsed.title).toBe('Fictional August practice exam');
    expect(parsed.documents.map((document) => document.role)).toEqual([
      'question_paper',
      'student_response',
      'answer_key',
    ]);
  });

  it('accepts the narrow one-document intake', () => {
    expect(
      validateExamCreateRequest({
        clientRequestId: 'exam-request-001',
        profileId: 'student-alpha',
        subjectId: 'math',
        documents: [{ role: 'question_paper', ownerMaterialId: MATERIAL_IDS.question_paper }],
      }),
    ).toEqual({ valid: true });
  });

  it('requires exactly one question paper', () => {
    expect(
      validateExamCreateRequest(
        request({
          documents: [{ role: 'student_response', ownerMaterialId: MATERIAL_IDS.student_response }],
        }),
      ).valid,
    ).toBe(false);
  });

  it.each(['question_paper', 'student_response', 'answer_key'] as const)(
    'rejects a duplicate %s role',
    (role) => {
      const otherRoles = (['question_paper', 'student_response', 'answer_key'] as const).filter(
        (candidate) => candidate !== role,
      );
      const roles = [role, role, ...otherRoles].slice(0, 3);
      expect(
        validateExamCreateRequest(
          request({
            documents: roles.map((candidate) => ({
              role: candidate,
              ownerMaterialId: MATERIAL_IDS[candidate],
            })),
          }),
        ).valid,
      ).toBe(false);
    },
  );

  it('rejects unknown roles and too many documents', () => {
    expect(
      validateExamCreateRequest({
        ...request(),
        documents: [
          ...request().documents,
          { role: 'worked_solution', ownerMaterialId: MATERIAL_IDS.answer_key },
        ],
      }).valid,
    ).toBe(false);
  });

  it('rejects unknown top-level and nested fields', () => {
    expect(validateExamCreateRequest({ ...request(), ownerId: 'forged-owner' }).valid).toBe(false);
    expect(
      validateExamCreateRequest({
        ...request(),
        documents: [
          {
            role: 'question_paper',
            ownerMaterialId: MATERIAL_IDS.question_paper,
            objectKey: 'forged/key',
          },
        ],
      }).valid,
    ).toBe(false);
  });

  it.each([
    ['profileId', ''],
    ['profileId', ' student-alpha'],
    ['subjectId', ''],
    ['subjectId', 'math\n'],
  ] as const)('rejects an invalid %s', (field, value) => {
    expect(validateExamCreateRequest(request({ [field]: value })).valid).toBe(false);
  });

  it('applies closed request-id syntax and length', () => {
    expect(validateExamCreateRequest(request({ clientRequestId: 'bad/request' })).valid).toBe(
      false,
    );
    expect(
      validateExamCreateRequest(request({ clientRequestId: `x${'a'.repeat(127)}` })).valid,
    ).toBe(true);
    expect(
      validateExamCreateRequest(request({ clientRequestId: `x${'a'.repeat(128)}` })).valid,
    ).toBe(false);
  });

  it('rejects malformed owner material ids', () => {
    expect(
      validateExamCreateRequest(
        request({
          documents: [{ role: 'question_paper', ownerMaterialId: 'material-from-client' }],
        }),
      ).valid,
    ).toBe(false);
  });

  it('bounds and sanitizes title metadata', () => {
    expect(validateExamCreateRequest(request({ title: '   ' })).valid).toBe(false);
    expect(validateExamCreateRequest(request({ title: 'unsafe\nname' })).valid).toBe(false);
    expect(
      validateExamCreateRequest(request({ title: 'x'.repeat(EXAM_TITLE_MAX_LENGTH) })).valid,
    ).toBe(true);
    expect(
      validateExamCreateRequest(request({ title: 'x'.repeat(EXAM_TITLE_MAX_LENGTH + 1) })).valid,
    ).toBe(false);
  });

  it('throws only the stable input code', () => {
    expect(() => parseExamCreateRequest({ ...request(), clientRequestId: '' })).toThrowError(
      new ExamError('EXAM_INPUT_INVALID'),
    );
  });

  it('builds order-independent semantic facts without the idempotency token', () => {
    const left = parseExamCreateRequest(request());
    const right = parseExamCreateRequest({
      ...request(),
      documents: request().documents.toReversed(),
    });
    expect(examRequestSemanticFacts(left)).toEqual(examRequestSemanticFacts(right));
    expect(examRequestSemanticFacts(left)).not.toHaveProperty('clientRequestId');
  });

  it('does not mutate caller-owned document arrays while canonicalizing', () => {
    const documents = request().documents.toReversed();
    const before = documents.map((document) => document.role);
    const canonical = canonicalizeExamDocuments(documents);
    expect(documents.map((document) => document.role)).toEqual(before);
    expect(canonical.map((document) => document.role)).toEqual([
      'question_paper',
      'student_response',
      'answer_key',
    ] satisfies ExamDocumentRole[]);
  });
});
