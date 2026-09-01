import { createHash } from 'node:crypto';

import {
  examAuthoritativeAnswerKeyObjectKey,
  examQuestionAssessmentsObjectKey,
} from '@/lib/server/materials/object-keys';
import { MaterialByteStoreError } from '@/lib/server/materials/bytes';
import type { PublicExamGradingSummary } from '@/lib/zhongkao/exam';
import { ExamError, isExamError } from '@/lib/zhongkao/exam-errors';
import {
  EXAM_EVENT_SCHEMA_VERSION,
  type ExamAnswerKeyConfirmedEvent,
  type ExamAnswerKeyPlanFacts,
  type ExamAnswerKeyStartedEvent,
  type ExamGradingCompletedEvent,
  type ExamGradingPlanFacts,
  type ExamGradingStartedEvent,
} from '@/lib/zhongkao/exam-event';
import type { ConfirmedExamReviewFactsV1 } from '@/lib/zhongkao/exam-human-review';
import {
  toPublicExamSession,
  type ExamAnswerKeyState,
  type ExamGradingState,
} from '@/lib/zhongkao/exam-state';

import {
  EXAM_ANSWER_KEY_VERSION,
  EXAM_ASSESSMENT_VERSION,
  EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
  ExamPrivateGradingError,
  buildAuthoritativeExamAnswerKeyArtifact,
  buildExamQuestionAssessmentsArtifact,
  parseAuthoritativeExamAnswerKeyArtifact,
  parseExamQuestionAssessmentsArtifact,
  serializeAuthoritativeExamAnswerKeyArtifact,
  serializeExamQuestionAssessmentsArtifact,
  type AuthoritativeExamAnswerKeyArtifactV1,
  type ExamAnswerKeyRequestV1,
  type ExamQuestionAssessmentsArtifactV1,
} from './exam-grading-private';
import { resolveConfirmedExamReviewFactsFromRuntime } from './exam-human-review-service';
import {
  appendExamRuntimeEvent,
  createExamOperationFingerprint,
  deriveExamAnswerKeyArtifactRef,
  deriveExamAnswerKeyConfirmedOperationId,
  deriveExamAnswerKeyRef,
  deriveExamAnswerKeyStartedOperationId,
  deriveExamAssessmentArtifactRef,
  deriveExamEventId,
  deriveExamGradingCompletedOperationId,
  deriveExamGradingRef,
  deriveExamGradingStartedOperationId,
  loadExamRuntime,
  type ExamRuntimeSnapshot,
} from './exam-runtime';
import type { ExamServiceDeps } from './exam-service';

export interface ExamGradingServiceDeps extends ExamServiceDeps {
  buildAssessments?: typeof buildExamQuestionAssessmentsArtifact;
}

export interface ConfirmExamAnswerKeyAndGradeResult {
  examSessionId: string;
  grading: PublicExamGradingSummary;
  replayed: boolean;
}

interface PreparedAnswerKey {
  artifact: AuthoritativeExamAnswerKeyArtifactV1;
  bytes: Buffer;
  plan: ExamAnswerKeyPlanFacts;
}

interface PreparedAssessments {
  artifact: ExamQuestionAssessmentsArtifactV1;
  bytes: Buffer;
  plan: ExamGradingPlanFacts;
}

type GradingEvent =
  | ExamAnswerKeyStartedEvent
  | ExamAnswerKeyConfirmedEvent
  | ExamGradingStartedEvent
  | ExamGradingCompletedEvent;

function serviceNow(deps: ExamServiceDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function missingObject(error: unknown): boolean {
  return error instanceof MaterialByteStoreError && error.code === 'ENOENT';
}

function requireGradingReady(snapshot: ExamRuntimeSnapshot): void {
  if (snapshot.state.status === 'deleting' || snapshot.state.status === 'deleted') {
    throw new ExamError('EXAM_NOT_FOUND');
  }
  if (
    snapshot.state.status !== 'ready_for_extraction' ||
    snapshot.state.humanReview?.status !== 'confirmed' ||
    !snapshot.state.humanReview.reviewArtifact
  ) {
    throw new ExamError('EXAM_GRADING_NOT_READY');
  }
}

function mapPrivateError(error: unknown): ExamError {
  if (!(error instanceof ExamPrivateGradingError)) return new ExamError('EXAM_GRADING_FAILED');
  switch (error.code) {
    case 'EXAM_ANSWER_KEY_INPUT_INVALID':
      return new ExamError('EXAM_ANSWER_KEY_INPUT_INVALID');
    case 'EXAM_ANSWER_KEY_INCOMPLETE':
      return new ExamError('EXAM_ANSWER_KEY_INCOMPLETE');
    case 'EXAM_ANSWER_KEY_ARTIFACT_CORRUPT':
      return new ExamError('EXAM_ANSWER_KEY_ARTIFACT_CORRUPT');
    case 'EXAM_ASSESSMENT_ARTIFACT_CORRUPT':
      return new ExamError('EXAM_ASSESSMENT_ARTIFACT_CORRUPT');
    case 'EXAM_ANSWER_KEY_SOURCE_INVALID':
      return new ExamError('EXAM_GRADING_NOT_READY');
    case 'EXAM_GRADING_SOURCE_INVALID':
    case 'EXAM_GRADING_FAILED':
      return new ExamError('EXAM_GRADING_FAILED');
  }
}

function answerKeyRequestFromArtifact(
  artifact: AuthoritativeExamAnswerKeyArtifactV1,
): ExamAnswerKeyRequestV1 {
  return {
    schemaVersion: 1,
    entries: artifact.entries.map((entry) => {
      if (entry.type === 'single_choice') {
        return {
          confirmedQuestionId: entry.confirmedQuestionId,
          type: entry.type,
          expectedOptionId: entry.correctOptionId,
        };
      }
      if (entry.type === 'multiple_choice') {
        return {
          confirmedQuestionId: entry.confirmedQuestionId,
          type: entry.type,
          expectedOptionIds: [...entry.correctOptionIds],
        };
      }
      if (entry.type === 'numeric') {
        return {
          confirmedQuestionId: entry.confirmedQuestionId,
          type: entry.type,
          expectedValue: entry.expectedValue,
        };
      }
      if (entry.type === 'exact_short_answer') {
        return {
          confirmedQuestionId: entry.confirmedQuestionId,
          type: entry.type,
          acceptedAnswers: [...entry.acceptedAnswers],
        };
      }
      return {
        confirmedQuestionId: entry.confirmedQuestionId,
        type: entry.type,
        reason: entry.reason,
      };
    }),
  };
}

function answerKeyPlanMatches(state: ExamAnswerKeyState, plan: ExamAnswerKeyPlanFacts): boolean {
  return (
    state.answerKeyVersion === plan.answerKeyVersion &&
    state.reviewVersion === plan.reviewVersion &&
    state.reviewArtifactRef === plan.reviewArtifactRef &&
    state.sourceReviewArtifactFingerprint === plan.sourceReviewArtifactFingerprint &&
    state.answerKeySemanticFingerprint === plan.answerKeySemanticFingerprint &&
    state.answerKeyRef === plan.answerKeyRef &&
    state.answerKeyArtifactRef === plan.answerKeyArtifactRef
  );
}

function gradingPlanMatches(state: ExamGradingState, plan: ExamGradingPlanFacts): boolean {
  return (
    state.gradingVersion === plan.gradingVersion &&
    state.gradingAlgorithmVersion === plan.gradingAlgorithmVersion &&
    state.reviewVersion === plan.reviewVersion &&
    state.reviewArtifactRef === plan.reviewArtifactRef &&
    state.sourceReviewArtifactFingerprint === plan.sourceReviewArtifactFingerprint &&
    state.answerKeyVersion === plan.answerKeyVersion &&
    state.answerKeyRef === plan.answerKeyRef &&
    state.answerKeyArtifactRef === plan.answerKeyArtifactRef &&
    state.sourceAnswerKeyArtifactFingerprint === plan.sourceAnswerKeyArtifactFingerprint &&
    state.gradingRef === plan.gradingRef &&
    state.assessmentArtifactRef === plan.assessmentArtifactRef
  );
}

function prepareAnswerKey(
  snapshot: ExamRuntimeSnapshot,
  confirmedReview: ConfirmedExamReviewFactsV1,
  input: unknown,
): PreparedAnswerKey {
  requireGradingReady(snapshot);
  const review = snapshot.state.humanReview!;
  const reviewArtifact = review.reviewArtifact!;
  let artifact: AuthoritativeExamAnswerKeyArtifactV1;
  let bytes: Buffer;
  try {
    artifact = buildAuthoritativeExamAnswerKeyArtifact({
      examSessionId: snapshot.state.examSessionId,
      subjectId: snapshot.state.subjectId,
      confirmedReview,
      confirmedReviewArtifactSha256: reviewArtifact.sha256,
      request: input,
    });
    bytes = serializeAuthoritativeExamAnswerKeyArtifact(artifact);
  } catch (error) {
    throw mapPrivateError(error);
  }
  const refInput = {
    examSessionId: snapshot.state.examSessionId,
    answerKeyVersion: EXAM_ANSWER_KEY_VERSION,
    reviewVersion: review.reviewVersion,
    reviewArtifactRef: review.reviewArtifactRef,
    sourceReviewArtifactFingerprint: reviewArtifact.sha256,
  } as const;
  const answerKeyRef = deriveExamAnswerKeyRef(refInput);
  const plan: ExamAnswerKeyPlanFacts = {
    answerKeyVersion: EXAM_ANSWER_KEY_VERSION,
    reviewVersion: review.reviewVersion,
    reviewArtifactRef: review.reviewArtifactRef,
    sourceReviewArtifactFingerprint: reviewArtifact.sha256,
    answerKeySemanticFingerprint: artifact.semanticFingerprint,
    answerKeyRef,
    answerKeyArtifactRef: deriveExamAnswerKeyArtifactRef(answerKeyRef),
  };
  if (artifact.answerKeyRef !== plan.answerKeyRef) {
    throw new ExamError('EXAM_ANSWER_KEY_ARTIFACT_CORRUPT');
  }
  const persisted = snapshot.state.answerKey;
  if (persisted && !answerKeyPlanMatches(persisted, plan)) {
    throw new ExamError('EXAM_ANSWER_KEY_CONFLICT');
  }
  return { artifact, bytes, plan };
}

function prepareAssessments(
  deps: ExamGradingServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  confirmedReview: ConfirmedExamReviewFactsV1,
  answerKey: AuthoritativeExamAnswerKeyArtifactV1,
  answerKeyBytes: Buffer,
): PreparedAssessments {
  const answerKeyState = snapshot.state.answerKey;
  const answerKeyFact = answerKeyState?.answerKeyArtifact;
  if (answerKeyState?.status !== 'confirmed' || !answerKeyFact) {
    throw new ExamError('EXAM_GRADING_NOT_READY');
  }
  let artifact: ExamQuestionAssessmentsArtifactV1;
  let bytes: Buffer;
  try {
    artifact = (deps.buildAssessments ?? buildExamQuestionAssessmentsArtifact)({
      confirmedReview,
      answerKey,
    });
    bytes = serializeExamQuestionAssessmentsArtifact(artifact);
  } catch (error) {
    throw mapPrivateError(error);
  }
  const refInput = {
    examSessionId: snapshot.state.examSessionId,
    gradingVersion: EXAM_ASSESSMENT_VERSION,
    gradingAlgorithmVersion: EXAM_OBJECTIVE_GRADING_ALGORITHM_VERSION,
    reviewVersion: answerKeyState.reviewVersion,
    reviewArtifactRef: answerKeyState.reviewArtifactRef,
    sourceReviewArtifactFingerprint: answerKeyState.sourceReviewArtifactFingerprint,
    answerKeyVersion: answerKeyState.answerKeyVersion,
    answerKeyRef: answerKeyState.answerKeyRef,
    answerKeyArtifactRef: answerKeyState.answerKeyArtifactRef,
    sourceAnswerKeyArtifactFingerprint: sha256(answerKeyBytes),
  } as const;
  const gradingRef = deriveExamGradingRef(refInput);
  const plan: ExamGradingPlanFacts = {
    ...refInput,
    gradingRef,
    assessmentArtifactRef: deriveExamAssessmentArtifactRef(gradingRef),
  };
  const persisted = snapshot.state.grading;
  if (persisted && !gradingPlanMatches(persisted, plan)) {
    throw new ExamError('EXAM_GRADING_CONFLICT');
  }
  if (
    artifact.examSessionId !== snapshot.state.examSessionId ||
    artifact.answerKeyRef !== answerKey.answerKeyRef ||
    artifact.answerKeySemanticFingerprint !== answerKey.semanticFingerprint ||
    artifact.answerKeyArtifactSha256 !== plan.sourceAnswerKeyArtifactFingerprint
  ) {
    throw new ExamError('EXAM_ASSESSMENT_ARTIFACT_CORRUPT');
  }
  return { artifact, bytes, plan };
}

function answerKeyObjectKey(snapshot: ExamRuntimeSnapshot): string {
  const state = snapshot.state.answerKey;
  if (!state) throw new ExamError('EXAM_GRADING_NOT_READY');
  return examAuthoritativeAnswerKeyObjectKey(snapshot.state.examSessionId, state.answerKeyVersion);
}

function assessmentObjectKey(snapshot: ExamRuntimeSnapshot): string {
  const state = snapshot.state.grading;
  if (!state) throw new ExamError('EXAM_GRADING_NOT_READY');
  return examQuestionAssessmentsObjectKey(snapshot.state.examSessionId, state.gradingVersion);
}

async function readOptionalObject(
  deps: ExamServiceDeps,
  key: string,
  errorCode:
    | 'EXAM_GRADING_FAILED'
    | 'EXAM_ANSWER_KEY_ARTIFACT_CORRUPT'
    | 'EXAM_ASSESSMENT_ARTIFACT_CORRUPT',
): Promise<Buffer | undefined> {
  try {
    return await deps.byteStore.get(key);
  } catch (error) {
    if (missingObject(error)) return undefined;
    throw new ExamError(errorCode);
  }
}

async function putAndVerifyArtifact(
  deps: ExamServiceDeps,
  key: string,
  expected: Buffer,
  conflictCode: 'EXAM_ANSWER_KEY_CONFLICT' | 'EXAM_GRADING_CONFLICT',
): Promise<void> {
  const existing = await readOptionalObject(deps, key, 'EXAM_GRADING_FAILED');
  if (existing) {
    if (!existing.equals(expected)) throw new ExamError(conflictCode);
    return;
  }
  try {
    await deps.byteStore.put(key, expected, 'application/json');
  } catch {
    const recovered = await readOptionalObject(deps, key, 'EXAM_GRADING_FAILED').catch(
      () => undefined,
    );
    if (!recovered) throw new ExamError('EXAM_GRADING_FAILED');
    if (!recovered.equals(expected)) throw new ExamError(conflictCode);
  }
  const readBack = await readOptionalObject(deps, key, 'EXAM_GRADING_FAILED');
  if (!readBack) throw new ExamError('EXAM_GRADING_FAILED');
  if (!readBack.equals(expected)) throw new ExamError(conflictCode);
}

function baseEvent(deps: ExamServiceDeps, snapshot: ExamRuntimeSnapshot, operationId: string) {
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    createdAt: serviceNow(deps),
    operationId,
  } as const;
}

function answerKeyStartedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  plan: ExamAnswerKeyPlanFacts,
): ExamAnswerKeyStartedEvent {
  const operationId = deriveExamAnswerKeyStartedOperationId(
    snapshot.state.examSessionId,
    plan.answerKeyVersion,
  );
  const facts = {
    action: 'exam_answer_key_started',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    ...plan,
  } as const;
  return {
    ...baseEvent(deps, snapshot, operationId),
    eventType: 'exam_answer_key_started',
    operationFingerprint: createExamOperationFingerprint(facts),
    ...plan,
  };
}

function answerKeyConfirmedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  prepared: PreparedAnswerKey,
): ExamAnswerKeyConfirmedEvent {
  const operationId = deriveExamAnswerKeyConfirmedOperationId(
    snapshot.state.examSessionId,
    prepared.plan.answerKeyVersion,
  );
  const objectiveEntryCount = prepared.artifact.entries.filter(
    (entry) => entry.type !== 'unassessed',
  ).length;
  const artifactFacts = {
    artifactByteLength: prepared.bytes.byteLength,
    artifactSha256: sha256(prepared.bytes),
    entryCount: prepared.artifact.entryCount,
    objectiveEntryCount,
    unassessedEntryCount: prepared.artifact.entryCount - objectiveEntryCount,
  } as const;
  const facts = {
    action: 'exam_answer_key_confirmed',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    ...prepared.plan,
    ...artifactFacts,
  } as const;
  return {
    ...baseEvent(deps, snapshot, operationId),
    eventType: 'exam_answer_key_confirmed',
    operationFingerprint: createExamOperationFingerprint(facts),
    ...prepared.plan,
    ...artifactFacts,
  };
}

function gradingStartedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  plan: ExamGradingPlanFacts,
): ExamGradingStartedEvent {
  const operationId = deriveExamGradingStartedOperationId(
    snapshot.state.examSessionId,
    plan.gradingVersion,
  );
  const facts = {
    action: 'exam_grading_started',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    ...plan,
  } as const;
  return {
    ...baseEvent(deps, snapshot, operationId),
    eventType: 'exam_grading_started',
    operationFingerprint: createExamOperationFingerprint(facts),
    ...plan,
  };
}

function gradingCompletedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  prepared: PreparedAssessments,
): ExamGradingCompletedEvent {
  const operationId = deriveExamGradingCompletedOperationId(
    snapshot.state.examSessionId,
    prepared.plan.gradingVersion,
  );
  const artifactFacts = {
    artifactByteLength: prepared.bytes.byteLength,
    artifactSha256: sha256(prepared.bytes),
    assessmentCount: prepared.artifact.assessmentCount,
    evaluatedCount: prepared.artifact.evaluatedCount,
    correctCount: prepared.artifact.correctCount,
    incorrectCount: prepared.artifact.incorrectCount,
    unassessedCount: prepared.artifact.unassessedCount,
  } as const;
  const facts = {
    action: 'exam_grading_completed',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    ...prepared.plan,
    ...artifactFacts,
  } as const;
  return {
    ...baseEvent(deps, snapshot, operationId),
    eventType: 'exam_grading_completed',
    operationFingerprint: createExamOperationFingerprint(facts),
    ...prepared.plan,
    ...artifactFacts,
  };
}

async function appendGradingEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  event: GradingEvent,
): Promise<ExamRuntimeSnapshot> {
  try {
    return (
      await appendExamRuntimeEvent(deps, {
        event,
        expectedRevision: snapshot.state.revision,
      })
    ).snapshot;
  } catch (error) {
    if (isExamError(error)) throw error;
    throw new ExamError('EXAM_GRADING_FAILED');
  }
}

function answerKeyMatchesRuntime(
  artifact: AuthoritativeExamAnswerKeyArtifactV1,
  canonicalBytes: Buffer,
  confirmedReview: ConfirmedExamReviewFactsV1,
  snapshot: ExamRuntimeSnapshot,
): boolean {
  const state = snapshot.state.answerKey;
  const fact = state?.answerKeyArtifact;
  const review = snapshot.state.humanReview;
  const reviewFact = review?.reviewArtifact;
  return Boolean(
    state &&
    state.status === 'confirmed' &&
    fact &&
    review &&
    review.status === 'confirmed' &&
    reviewFact &&
    artifact.examSessionId === snapshot.state.examSessionId &&
    artifact.subjectId === snapshot.state.subjectId &&
    artifact.answerKeyVersion === state.answerKeyVersion &&
    artifact.answerKeyRef === state.answerKeyRef &&
    artifact.semanticFingerprint === state.answerKeySemanticFingerprint &&
    artifact.sourceReview.reviewRef === confirmedReview.reviewRef &&
    artifact.sourceReview.reviewArtifactRef === review.reviewArtifactRef &&
    artifact.sourceReview.reviewArtifactSha256 === reviewFact.sha256 &&
    artifact.sourceReview.reviewVersion === review.reviewVersion &&
    artifact.sourceReview.decisionSemanticFingerprint ===
      confirmedReview.decisionSemanticFingerprint &&
    canonicalBytes.byteLength === fact.byteLength &&
    sha256(canonicalBytes) === fact.sha256 &&
    artifact.entryCount === fact.entryCount &&
    artifact.entries.filter((entry) => entry.type === 'unassessed').length ===
      fact.unassessedEntryCount,
  );
}

export async function resolveAuthoritativeExamAnswerKeyFromRuntime(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  confirmedReview?: ConfirmedExamReviewFactsV1,
): Promise<AuthoritativeExamAnswerKeyArtifactV1> {
  requireGradingReady(snapshot);
  const state = snapshot.state.answerKey;
  const fact = state?.answerKeyArtifact;
  if (!state || state.status !== 'confirmed' || !fact) {
    throw new ExamError('EXAM_GRADING_NOT_READY');
  }
  const review =
    confirmedReview ?? (await resolveConfirmedExamReviewFactsFromRuntime(deps, snapshot));
  const bytes = await readOptionalObject(
    deps,
    answerKeyObjectKey(snapshot),
    'EXAM_ANSWER_KEY_ARTIFACT_CORRUPT',
  );
  if (!bytes || bytes.byteLength !== fact.byteLength || sha256(bytes) !== fact.sha256) {
    throw new ExamError('EXAM_ANSWER_KEY_ARTIFACT_CORRUPT');
  }
  let artifact: AuthoritativeExamAnswerKeyArtifactV1;
  let canonicalBytes: Buffer;
  let expectedBytes: Buffer;
  try {
    artifact = parseAuthoritativeExamAnswerKeyArtifact(bytes);
    canonicalBytes = serializeAuthoritativeExamAnswerKeyArtifact(artifact);
    expectedBytes = serializeAuthoritativeExamAnswerKeyArtifact(
      buildAuthoritativeExamAnswerKeyArtifact({
        examSessionId: snapshot.state.examSessionId,
        subjectId: snapshot.state.subjectId,
        confirmedReview: review,
        confirmedReviewArtifactSha256: snapshot.state.humanReview!.reviewArtifact!.sha256,
        request: answerKeyRequestFromArtifact(artifact),
      }),
    );
  } catch (error) {
    if (error instanceof ExamPrivateGradingError) {
      throw new ExamError('EXAM_ANSWER_KEY_ARTIFACT_CORRUPT');
    }
    throw new ExamError('EXAM_ANSWER_KEY_ARTIFACT_CORRUPT');
  }
  if (
    !bytes.equals(canonicalBytes) ||
    !bytes.equals(expectedBytes) ||
    !answerKeyMatchesRuntime(artifact, canonicalBytes, review, snapshot)
  ) {
    throw new ExamError('EXAM_ANSWER_KEY_ARTIFACT_CORRUPT');
  }
  return artifact;
}

export async function resolveAuthoritativeExamAnswerKey(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<AuthoritativeExamAnswerKeyArtifactV1> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    return resolveAuthoritativeExamAnswerKeyFromRuntime(deps, snapshot);
  });
}

function assessmentsMatchRuntime(
  artifact: ExamQuestionAssessmentsArtifactV1,
  canonicalBytes: Buffer,
  answerKey: AuthoritativeExamAnswerKeyArtifactV1,
  snapshot: ExamRuntimeSnapshot,
): boolean {
  const grading = snapshot.state.grading;
  const fact = grading?.assessmentArtifact;
  const keyFact = snapshot.state.answerKey?.answerKeyArtifact;
  return Boolean(
    grading &&
    grading.status === 'completed' &&
    fact &&
    keyFact &&
    artifact.examSessionId === snapshot.state.examSessionId &&
    artifact.assessmentVersion === grading.gradingVersion &&
    artifact.gradingAlgorithmVersion === grading.gradingAlgorithmVersion &&
    artifact.answerKeyRef === grading.answerKeyRef &&
    artifact.answerKeySemanticFingerprint === answerKey.semanticFingerprint &&
    artifact.answerKeyArtifactSha256 === keyFact.sha256 &&
    canonicalBytes.byteLength === fact.byteLength &&
    sha256(canonicalBytes) === fact.sha256 &&
    artifact.assessmentCount === fact.assessmentCount &&
    artifact.evaluatedCount === fact.evaluatedCount &&
    artifact.correctCount === fact.correctCount &&
    artifact.incorrectCount === fact.incorrectCount &&
    artifact.unassessedCount === fact.unassessedCount,
  );
}

export async function resolveExamQuestionAssessmentsFromRuntime(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  sources?: {
    confirmedReview: ConfirmedExamReviewFactsV1;
    answerKey: AuthoritativeExamAnswerKeyArtifactV1;
  },
): Promise<ExamQuestionAssessmentsArtifactV1> {
  requireGradingReady(snapshot);
  const grading = snapshot.state.grading;
  const fact = grading?.assessmentArtifact;
  if (!grading || grading.status !== 'completed' || !fact) {
    throw new ExamError('EXAM_GRADING_NOT_READY');
  }
  const confirmedReview =
    sources?.confirmedReview ?? (await resolveConfirmedExamReviewFactsFromRuntime(deps, snapshot));
  const answerKey =
    sources?.answerKey ??
    (await resolveAuthoritativeExamAnswerKeyFromRuntime(deps, snapshot, confirmedReview));
  const bytes = await readOptionalObject(
    deps,
    assessmentObjectKey(snapshot),
    'EXAM_ASSESSMENT_ARTIFACT_CORRUPT',
  );
  if (!bytes || bytes.byteLength !== fact.byteLength || sha256(bytes) !== fact.sha256) {
    throw new ExamError('EXAM_ASSESSMENT_ARTIFACT_CORRUPT');
  }
  let artifact: ExamQuestionAssessmentsArtifactV1;
  let canonicalBytes: Buffer;
  let expectedBytes: Buffer;
  try {
    artifact = parseExamQuestionAssessmentsArtifact(bytes);
    canonicalBytes = serializeExamQuestionAssessmentsArtifact(artifact);
    expectedBytes = serializeExamQuestionAssessmentsArtifact(
      buildExamQuestionAssessmentsArtifact({ confirmedReview, answerKey }),
    );
  } catch {
    throw new ExamError('EXAM_ASSESSMENT_ARTIFACT_CORRUPT');
  }
  if (
    !bytes.equals(canonicalBytes) ||
    !bytes.equals(expectedBytes) ||
    !assessmentsMatchRuntime(artifact, canonicalBytes, answerKey, snapshot)
  ) {
    throw new ExamError('EXAM_ASSESSMENT_ARTIFACT_CORRUPT');
  }
  return artifact;
}

export async function resolveExamQuestionAssessments(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<ExamQuestionAssessmentsArtifactV1> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    return resolveExamQuestionAssessmentsFromRuntime(deps, snapshot);
  });
}

export async function confirmExamAnswerKeyAndGrade(
  deps: ExamGradingServiceDeps,
  examSessionId: string,
  input: unknown,
): Promise<ConfirmExamAnswerKeyAndGradeResult> {
  return deps.withExamMutationLock(examSessionId, async () => {
    let snapshot = await loadExamRuntime(deps, examSessionId);
    requireGradingReady(snapshot);
    const replayed = snapshot.state.grading?.status === 'completed';
    const confirmedReview = await resolveConfirmedExamReviewFactsFromRuntime(deps, snapshot);
    const preparedKey = prepareAnswerKey(snapshot, confirmedReview, input);

    if (!snapshot.state.answerKey) {
      snapshot = await appendGradingEvent(
        deps,
        snapshot,
        answerKeyStartedEvent(deps, snapshot, preparedKey.plan),
      );
    }
    if (
      !snapshot.state.answerKey ||
      !answerKeyPlanMatches(snapshot.state.answerKey, preparedKey.plan)
    ) {
      throw new ExamError('EXAM_ANSWER_KEY_CONFLICT');
    }
    if (snapshot.state.answerKey.status !== 'confirmed') {
      await putAndVerifyArtifact(
        deps,
        answerKeyObjectKey(snapshot),
        preparedKey.bytes,
        'EXAM_ANSWER_KEY_CONFLICT',
      );
      snapshot = await appendGradingEvent(
        deps,
        snapshot,
        answerKeyConfirmedEvent(deps, snapshot, preparedKey),
      );
    }
    const answerKey = await resolveAuthoritativeExamAnswerKeyFromRuntime(
      deps,
      snapshot,
      confirmedReview,
    );
    if (!serializeAuthoritativeExamAnswerKeyArtifact(answerKey).equals(preparedKey.bytes)) {
      throw new ExamError('EXAM_ANSWER_KEY_CONFLICT');
    }

    const preparedAssessments = prepareAssessments(
      deps,
      snapshot,
      confirmedReview,
      answerKey,
      preparedKey.bytes,
    );
    if (!snapshot.state.grading) {
      snapshot = await appendGradingEvent(
        deps,
        snapshot,
        gradingStartedEvent(deps, snapshot, preparedAssessments.plan),
      );
    }
    if (
      !snapshot.state.grading ||
      !gradingPlanMatches(snapshot.state.grading, preparedAssessments.plan)
    ) {
      throw new ExamError('EXAM_GRADING_CONFLICT');
    }
    if (snapshot.state.grading.status !== 'completed') {
      await putAndVerifyArtifact(
        deps,
        assessmentObjectKey(snapshot),
        preparedAssessments.bytes,
        'EXAM_GRADING_CONFLICT',
      );
      snapshot = await appendGradingEvent(
        deps,
        snapshot,
        gradingCompletedEvent(deps, snapshot, preparedAssessments),
      );
    }
    const assessments = await resolveExamQuestionAssessmentsFromRuntime(deps, snapshot, {
      confirmedReview,
      answerKey,
    });
    if (!serializeExamQuestionAssessmentsArtifact(assessments).equals(preparedAssessments.bytes)) {
      throw new ExamError('EXAM_GRADING_CONFLICT');
    }
    return {
      examSessionId: snapshot.state.examSessionId,
      grading: toPublicExamSession(snapshot.state).grading,
      replayed,
    };
  });
}
