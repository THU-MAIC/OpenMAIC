import { createHash } from 'node:crypto';

import { EXAM_DERIVATIVE_VERSION_MAX } from '@/lib/zhongkao/exam';

const STORAGE_KEY_ROOT = 'materials/v1';
const PORTABLE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

type MaterialIdentityDomain = 'owner' | 'session' | 'material' | 'exam' | 'examDocument';

const DOMAIN_PREFIX: Record<MaterialIdentityDomain, string> = {
  owner: 'own',
  session: 'ses',
  material: 'mat',
  exam: 'exm',
  examDocument: 'doc',
};

/** Build a portable, non-reversible segment from a server-authoritative identity. */
export function safeMaterialStorageNamespace(
  domain: MaterialIdentityDomain,
  authoritativeId: string,
): string {
  if (typeof authoritativeId !== 'string' || authoritativeId.length === 0) {
    throw new Error(`material ${domain} identity must be a non-empty string`);
  }
  const digest = createHash('sha256')
    .update(`openmaic:material-storage:${domain}:v1\0`, 'utf8')
    .update(authoritativeId, 'utf8')
    .digest('hex');
  return `${DOMAIN_PREFIX[domain]}_${digest}`;
}

export function assertPortableMaterialObjectKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.includes('\\')) {
    throw new Error('invalid material object key');
  }
  const segments = key.split('/');
  if (
    segments.some(
      (segment) =>
        !PORTABLE_SEGMENT.test(segment) ||
        segment.endsWith('.') ||
        WINDOWS_RESERVED_SEGMENT.test(segment),
    )
  ) {
    throw new Error('invalid material object key');
  }
}

function isPortableMaterialObjectKey(key: string): boolean {
  try {
    assertPortableMaterialObjectKey(key);
    return true;
  } catch {
    return false;
  }
}

function assertPortableLeaf(name: string): void {
  if (!PORTABLE_SEGMENT.test(name) || name.endsWith('.') || WINDOWS_RESERVED_SEGMENT.test(name)) {
    throw new Error('invalid material object name');
  }
}

export function ownerMaterialObjectKey(ownerId: string, materialId: string): string {
  return `${STORAGE_KEY_ROOT}/owners/${safeMaterialStorageNamespace(
    'owner',
    ownerId,
  )}/${safeMaterialStorageNamespace('material', materialId)}/raw`;
}

export function examSnapshotObjectPrefix(examSessionId: string): string {
  return `${STORAGE_KEY_ROOT}/exams/${safeMaterialStorageNamespace('exam', examSessionId)}/`;
}

function examDocumentObjectPrefix(examSessionId: string, examDocumentId: string): string {
  return `${examSnapshotObjectPrefix(examSessionId)}${safeMaterialStorageNamespace(
    'examDocument',
    examDocumentId,
  )}/`;
}

export function examSnapshotObjectKey(examSessionId: string, examDocumentId: string): string {
  return `${examDocumentObjectPrefix(examSessionId, examDocumentId)}raw`;
}

function assertArtifactVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1 || version > EXAM_DERIVATIVE_VERSION_MAX) {
    throw new Error('invalid exam artifact version');
  }
}

export function examDocumentArtifactObjectKey(
  examSessionId: string,
  examDocumentId: string,
  extractionVersion: number,
): string {
  assertArtifactVersion(extractionVersion);
  return `${examDocumentObjectPrefix(
    examSessionId,
    examDocumentId,
  )}extraction_v${extractionVersion}/document_artifact_v1.json`;
}

export function examQuestionCandidatesObjectKey(
  examSessionId: string,
  examDocumentId: string,
  extractionVersion: number,
  segmentationVersion: number,
): string {
  assertArtifactVersion(extractionVersion);
  assertArtifactVersion(segmentationVersion);
  return `${examDocumentObjectPrefix(
    examSessionId,
    examDocumentId,
  )}extraction_v${extractionVersion}/question_candidates_v${segmentationVersion}.json`;
}

export function examStudentResponseCandidatesObjectKey(
  examSessionId: string,
  captureVersion: number,
): string {
  assertArtifactVersion(captureVersion);
  return `${examSnapshotObjectPrefix(
    examSessionId,
  )}response_capture_v${captureVersion}/student_response_candidates_v1.json`;
}

export function examQuestionResponseMatchesObjectKey(
  examSessionId: string,
  captureVersion: number,
  matchingVersion: number,
): string {
  assertArtifactVersion(captureVersion);
  assertArtifactVersion(matchingVersion);
  return `${examSnapshotObjectPrefix(
    examSessionId,
  )}response_capture_v${captureVersion}/question_response_matches_v${matchingVersion}.json`;
}

export function examHumanReviewObjectKey(
  examSessionId: string,
  responseCaptureVersion: number,
  matchingVersion: number,
  reviewVersion: number,
): string {
  assertArtifactVersion(responseCaptureVersion);
  assertArtifactVersion(matchingVersion);
  assertArtifactVersion(reviewVersion);
  return `${examSnapshotObjectPrefix(
    examSessionId,
  )}response_capture_v${responseCaptureVersion}/matching_v${matchingVersion}/human_review_v${reviewVersion}/confirmed_review_facts_v1.json`;
}

export function isExamSnapshotObjectKey(examSessionId: string, key: string): boolean {
  return (
    isPortableMaterialObjectKey(key) && key.startsWith(examSnapshotObjectPrefix(examSessionId))
  );
}

export function sessionMaterialObjectPrefix(sessionId: string): string {
  return `${STORAGE_KEY_ROOT}/sessions/${safeMaterialStorageNamespace('session', sessionId)}/`;
}

export function sessionMaterialObjectKey(
  sessionId: string,
  materialId: string,
  name: string,
): string {
  assertPortableLeaf(name);
  return `${sessionMaterialObjectPrefix(sessionId)}${safeMaterialStorageNamespace(
    'material',
    materialId,
  )}/${name}`;
}

export function isSessionMaterialObjectKey(sessionId: string, key: string): boolean {
  return isPortableMaterialObjectKey(key) && key.startsWith(sessionMaterialObjectPrefix(sessionId));
}

/** Existing pre-v1 session objects remain readable when their session segment was portable. */
export function isLegacySessionMaterialObjectKey(sessionId: string, key: string): boolean {
  const prefix = legacySessionMaterialObjectPrefix(sessionId);
  return prefix !== null && isPortableMaterialObjectKey(key) && key.startsWith(prefix);
}

export function legacySessionMaterialObjectPrefix(sessionId: string): string | null {
  if (
    !PORTABLE_SEGMENT.test(sessionId) ||
    sessionId.endsWith('.') ||
    WINDOWS_RESERVED_SEGMENT.test(sessionId)
  ) {
    return null;
  }
  return `materials/${sessionId}/`;
}
