import { describe, expect, it } from 'vitest';

import {
  applyInference,
  confirmObservedField,
  createInferredField,
  createUnknownField,
  isConfirmedField,
  validateObservedField,
  type EvidenceRef,
} from '@/lib/zhongkao/observed-field';
import { createInitialStudentProfile, validateStudentProfile } from '@/lib/zhongkao/profile';
import { pushIssue, type DomainValueValidator } from '@/lib/zhongkao/validation';

import { NOW } from './fixtures';

const LATER = '2026-08-29T08:00:00.000Z';
const inferenceEvidence: EvidenceRef = {
  type: 'diagnostic',
  sourceId: 'diagnostic-fictional-1',
  createdAt: LATER,
};
const userEvidence: EvidenceRef = {
  type: 'user_input',
  sourceId: 'input-fictional-1',
  createdAt: LATER,
};
const guardianEvidence: EvidenceRef = {
  type: 'guardian_input',
  sourceId: 'guardian-fictional-1',
  createdAt: LATER,
};
const projectSetupEvidence: EvidenceRef = {
  type: 'project_setup',
  sourceId: 'setup-fictional-1',
  createdAt: LATER,
};
const studyAttemptEvidence: EvidenceRef = {
  type: 'study_attempt',
  sourceId: 'attempt-fictional-1',
  createdAt: LATER,
};

const stringValue: DomainValueValidator = (value, path, errors) => {
  if (typeof value !== 'string' || value.length === 0) pushIssue(errors, path, 'expected string');
};

describe('zero-profile StudentProfile', () => {
  it('creates the confirmed known facts and leaves all other fields unknown or empty', () => {
    const profile = createInitialStudentProfile({ profileId: 'student-alpha', createdAt: NOW });

    expect(profile).toMatchObject({ schemaVersion: 1, profileId: 'student-alpha' });
    expect(profile.grade).toMatchObject({ status: 'confirmed', value: 9, confidence: 1 });
    expect(profile.examYear).toMatchObject({
      status: 'confirmed',
      value: 2027,
      confidence: 1,
    });
    expect(profile.grade.evidence).toHaveLength(1);
    expect(profile.examYear.evidence).toHaveLength(1);
    expect(profile.grade.evidence[0]?.type).toBe('project_setup');
    expect(profile.examYear.evidence[0]?.type).toBe('project_setup');
    expect(profile.displayName).toMatchObject({ status: 'unknown', value: null, confidence: null });
    expect(profile.region).toMatchObject({ status: 'unknown', value: null, confidence: null });
    expect(profile.preferredSubjects.status).toBe('unknown');
    expect(profile.weekdayMinutes.status).toBe('unknown');
    expect(profile.weekendMinutes.status).toBe('unknown');
    expect(profile.textbookVersions).toEqual({});
    expect(profile.baselineScores).toEqual({});
    expect(profile.targetScores).toEqual({});
    expect(JSON.stringify(profile)).not.toContain('同学');
    expect(validateStudentProfile(profile)).toEqual({ valid: true });
  });

  it('rejects invalid schema and observed-field states at the profile boundary', () => {
    const profile = createInitialStudentProfile({ profileId: 'student-alpha', createdAt: NOW });
    expect(validateStudentProfile({ ...profile, schemaVersion: 2 }).valid).toBe(false);
    expect(
      validateStudentProfile({
        ...profile,
        region: { ...profile.region, confidence: 0.5 },
      }).valid,
    ).toBe(false);
    expect(
      validateStudentProfile({
        ...profile,
        displayName: {
          ...profile.displayName,
          value: '\u540c\u5b66',
          status: 'confirmed',
          confidence: 1,
          evidence: [
            {
              type: 'user_input',
              sourceId: 'fictional-name-input',
              createdAt: NOW,
            },
          ],
        },
      }).valid,
    ).toBe(false);

    expect(validateStudentProfile({ ...profile, extraField: true }).valid).toBe(false);
  });

  it('accepts a valid per-subject textbook observation without leaking top-level keys', () => {
    const profile = createInitialStudentProfile({ profileId: 'student-alpha', createdAt: NOW });
    profile.textbookVersions.math = {
      value: { publisher: 'Fictional Press', title: 'Fictional Mathematics', volume: '9A' },
      status: 'confirmed',
      confidence: 1,
      evidence: [
        {
          type: 'user_input',
          sourceId: 'fictional-textbook-input',
          createdAt: NOW,
        },
      ],
      updatedAt: NOW,
    };

    expect(validateStudentProfile(profile)).toEqual({ valid: true });
  });

  it('limits project setup confirmation to fixed grade and exam-year facts', () => {
    const profile = createInitialStudentProfile({ profileId: 'student-alpha', createdAt: NOW });
    const projectEvidence = [{ type: 'project_setup', createdAt: NOW }];

    expect(
      validateStudentProfile({
        ...profile,
        region: {
          value: 'fictional-region',
          status: 'confirmed',
          confidence: 1,
          evidence: projectEvidence,
          updatedAt: NOW,
        },
      }).valid,
    ).toBe(false);
    expect(
      validateStudentProfile({
        ...profile,
        textbookVersions: {
          math: {
            value: { publisher: 'Fictional Press', title: 'Fictional Mathematics' },
            status: 'confirmed',
            confidence: 1,
            evidence: projectEvidence,
            updatedAt: NOW,
          },
        },
      }).valid,
    ).toBe(false);
    expect(
      validateStudentProfile({
        ...profile,
        grade: { ...profile.grade, value: 8 },
      }).valid,
    ).toBe(false);
    expect(
      validateStudentProfile({
        ...profile,
        examYear: { ...profile.examYear, value: 2028 },
      }).valid,
    ).toBe(false);
  });
});

describe('ObservedField transitions', () => {
  it('does not export a general confirmed-field constructor', async () => {
    const publicApi = await import('@/lib/zhongkao/observed-field');
    expect(publicApi).not.toHaveProperty('createConfirmedField');
  });

  it('constructs valid unknown, inferred, and confirmed fields', () => {
    expect(createUnknownField<string>(NOW)).toEqual({
      value: null,
      status: 'unknown',
      confidence: null,
      evidence: [],
      updatedAt: NOW,
    });
    const inferred = createInferredField('fictional-region', 0.6, [inferenceEvidence], LATER);
    expect(inferred.status).toBe('inferred');
    expect(isConfirmedField(inferred)).toBe(false);
    expect(validateObservedField(inferred, stringValue, '/candidate')).toEqual({ valid: true });
    expect(
      isConfirmedField(
        confirmObservedField(
          createUnknownField<string>(NOW),
          'fictional-region',
          userEvidence,
          LATER,
        ),
      ),
    ).toBe(true);
  });

  it('does not let ordinary inference overwrite a confirmed value', () => {
    const confirmed = confirmObservedField(
      createUnknownField<string>(NOW),
      'confirmed-region',
      userEvidence,
      NOW,
    );
    expect(applyInference(confirmed, 'model-guess', 0.9, inferenceEvidence, LATER)).toBe(confirmed);
  });

  it('accepts user or guardian confirmation and rejects automatic evidence', () => {
    const inferred = createInferredField('candidate', 0.7, [inferenceEvidence], NOW);
    expect(confirmObservedField(inferred, 'candidate', userEvidence, LATER)).toMatchObject({
      status: 'confirmed',
      value: 'candidate',
      confidence: 1,
    });
    expect(confirmObservedField(inferred, 'candidate', guardianEvidence, LATER)).toMatchObject({
      status: 'confirmed',
      value: 'candidate',
      confidence: 1,
    });
    for (const evidence of [projectSetupEvidence, studyAttemptEvidence, inferenceEvidence]) {
      expect(() => confirmObservedField(inferred, 'candidate', evidence, LATER)).toThrow(
        'ZHONGKAO_CONFIRMATION_EVIDENCE_REQUIRED',
      );
    }
  });

  it('rejects illegal unknown, inferred, and confirmed combinations', () => {
    const cases = [
      { value: 'guess', status: 'unknown', confidence: null, evidence: [], updatedAt: NOW },
      { value: 'guess', status: 'inferred', confidence: 0, evidence: [], updatedAt: NOW },
      {
        value: 'answer',
        status: 'confirmed',
        confidence: 0.9,
        evidence: [userEvidence],
        updatedAt: NOW,
      },
    ];
    for (const candidate of cases) {
      expect(validateObservedField(candidate, stringValue).valid).toBe(false);
    }

    expect(() => createInferredField('candidate', 0.7, [] as never, NOW)).toThrow(
      'ZHONGKAO_OBSERVED_FIELD_INVALID',
    );
  });
});
