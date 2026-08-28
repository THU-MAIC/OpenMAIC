import { describe, expect, it } from 'vitest';

import {
  curriculumModeForSubject,
  evaluateCurriculumCapability,
  evaluateCurriculumClaim,
  type CurriculumClaim,
  type CurriculumSourceVerifier,
} from '@/lib/zhongkao/curriculum';
import {
  confirmObservedField,
  createInferredField,
  createUnknownField,
  type EvidenceRef,
} from '@/lib/zhongkao/observed-field';
import { createInitialStudentProfile, type TextbookVersion } from '@/lib/zhongkao/profile';

import { NOW } from './fixtures';

const uploadedEvidence: EvidenceRef = {
  type: 'uploaded_material',
  sourceId: 'fictional-material-1',
  createdAt: NOW,
};
const userEvidence: EvidenceRef = {
  type: 'user_input',
  sourceId: 'fictional-input-1',
  createdAt: NOW,
};
const trustedSources = new Set(['uploaded_material:fictional-material-1']);
const trustedSourceVerifier: CurriculumSourceVerifier = (source) =>
  trustedSources.has(`${source.type}:${source.sourceId}`);

describe('CurriculumMode', () => {
  it('uses generic mode when a subject has no textbook observation', () => {
    const profile = createInitialStudentProfile({ profileId: 'student-alpha', createdAt: NOW });
    expect(curriculumModeForSubject(profile, 'math')).toBe('generic');
  });

  it('derives each subject independently', () => {
    const profile = createInitialStudentProfile({ profileId: 'student-alpha', createdAt: NOW });
    profile.textbookVersions.math = confirmObservedField(
      createUnknownField<TextbookVersion>(NOW),
      { publisher: 'Fictional Press', title: 'Fictional Mathematics' },
      userEvidence,
      NOW,
    );
    profile.textbookVersions.physics = createInferredField(
      { publisher: 'Example Press', title: 'Example Physics' },
      0.7,
      [uploadedEvidence],
      NOW,
    );

    expect(curriculumModeForSubject(profile, 'math')).toBe('confirmed');
    expect(curriculumModeForSubject(profile, 'physics')).toBe('inferred');
    expect(curriculumModeForSubject(profile, 'chemistry')).toBe('generic');
  });
});

describe('typed curriculum policy', () => {
  it.each<CurriculumClaim>([
    { type: 'publisher' },
    { type: 'textbook_title' },
    { type: 'volume' },
    { type: 'chapter' },
    { type: 'page' },
    { type: 'regional_exam_scope' },
    { type: 'regional_exam_policy' },
  ])('rejects $type in generic mode without inventing textual scans', (claim) => {
    expect(evaluateCurriculumClaim('generic', claim)).toEqual({
      allowed: false,
      code: 'GENERIC_CURRICULUM_CLAIM_FORBIDDEN',
    });
  });

  it('defaults source attribution to denied without a valid trusted verifier', () => {
    const sourceClaim: CurriculumClaim = {
      type: 'source_attribution',
      source: { type: 'uploaded_material', sourceId: 'fictional-material-1' },
    };
    const notVerified = { allowed: false, code: 'CURRICULUM_SOURCE_NOT_VERIFIED' };

    expect(evaluateCurriculumClaim('generic', { type: 'source_attribution' })).toEqual(notVerified);
    expect(evaluateCurriculumClaim('generic', sourceClaim)).toEqual(notVerified);
    expect(
      evaluateCurriculumClaim(
        'generic',
        {
          type: 'source_attribution',
          source: { type: 'uploaded_material', sourceId: '   ' },
        },
        trustedSourceVerifier,
      ),
    ).toEqual(notVerified);
    expect(evaluateCurriculumClaim('generic', sourceClaim, () => false)).toEqual(notVerified);
    expect(
      evaluateCurriculumClaim('generic', sourceClaim, () => {
        throw new Error('fictional verifier outage');
      }),
    ).toEqual(notVerified);
  });

  it('allows only the exact source type and id confirmed by the verifier', () => {
    const verifiedClaim: CurriculumClaim = {
      type: 'source_attribution',
      source: { type: 'uploaded_material', sourceId: 'fictional-material-1' },
    };
    expect(evaluateCurriculumClaim('generic', verifiedClaim, trustedSourceVerifier)).toEqual({
      allowed: true,
    });
    expect(
      evaluateCurriculumClaim(
        'generic',
        {
          type: 'source_attribution',
          source: { type: 'uploaded_material', sourceId: 'fictional-material-2' },
        },
        trustedSourceVerifier,
      ),
    ).toMatchObject({ allowed: false, code: 'CURRICULUM_SOURCE_NOT_VERIFIED' });
    expect(
      evaluateCurriculumClaim(
        'generic',
        {
          type: 'source_attribution',
          source: { type: 'study_attempt', sourceId: 'fictional-material-1' },
        },
        trustedSourceVerifier,
      ),
    ).toMatchObject({ allowed: false, code: 'CURRICULUM_SOURCE_NOT_VERIFIED' });
  });

  it('requires source verification in inferred and confirmed curriculum modes', () => {
    const claim: CurriculumClaim = {
      type: 'source_attribution',
      source: { type: 'uploaded_material', sourceId: 'fictional-material-1' },
    };
    expect(evaluateCurriculumClaim('inferred', claim)).toMatchObject({
      allowed: false,
      code: 'CURRICULUM_SOURCE_NOT_VERIFIED',
    });
    expect(evaluateCurriculumClaim('confirmed', claim)).toMatchObject({
      allowed: false,
      code: 'CURRICULUM_SOURCE_NOT_VERIFIED',
    });
    expect(evaluateCurriculumClaim('inferred', claim, trustedSourceVerifier)).toEqual({
      allowed: true,
    });
    expect(evaluateCurriculumClaim('confirmed', claim, trustedSourceVerifier)).toEqual({
      allowed: true,
    });
  });

  it('still allows generic knowledge points', () => {
    expect(evaluateCurriculumClaim('generic', { type: 'generic_knowledge_point' })).toEqual({
      allowed: true,
    });
  });

  it('keeps the permitted generic capabilities typed', () => {
    expect(evaluateCurriculumCapability('generic', 'classify_submitted_question')).toEqual({
      allowed: true,
    });
    expect(
      evaluateCurriculumCapability('generic', 'explain_generic_middle_school_knowledge'),
    ).toEqual({ allowed: true });
    expect(evaluateCurriculumCapability('generic', 'save_study_attempt')).toEqual({
      allowed: true,
    });
  });
});
