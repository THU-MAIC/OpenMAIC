import { describe, expect, it } from 'vitest';

import {
  EXAM_ERROR_DIAGNOSIS_GENERATOR_VERSION,
  EXAM_ERROR_MODEL_POLICY_VERSION,
  EXAM_ERROR_OBSERVABLE_RULES_VERSION,
  EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS,
  EXAM_ERROR_SUGGESTION_KINDS,
  canonicalizeExamErrorSuggestionDrafts,
  canonicalizeExamErrorSuggestionQuestionDrafts,
  isExamErrorSuggestionTextSpanGrounded,
  parseExamErrorSuggestionCandidate,
  parseExamErrorSuggestionDraft,
  validateExamErrorSuggestionCandidate,
  validateExamErrorSuggestionDraft,
  validateExamErrorSuggestionQuestionDraft,
  type ExamErrorSuggestionDraftV1,
} from '@/lib/zhongkao/exam-error-suggestions';

function optionDraft(
  generationSource: 'deterministic_candidate' | 'model_candidate' = 'deterministic_candidate',
): ExamErrorSuggestionDraftV1 {
  return {
    kind: 'multiple_choice_set_mismatch_candidate',
    generationSource,
    candidateStatus: 'candidate',
    confidenceBand: 'high',
    evidence: [
      {
        evidenceType: 'option_set_difference',
        missingOptions: ['C', 'A'],
        extraOptions: ['D'],
      },
    ],
  };
}

describe('Exam observable error suggestion domain', () => {
  it('freezes versions and a closed non-authoritative taxonomy', () => {
    expect(EXAM_ERROR_OBSERVABLE_RULES_VERSION).toBe('exam-error-observable-rules:v1');
    expect(EXAM_ERROR_DIAGNOSIS_GENERATOR_VERSION).toBe('exam-error-diagnosis-generator:v1');
    expect(EXAM_ERROR_MODEL_POLICY_VERSION).toBe('exam-error-model-policy:v1');
    expect(EXAM_ERROR_SUGGESTION_CANDIDATE_STATUS).toBe('candidate');
    expect(EXAM_ERROR_SUGGESTION_KINDS).toEqual([
      'blank_response_observation_candidate',
      'no_response_observation_candidate',
      'response_format_mismatch_candidate',
      'single_choice_option_mismatch_candidate',
      'multiple_choice_set_mismatch_candidate',
      'numeric_sign_mismatch_candidate',
      'numeric_value_mismatch_candidate',
      'unit_error_candidate',
    ]);
    const forbidden = [
      'careless',
      'time_pressure',
      'anxiety',
      'attention_problem',
      'motivation_problem',
      'intelligence',
      'concept_error',
      'arithmetic_error',
    ];
    expect(EXAM_ERROR_SUGGESTION_KINDS.some((kind) => forbidden.includes(kind))).toBe(false);
  });

  it('strictly validates and canonicalizes structured evidence', () => {
    expect(parseExamErrorSuggestionDraft(optionDraft())).toEqual({
      ...optionDraft(),
      evidence: [
        {
          evidenceType: 'option_set_difference',
          missingOptions: ['A', 'C'],
          extraOptions: ['D'],
        },
      ],
    });
    expect(
      validateExamErrorSuggestionDraft({ ...optionDraft(), authoritative: true }),
    ).toMatchObject({ valid: false });
    expect(
      validateExamErrorSuggestionDraft({
        ...optionDraft(),
        kind: 'careless',
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateExamErrorSuggestionDraft({
        ...optionDraft(),
        candidateStatus: 'confirmed',
      }),
    ).toMatchObject({ valid: false });
  });

  it('requires evidence that mechanically matches each deterministic kind', () => {
    const cases = [
      {
        kind: 'blank_response_observation_candidate',
        evidence: [{ evidenceType: 'response_status', status: 'no_response' }],
      },
      {
        kind: 'single_choice_option_mismatch_candidate',
        evidence: [
          {
            evidenceType: 'option_set_difference',
            missingOptions: ['A', 'B'],
            extraOptions: ['C'],
          },
        ],
      },
      {
        kind: 'numeric_sign_mismatch_candidate',
        evidence: [{ evidenceType: 'numeric_difference', differenceKind: 'different_value' }],
      },
      {
        kind: 'response_format_mismatch_candidate',
        evidence: [{ evidenceType: 'numeric_difference', differenceKind: 'different_value' }],
      },
    ];
    for (const testCase of cases) {
      expect(
        validateExamErrorSuggestionDraft({
          ...testCase,
          generationSource: 'deterministic_candidate',
          candidateStatus: 'candidate',
          confidenceBand: 'high',
        }),
      ).toMatchObject({ valid: false });
    }
  });

  it('allows unit error only as a model candidate grounded on both sides', () => {
    const valid: ExamErrorSuggestionDraftV1 = {
      kind: 'unit_error_candidate',
      generationSource: 'model_candidate',
      candidateStatus: 'candidate',
      confidenceBand: 'low',
      evidence: [
        { evidenceType: 'text_span', source: 'question', text: '单位为 cm' },
        { evidenceType: 'text_span', source: 'response', text: '12 m' },
      ],
    };
    expect(validateExamErrorSuggestionDraft(valid)).toEqual({ valid: true });
    expect(
      validateExamErrorSuggestionDraft({ ...valid, generationSource: 'deterministic_candidate' }),
    ).toMatchObject({ valid: false });
    expect(
      validateExamErrorSuggestionDraft({ ...valid, evidence: valid.evidence.slice(0, 1) }),
    ).toMatchObject({
      valid: false,
    });
    expect(
      validateExamErrorSuggestionDraft({
        ...valid,
        evidence: [
          { evidenceType: 'text_span', source: 'question', text: '单位为 cm' },
          { evidenceType: 'numeric_difference', differenceKind: 'different_value' },
        ],
      }),
    ).toMatchObject({ valid: false });
  });

  it('grounds model text spans against only their declared confirmed source', () => {
    const sources = {
      questionText: '求长度，单位为 cm。',
      parentContext: '以下各题均填写单位。',
      responseText: '12 m',
    };
    expect(
      isExamErrorSuggestionTextSpanGrounded(
        { evidenceType: 'text_span', source: 'question', text: '单位为 cm' },
        sources,
      ),
    ).toBe(true);
    expect(
      isExamErrorSuggestionTextSpanGrounded(
        { evidenceType: 'text_span', source: 'response', text: '单位为 cm' },
        sources,
      ),
    ).toBe(false);
    expect(
      isExamErrorSuggestionTextSpanGrounded(
        { evidenceType: 'text_span', source: 'parent_context', text: '填写单位' },
        sources,
      ),
    ).toBe(true);
  });

  it('deduplicates exact semantics while retaining deterministic authority precedence', () => {
    const deterministic = optionDraft('deterministic_candidate');
    const model = { ...optionDraft('model_candidate'), confidenceBand: 'low' as const };
    expect(canonicalizeExamErrorSuggestionDrafts([model, deterministic])).toEqual([
      parseExamErrorSuggestionDraft(deterministic),
    ]);
  });

  it('keeps candidate identity and ordinal server-controlled and bounded', () => {
    const candidate = {
      ...optionDraft(),
      candidateId: `exam-error-suggestion:v1:${'a'.repeat(64)}`,
      ordinal: 0,
    };
    expect(validateExamErrorSuggestionCandidate(candidate)).toEqual({ valid: true });
    expect(parseExamErrorSuggestionCandidate(candidate)).toMatchObject({
      candidateStatus: 'candidate',
      ordinal: 0,
    });
    expect(validateExamErrorSuggestionCandidate({ ...candidate, ordinal: 3 })).toMatchObject({
      valid: false,
    });
    expect(validateExamErrorSuggestionCandidate({ ...candidate, verified: true })).toMatchObject({
      valid: false,
    });
  });

  it('accepts only incorrect question rows and enforces status/count closure', () => {
    const generated = {
      confirmedQuestionId: 'confirmed-question-2',
      assessmentOutcome: 'incorrect',
      generationStatus: 'generated',
      suggestions: [optionDraft()],
    };
    const none = {
      confirmedQuestionId: 'confirmed-question-1',
      assessmentOutcome: 'incorrect',
      generationStatus: 'no_suggestion',
      suggestions: [],
    };
    expect(canonicalizeExamErrorSuggestionQuestionDrafts([generated, none])).toEqual([
      none,
      { ...generated, suggestions: [parseExamErrorSuggestionDraft(optionDraft())] },
    ]);
    expect(
      validateExamErrorSuggestionQuestionDraft({ ...none, assessmentOutcome: 'correct' }),
    ).toMatchObject({ valid: false });
    expect(
      validateExamErrorSuggestionQuestionDraft({
        ...none,
        generationStatus: 'generated',
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateExamErrorSuggestionQuestionDraft({
        ...generated,
        generationStatus: 'no_suggestion',
      }),
    ).toMatchObject({ valid: false });
  });

  it('rejects malformed option differences and unsafe free text', () => {
    const mutations = [
      {
        ...optionDraft(),
        evidence: [
          {
            evidenceType: 'option_set_difference',
            missingOptions: ['A'],
            extraOptions: ['A'],
          },
        ],
      },
      {
        ...optionDraft(),
        evidence: [
          {
            evidenceType: 'option_set_difference',
            missingOptions: ['Z'],
            extraOptions: ['A'],
          },
        ],
      },
      {
        kind: 'unit_error_candidate',
        generationSource: 'model_candidate',
        candidateStatus: 'candidate',
        confidenceBand: 'low',
        evidence: [
          { evidenceType: 'text_span', source: 'question', text: '单位为 cm' },
          { evidenceType: 'text_span', source: 'response', text: '12\u202em' },
        ],
      },
    ];
    for (const mutation of mutations) {
      expect(validateExamErrorSuggestionDraft(mutation)).toMatchObject({ valid: false });
    }
  });
});
