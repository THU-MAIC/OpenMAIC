import type { StudentProfile } from './profile';
import {
  assertValidation,
  finishValidation,
  isPlainRecord,
  validateIdentifier,
  type DomainValidationIssue,
} from './validation';

export type CurriculumMode = 'generic' | 'inferred' | 'confirmed';

export type CurriculumClaimType =
  | 'publisher'
  | 'textbook_title'
  | 'volume'
  | 'chapter'
  | 'page'
  | 'regional_exam_scope'
  | 'regional_exam_policy'
  | 'source_attribution'
  | 'generic_knowledge_point';

export type CurriculumClaim =
  | {
      type: Exclude<CurriculumClaimType, 'source_attribution'>;
    }
  | {
      type: 'source_attribution';
      source?: CurriculumSourceRef;
    };

export type CurriculumSourceRef = {
  type: 'uploaded_material' | 'user_input' | 'guardian_input' | 'study_attempt' | 'diagnostic';
  sourceId: string;
};

export type CurriculumSourceVerifier = (source: CurriculumSourceRef) => boolean;

export type CurriculumCapability =
  | 'classify_submitted_question'
  | 'explain_generic_middle_school_knowledge'
  | 'save_study_attempt';

export type CurriculumPolicyErrorCode =
  | 'GENERIC_CURRICULUM_CLAIM_FORBIDDEN'
  | 'CURRICULUM_SOURCE_NOT_VERIFIED';

export type CurriculumPolicyDecision =
  | { allowed: true }
  | { allowed: false; code: CurriculumPolicyErrorCode };

const GENERIC_FORBIDDEN_CLAIMS = new Set<CurriculumClaimType>([
  'publisher',
  'textbook_title',
  'volume',
  'chapter',
  'page',
  'regional_exam_scope',
  'regional_exam_policy',
]);

function isCurriculumSourceType(value: unknown): value is CurriculumSourceRef['type'] {
  return (
    value === 'uploaded_material' ||
    value === 'user_input' ||
    value === 'guardian_input' ||
    value === 'study_attempt' ||
    value === 'diagnostic'
  );
}

function isStructuredSourceRef(value: unknown): value is CurriculumSourceRef {
  if (!isPlainRecord(value)) return false;
  return (
    Object.keys(value).every((key) => key === 'type' || key === 'sourceId') &&
    isCurriculumSourceType(value.type) &&
    typeof value.sourceId === 'string' &&
    value.sourceId.trim().length > 0 &&
    value.sourceId === value.sourceId.trim()
  );
}

function verifySource(
  source: unknown,
  verifier: CurriculumSourceVerifier | undefined,
): source is CurriculumSourceRef {
  if (!isStructuredSourceRef(source) || !verifier) return false;
  try {
    return verifier(source) === true;
  } catch {
    return false;
  }
}

export function curriculumModeForSubject(
  profile: Pick<StudentProfile, 'textbookVersions'>,
  subjectId: string,
): CurriculumMode {
  const errors: DomainValidationIssue[] = [];
  validateIdentifier(subjectId, '/subjectId', errors);
  assertValidation(finishValidation(errors), 'ZHONGKAO_SUBJECT_ID_INVALID');

  const textbook = profile.textbookVersions[subjectId];
  if (!textbook || textbook.status === 'unknown') return 'generic';
  return textbook.status;
}

export function evaluateCurriculumClaim(
  mode: CurriculumMode,
  claim: CurriculumClaim,
  sourceVerifier?: CurriculumSourceVerifier,
): CurriculumPolicyDecision {
  if (mode === 'generic' && GENERIC_FORBIDDEN_CLAIMS.has(claim.type)) {
    return { allowed: false, code: 'GENERIC_CURRICULUM_CLAIM_FORBIDDEN' };
  }
  if (claim.type === 'source_attribution' && !verifySource(claim.source, sourceVerifier)) {
    return {
      allowed: false,
      code: 'CURRICULUM_SOURCE_NOT_VERIFIED',
    };
  }
  return { allowed: true };
}

export function assertCurriculumClaimAllowed(
  mode: CurriculumMode,
  claim: CurriculumClaim,
  sourceVerifier?: CurriculumSourceVerifier,
): void {
  const decision = evaluateCurriculumClaim(mode, claim, sourceVerifier);
  if (!decision.allowed) throw new Error(decision.code);
}

export function evaluateCurriculumCapability(
  _mode: CurriculumMode,
  _capability: CurriculumCapability,
): CurriculumPolicyDecision {
  return { allowed: true };
}
