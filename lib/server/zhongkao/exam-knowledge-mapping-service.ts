import { createHash } from 'node:crypto';

import {
  examKnowledgeMappingObjectKey,
  examObservationsObjectKey,
} from '@/lib/server/materials/object-keys';
import { MaterialByteStoreError } from '@/lib/server/materials/bytes';
import type {
  PublicExamKnowledgeMappingSummary,
  PublicExamObservationProjectionSummary,
} from '@/lib/zhongkao/exam';
import { ExamError, isExamError } from '@/lib/zhongkao/exam-errors';
import {
  EXAM_EVENT_SCHEMA_VERSION,
  type ExamKnowledgeMappingConfirmedEvent,
  type ExamKnowledgeMappingPlanFacts,
  type ExamKnowledgeMappingStartedEvent,
  type ExamObservationProjectionPlanFacts,
  type ExamObservationProjectionStartedEvent,
  type ExamObservationsProjectedEvent,
} from '@/lib/zhongkao/exam-event';
import type { ConfirmedExamReviewFactsV1 } from '@/lib/zhongkao/exam-human-review';
import {
  toPublicExamSession,
  type ExamKnowledgeMappingState,
  type ExamObservationProjectionState,
} from '@/lib/zhongkao/exam-state';

import {
  EXAM_KNOWLEDGE_MAPPING_VERSION,
  EXAM_OBSERVATION_PROJECTION_VERSION,
  ExamKnowledgeMappingPrivateError,
  buildConfirmedExamKnowledgeMappingArtifact,
  buildConfirmedExamObservationsArtifact,
  parseConfirmedExamKnowledgeMappingArtifact,
  parseConfirmedExamObservationsArtifact,
  parseExamKnowledgeMappingRequest,
  serializeConfirmedExamKnowledgeMappingArtifact,
  serializeConfirmedExamObservationsArtifact,
  type ConfirmedExamKnowledgeMappingArtifactV1,
  type ConfirmedExamObservationsArtifactV1,
  type ExamKnowledgeMappingRequestV1,
} from './exam-knowledge-mapping-private';
import type {
  AuthoritativeExamAnswerKeyArtifactV1,
  ExamQuestionAssessmentsArtifactV1,
} from './exam-grading-private';
import {
  resolveAuthoritativeExamAnswerKeyFromRuntime,
  resolveExamQuestionAssessmentsFromRuntime,
} from './exam-grading-service';
import { resolveConfirmedExamReviewFactsFromRuntime } from './exam-human-review-service';
import {
  appendExamRuntimeEvent,
  createExamOperationFingerprint,
  deriveExamEventId,
  deriveExamKnowledgeMappingArtifactRef,
  deriveExamKnowledgeMappingConfirmedOperationId,
  deriveExamKnowledgeMappingRef,
  deriveExamKnowledgeMappingStartedOperationId,
  deriveExamObservationArtifactRef,
  deriveExamObservationProjectionRef,
  deriveExamObservationProjectionStartedOperationId,
  deriveExamObservationsProjectedOperationId,
  loadExamRuntime,
  type ExamRuntimeSnapshot,
} from './exam-runtime';
import type { ExamServiceDeps } from './exam-service';

export interface ConfirmExamKnowledgeMappingResult {
  examSessionId: string;
  knowledgeMapping: PublicExamKnowledgeMappingSummary;
  observationProjection: PublicExamObservationProjectionSummary;
  replayed: boolean;
}

interface ResolvedKnowledgeSources {
  confirmedReview: ConfirmedExamReviewFactsV1;
  answerKey: AuthoritativeExamAnswerKeyArtifactV1;
  assessments: ExamQuestionAssessmentsArtifactV1;
}

interface PreparedKnowledgeMapping {
  artifact: ConfirmedExamKnowledgeMappingArtifactV1;
  bytes: Buffer;
  plan: ExamKnowledgeMappingPlanFacts;
}

interface PreparedObservations {
  artifact: ConfirmedExamObservationsArtifactV1;
  bytes: Buffer;
  plan: ExamObservationProjectionPlanFacts;
}

type KnowledgeEvent =
  | ExamKnowledgeMappingStartedEvent
  | ExamKnowledgeMappingConfirmedEvent
  | ExamObservationProjectionStartedEvent
  | ExamObservationsProjectedEvent;

function serviceNow(deps: ExamServiceDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function missingObject(error: unknown): boolean {
  return error instanceof MaterialByteStoreError && error.code === 'ENOENT';
}

function requireKnowledgeMappingReady(snapshot: ExamRuntimeSnapshot): void {
  if (snapshot.state.status === 'deleting' || snapshot.state.status === 'deleted') {
    throw new ExamError('EXAM_NOT_FOUND');
  }
  if (
    snapshot.state.status !== 'ready_for_extraction' ||
    snapshot.state.humanReview?.status !== 'confirmed' ||
    !snapshot.state.humanReview.reviewArtifact ||
    snapshot.state.answerKey?.status !== 'confirmed' ||
    !snapshot.state.answerKey.answerKeyArtifact ||
    snapshot.state.grading?.status !== 'completed' ||
    !snapshot.state.grading.assessmentArtifact
  ) {
    throw new ExamError('EXAM_KNOWLEDGE_MAPPING_NOT_READY');
  }
}

function mapPrivateMappingError(error: unknown): ExamError {
  if (!(error instanceof ExamKnowledgeMappingPrivateError)) {
    return new ExamError('EXAM_KNOWLEDGE_MAPPING_FAILED');
  }
  switch (error.code) {
    case 'EXAM_KNOWLEDGE_MAPPING_INPUT_INVALID':
      return new ExamError('EXAM_KNOWLEDGE_MAPPING_INPUT_INVALID');
    case 'EXAM_KNOWLEDGE_MAPPING_INCOMPLETE':
      return new ExamError('EXAM_KNOWLEDGE_MAPPING_INCOMPLETE');
    case 'EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT':
      return new ExamError('EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT');
    case 'EXAM_KNOWLEDGE_MAPPING_SOURCE_INVALID':
      return new ExamError('EXAM_KNOWLEDGE_MAPPING_NOT_READY');
    case 'EXAM_OBSERVATION_SOURCE_INVALID':
    case 'EXAM_OBSERVATION_ARTIFACT_CORRUPT':
      return new ExamError('EXAM_KNOWLEDGE_MAPPING_FAILED');
  }
}

function mapPrivateObservationError(error: unknown): ExamError {
  if (!(error instanceof ExamKnowledgeMappingPrivateError)) {
    return new ExamError('EXAM_OBSERVATION_PROJECTION_FAILED');
  }
  switch (error.code) {
    case 'EXAM_OBSERVATION_ARTIFACT_CORRUPT':
      return new ExamError('EXAM_OBSERVATION_ARTIFACT_CORRUPT');
    case 'EXAM_OBSERVATION_SOURCE_INVALID':
    case 'EXAM_KNOWLEDGE_MAPPING_SOURCE_INVALID':
      return new ExamError('EXAM_OBSERVATION_SOURCE_CHANGED');
    case 'EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT':
      return new ExamError('EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT');
    case 'EXAM_KNOWLEDGE_MAPPING_INPUT_INVALID':
    case 'EXAM_KNOWLEDGE_MAPPING_INCOMPLETE':
      return new ExamError('EXAM_OBSERVATION_PROJECTION_FAILED');
  }
}

async function resolveKnowledgeSources(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
): Promise<ResolvedKnowledgeSources> {
  requireKnowledgeMappingReady(snapshot);
  const confirmedReview = await resolveConfirmedExamReviewFactsFromRuntime(deps, snapshot);
  const answerKey = await resolveAuthoritativeExamAnswerKeyFromRuntime(
    deps,
    snapshot,
    confirmedReview,
  );
  const assessments = await resolveExamQuestionAssessmentsFromRuntime(deps, snapshot, {
    confirmedReview,
    answerKey,
  });
  return { confirmedReview, answerKey, assessments };
}

function mappingPlanMatches(
  state: ExamKnowledgeMappingState,
  plan: ExamKnowledgeMappingPlanFacts,
): boolean {
  return (
    state.mappingVersion === plan.mappingVersion &&
    state.subjectId === plan.subjectId &&
    state.reviewVersion === plan.reviewVersion &&
    state.reviewArtifactRef === plan.reviewArtifactRef &&
    state.sourceReviewArtifactFingerprint === plan.sourceReviewArtifactFingerprint &&
    state.sourceReviewSemanticFingerprint === plan.sourceReviewSemanticFingerprint &&
    state.assessmentVersion === plan.assessmentVersion &&
    state.assessmentArtifactRef === plan.assessmentArtifactRef &&
    state.sourceAssessmentArtifactFingerprint === plan.sourceAssessmentArtifactFingerprint &&
    state.sourceAssessmentSemanticFingerprint === plan.sourceAssessmentSemanticFingerprint &&
    state.mappingSemanticFingerprint === plan.mappingSemanticFingerprint &&
    state.mappingRef === plan.mappingRef &&
    state.mappingArtifactRef === plan.mappingArtifactRef
  );
}

function observationPlanMatches(
  state: ExamObservationProjectionState,
  plan: ExamObservationProjectionPlanFacts,
): boolean {
  return (
    state.observationVersion === plan.observationVersion &&
    state.reviewVersion === plan.reviewVersion &&
    state.reviewArtifactRef === plan.reviewArtifactRef &&
    state.sourceReviewArtifactFingerprint === plan.sourceReviewArtifactFingerprint &&
    state.sourceReviewSemanticFingerprint === plan.sourceReviewSemanticFingerprint &&
    state.assessmentVersion === plan.assessmentVersion &&
    state.assessmentArtifactRef === plan.assessmentArtifactRef &&
    state.sourceAssessmentArtifactFingerprint === plan.sourceAssessmentArtifactFingerprint &&
    state.sourceAssessmentSemanticFingerprint === plan.sourceAssessmentSemanticFingerprint &&
    state.mappingVersion === plan.mappingVersion &&
    state.mappingRef === plan.mappingRef &&
    state.mappingArtifactRef === plan.mappingArtifactRef &&
    state.sourceMappingArtifactFingerprint === plan.sourceMappingArtifactFingerprint &&
    state.sourceMappingSemanticFingerprint === plan.sourceMappingSemanticFingerprint &&
    state.observationSemanticFingerprint === plan.observationSemanticFingerprint &&
    state.observationRef === plan.observationRef &&
    state.observationArtifactRef === plan.observationArtifactRef
  );
}

function prepareMapping(
  snapshot: ExamRuntimeSnapshot,
  sources: ResolvedKnowledgeSources,
  request: ExamKnowledgeMappingRequestV1,
): PreparedKnowledgeMapping {
  const reviewFact = snapshot.state.humanReview?.reviewArtifact;
  const grading = snapshot.state.grading;
  const assessmentFact = grading?.assessmentArtifact;
  if (!reviewFact || !grading || !assessmentFact) {
    throw new ExamError('EXAM_KNOWLEDGE_MAPPING_NOT_READY');
  }
  let artifact: ConfirmedExamKnowledgeMappingArtifactV1;
  let bytes: Buffer;
  try {
    artifact = buildConfirmedExamKnowledgeMappingArtifact({
      examSessionId: snapshot.state.examSessionId,
      profileId: snapshot.state.profileId,
      subjectId: snapshot.state.subjectId,
      confirmedReview: sources.confirmedReview,
      confirmedReviewArtifactSha256: reviewFact.sha256,
      assessments: sources.assessments,
      assessmentArtifactSha256: assessmentFact.sha256,
      request,
    });
    bytes = serializeConfirmedExamKnowledgeMappingArtifact(artifact);
  } catch (error) {
    throw mapPrivateMappingError(error);
  }
  const mappingRef = deriveExamKnowledgeMappingRef({
    mappingVersion: EXAM_KNOWLEDGE_MAPPING_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    subjectId: snapshot.state.subjectId,
    sourceReviewSemanticFingerprint: sources.confirmedReview.decisionSemanticFingerprint,
    sourceAssessmentSemanticFingerprint: sources.assessments.semanticFingerprint,
  });
  const plan: ExamKnowledgeMappingPlanFacts = {
    mappingVersion: EXAM_KNOWLEDGE_MAPPING_VERSION,
    subjectId: snapshot.state.subjectId,
    reviewVersion: sources.confirmedReview.reviewVersion,
    reviewArtifactRef: sources.confirmedReview.reviewArtifactRef,
    sourceReviewArtifactFingerprint: reviewFact.sha256,
    sourceReviewSemanticFingerprint: sources.confirmedReview.decisionSemanticFingerprint,
    assessmentVersion: sources.assessments.assessmentVersion,
    assessmentArtifactRef: grading.assessmentArtifactRef,
    sourceAssessmentArtifactFingerprint: assessmentFact.sha256,
    sourceAssessmentSemanticFingerprint: sources.assessments.semanticFingerprint,
    mappingSemanticFingerprint: artifact.semanticFingerprint,
    mappingRef,
    mappingArtifactRef: deriveExamKnowledgeMappingArtifactRef(mappingRef),
  };
  if (artifact.mappingRef !== plan.mappingRef) {
    throw new ExamError('EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT');
  }
  return { artifact, bytes, plan };
}

function prepareObservations(
  snapshot: ExamRuntimeSnapshot,
  sources: ResolvedKnowledgeSources,
  mapping: ConfirmedExamKnowledgeMappingArtifactV1,
  mappingBytes: Buffer,
): PreparedObservations {
  const reviewFact = snapshot.state.humanReview?.reviewArtifact;
  const grading = snapshot.state.grading;
  const assessmentFact = grading?.assessmentArtifact;
  const mappingState = snapshot.state.knowledgeMapping;
  const mappingFact = mappingState?.mappingArtifact;
  if (!reviewFact || !grading || !assessmentFact || !mappingState || !mappingFact) {
    throw new ExamError('EXAM_OBSERVATION_SOURCE_CHANGED');
  }
  let artifact: ConfirmedExamObservationsArtifactV1;
  let bytes: Buffer;
  try {
    artifact = buildConfirmedExamObservationsArtifact({
      profileId: snapshot.state.profileId,
      subjectId: snapshot.state.subjectId,
      observedAt: snapshot.state.createdAt,
      confirmedReview: sources.confirmedReview,
      confirmedReviewArtifactSha256: reviewFact.sha256,
      assessments: sources.assessments,
      assessmentArtifactSha256: assessmentFact.sha256,
      mapping,
      mappingArtifactSha256: sha256(mappingBytes),
    });
    bytes = serializeConfirmedExamObservationsArtifact(artifact);
  } catch (error) {
    throw mapPrivateObservationError(error);
  }
  const observationRef = deriveExamObservationProjectionRef({
    observationVersion: EXAM_OBSERVATION_PROJECTION_VERSION,
    examSessionId: snapshot.state.examSessionId,
    sourceAssessmentSemanticFingerprint: sources.assessments.semanticFingerprint,
    sourceMappingSemanticFingerprint: mapping.semanticFingerprint,
  });
  const plan: ExamObservationProjectionPlanFacts = {
    observationVersion: EXAM_OBSERVATION_PROJECTION_VERSION,
    reviewVersion: sources.confirmedReview.reviewVersion,
    reviewArtifactRef: sources.confirmedReview.reviewArtifactRef,
    sourceReviewArtifactFingerprint: reviewFact.sha256,
    sourceReviewSemanticFingerprint: sources.confirmedReview.decisionSemanticFingerprint,
    assessmentVersion: sources.assessments.assessmentVersion,
    assessmentArtifactRef: grading.assessmentArtifactRef,
    sourceAssessmentArtifactFingerprint: assessmentFact.sha256,
    sourceAssessmentSemanticFingerprint: sources.assessments.semanticFingerprint,
    mappingVersion: mapping.mappingVersion,
    mappingRef: mapping.mappingRef,
    mappingArtifactRef: mappingState.mappingArtifactRef,
    sourceMappingArtifactFingerprint: mappingFact.sha256,
    sourceMappingSemanticFingerprint: mapping.semanticFingerprint,
    observationSemanticFingerprint: artifact.semanticFingerprint,
    observationRef,
    observationArtifactRef: deriveExamObservationArtifactRef(observationRef),
  };
  if (artifact.observationRef !== plan.observationRef) {
    throw new ExamError('EXAM_OBSERVATION_ARTIFACT_CORRUPT');
  }
  return { artifact, bytes, plan };
}

function mappingObjectKey(snapshot: ExamRuntimeSnapshot): string {
  const state = snapshot.state.knowledgeMapping;
  if (!state) throw new ExamError('EXAM_KNOWLEDGE_MAPPING_NOT_READY');
  return examKnowledgeMappingObjectKey(snapshot.state.examSessionId, state.mappingVersion);
}

function observationsObjectKey(snapshot: ExamRuntimeSnapshot): string {
  const state = snapshot.state.observationProjection;
  if (!state) throw new ExamError('EXAM_KNOWLEDGE_MAPPING_NOT_READY');
  return examObservationsObjectKey(
    snapshot.state.examSessionId,
    state.mappingVersion,
    state.observationVersion,
  );
}

async function readOptionalObject(
  deps: ExamServiceDeps,
  key: string,
  errorCode:
    | 'EXAM_KNOWLEDGE_MAPPING_FAILED'
    | 'EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT'
    | 'EXAM_OBSERVATION_PROJECTION_FAILED'
    | 'EXAM_OBSERVATION_ARTIFACT_CORRUPT',
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
  options: {
    failureCode: 'EXAM_KNOWLEDGE_MAPPING_FAILED' | 'EXAM_OBSERVATION_PROJECTION_FAILED';
    conflictCode: 'EXAM_KNOWLEDGE_MAPPING_CONFLICT' | 'EXAM_OBSERVATION_SOURCE_CHANGED';
  },
): Promise<void> {
  const existing = await readOptionalObject(deps, key, options.failureCode);
  if (existing) {
    if (!existing.equals(expected)) throw new ExamError(options.conflictCode);
    return;
  }
  try {
    await deps.byteStore.put(key, expected, 'application/json');
  } catch {
    const recovered = await readOptionalObject(deps, key, options.failureCode).catch(
      () => undefined,
    );
    if (!recovered) throw new ExamError(options.failureCode);
    if (!recovered.equals(expected)) throw new ExamError(options.conflictCode);
  }
  const readBack = await readOptionalObject(deps, key, options.failureCode);
  if (!readBack) throw new ExamError(options.failureCode);
  if (!readBack.equals(expected)) throw new ExamError(options.conflictCode);
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

function mappingStartedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  plan: ExamKnowledgeMappingPlanFacts,
): ExamKnowledgeMappingStartedEvent {
  const operationId = deriveExamKnowledgeMappingStartedOperationId(
    snapshot.state.examSessionId,
    plan.mappingVersion,
  );
  const facts = {
    action: 'exam_knowledge_mapping_started',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    ...plan,
  } as const;
  return {
    ...baseEvent(deps, snapshot, operationId),
    eventType: 'exam_knowledge_mapping_started',
    operationFingerprint: createExamOperationFingerprint(facts),
    ...plan,
  };
}

function mappingConfirmedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  prepared: PreparedKnowledgeMapping,
): ExamKnowledgeMappingConfirmedEvent {
  const operationId = deriveExamKnowledgeMappingConfirmedOperationId(
    snapshot.state.examSessionId,
    prepared.plan.mappingVersion,
  );
  const artifactFacts = {
    artifactByteLength: prepared.bytes.byteLength,
    artifactSha256: sha256(prepared.bytes),
    entryCount: prepared.artifact.entryCount,
    mappedQuestionCount: prepared.artifact.mappedQuestionCount,
    unmappedQuestionCount: prepared.artifact.unmappedQuestionCount,
  } as const;
  const facts = {
    action: 'exam_knowledge_mapping_confirmed',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    ...prepared.plan,
    ...artifactFacts,
  } as const;
  return {
    ...baseEvent(deps, snapshot, operationId),
    eventType: 'exam_knowledge_mapping_confirmed',
    operationFingerprint: createExamOperationFingerprint(facts),
    ...prepared.plan,
    ...artifactFacts,
  };
}

function observationStartedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  plan: ExamObservationProjectionPlanFacts,
): ExamObservationProjectionStartedEvent {
  const operationId = deriveExamObservationProjectionStartedOperationId(
    snapshot.state.examSessionId,
    plan.mappingVersion,
    plan.observationVersion,
  );
  const facts = {
    action: 'exam_observation_projection_started',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    ...plan,
  } as const;
  return {
    ...baseEvent(deps, snapshot, operationId),
    eventType: 'exam_observation_projection_started',
    operationFingerprint: createExamOperationFingerprint(facts),
    ...plan,
  };
}

function observationsProjectedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  prepared: PreparedObservations,
): ExamObservationsProjectedEvent {
  const operationId = deriveExamObservationsProjectedOperationId(
    snapshot.state.examSessionId,
    prepared.plan.mappingVersion,
    prepared.plan.observationVersion,
  );
  const artifactFacts = {
    artifactByteLength: prepared.bytes.byteLength,
    artifactSha256: sha256(prepared.bytes),
    observationCount: prepared.artifact.observationCount,
    evaluatedCount: prepared.artifact.evaluatedCount,
    correctCount: prepared.artifact.correctCount,
    incorrectCount: prepared.artifact.incorrectCount,
    unassessedCount: prepared.artifact.unassessedCount,
  } as const;
  const facts = {
    action: 'exam_observations_projected',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    ...prepared.plan,
    ...artifactFacts,
  } as const;
  return {
    ...baseEvent(deps, snapshot, operationId),
    eventType: 'exam_observations_projected',
    operationFingerprint: createExamOperationFingerprint(facts),
    ...prepared.plan,
    ...artifactFacts,
  };
}

async function appendKnowledgeEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  event: KnowledgeEvent,
  failureCode: 'EXAM_KNOWLEDGE_MAPPING_FAILED' | 'EXAM_OBSERVATION_PROJECTION_FAILED',
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
    throw new ExamError(failureCode);
  }
}

function mappingMatchesRuntime(
  artifact: ConfirmedExamKnowledgeMappingArtifactV1,
  canonicalBytes: Buffer,
  snapshot: ExamRuntimeSnapshot,
): boolean {
  const review = snapshot.state.humanReview;
  const grading = snapshot.state.grading;
  const mapping = snapshot.state.knowledgeMapping;
  const fact = mapping?.mappingArtifact;
  return Boolean(
    review &&
    review.status === 'confirmed' &&
    review.reviewArtifact &&
    grading &&
    grading.status === 'completed' &&
    grading.assessmentArtifact &&
    mapping &&
    mapping.status === 'confirmed' &&
    fact &&
    mapping.reviewVersion === review.reviewVersion &&
    mapping.reviewArtifactRef === review.reviewArtifactRef &&
    mapping.sourceReviewArtifactFingerprint === review.reviewArtifact.sha256 &&
    mapping.sourceReviewSemanticFingerprint === review.decisionSemanticFingerprint &&
    mapping.assessmentVersion === grading.gradingVersion &&
    mapping.assessmentArtifactRef === grading.assessmentArtifactRef &&
    mapping.sourceAssessmentArtifactFingerprint === grading.assessmentArtifact.sha256 &&
    artifact.examSessionId === snapshot.state.examSessionId &&
    artifact.profileId === snapshot.state.profileId &&
    artifact.subjectId === snapshot.state.subjectId &&
    artifact.mappingVersion === mapping.mappingVersion &&
    artifact.mappingRef === mapping.mappingRef &&
    artifact.semanticFingerprint === mapping.mappingSemanticFingerprint &&
    artifact.sourceReview.reviewVersion === mapping.reviewVersion &&
    artifact.sourceReview.reviewArtifactRef === mapping.reviewArtifactRef &&
    artifact.sourceReview.reviewArtifactSha256 === mapping.sourceReviewArtifactFingerprint &&
    artifact.sourceReview.decisionSemanticFingerprint === mapping.sourceReviewSemanticFingerprint &&
    artifact.sourceAssessments.assessmentVersion === mapping.assessmentVersion &&
    artifact.sourceAssessments.assessmentArtifactSha256 ===
      mapping.sourceAssessmentArtifactFingerprint &&
    artifact.sourceAssessments.semanticFingerprint ===
      mapping.sourceAssessmentSemanticFingerprint &&
    canonicalBytes.byteLength === fact.byteLength &&
    sha256(canonicalBytes) === fact.sha256 &&
    artifact.entryCount === fact.entryCount &&
    artifact.mappedQuestionCount === fact.mappedQuestionCount &&
    artifact.unmappedQuestionCount === fact.unmappedQuestionCount,
  );
}

export async function resolveConfirmedExamKnowledgeMappingFromRuntime(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  sources?: ResolvedKnowledgeSources,
): Promise<ConfirmedExamKnowledgeMappingArtifactV1> {
  requireKnowledgeMappingReady(snapshot);
  const mapping = snapshot.state.knowledgeMapping;
  const fact = mapping?.mappingArtifact;
  if (!mapping || mapping.status !== 'confirmed' || !fact) {
    throw new ExamError('EXAM_KNOWLEDGE_MAPPING_NOT_READY');
  }
  const resolvedSources = sources ?? (await resolveKnowledgeSources(deps, snapshot));
  const bytes = await readOptionalObject(
    deps,
    mappingObjectKey(snapshot),
    'EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT',
  );
  if (!bytes || bytes.byteLength !== fact.byteLength || sha256(bytes) !== fact.sha256) {
    throw new ExamError('EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT');
  }
  let artifact: ConfirmedExamKnowledgeMappingArtifactV1;
  let canonicalBytes: Buffer;
  let expectedBytes: Buffer;
  try {
    artifact = parseConfirmedExamKnowledgeMappingArtifact(bytes);
    canonicalBytes = serializeConfirmedExamKnowledgeMappingArtifact(artifact);
    expectedBytes = serializeConfirmedExamKnowledgeMappingArtifact(
      buildConfirmedExamKnowledgeMappingArtifact({
        examSessionId: snapshot.state.examSessionId,
        profileId: snapshot.state.profileId,
        subjectId: snapshot.state.subjectId,
        confirmedReview: resolvedSources.confirmedReview,
        confirmedReviewArtifactSha256: snapshot.state.humanReview!.reviewArtifact!.sha256,
        assessments: resolvedSources.assessments,
        assessmentArtifactSha256: snapshot.state.grading!.assessmentArtifact!.sha256,
        request: { schemaVersion: 1, entries: artifact.entries },
      }),
    );
  } catch {
    throw new ExamError('EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT');
  }
  if (
    !bytes.equals(canonicalBytes) ||
    !bytes.equals(expectedBytes) ||
    !mappingMatchesRuntime(artifact, canonicalBytes, snapshot)
  ) {
    throw new ExamError('EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT');
  }
  return artifact;
}

export async function resolveConfirmedExamKnowledgeMapping(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<ConfirmedExamKnowledgeMappingArtifactV1> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    return resolveConfirmedExamKnowledgeMappingFromRuntime(deps, snapshot);
  });
}

function observationsMatchRuntime(
  artifact: ConfirmedExamObservationsArtifactV1,
  canonicalBytes: Buffer,
  mapping: ConfirmedExamKnowledgeMappingArtifactV1,
  snapshot: ExamRuntimeSnapshot,
): boolean {
  const review = snapshot.state.humanReview;
  const grading = snapshot.state.grading;
  const projection = snapshot.state.observationProjection;
  const fact = projection?.observationArtifact;
  const mappingState = snapshot.state.knowledgeMapping;
  const mappingFact = snapshot.state.knowledgeMapping?.mappingArtifact;
  return Boolean(
    review &&
    review.status === 'confirmed' &&
    review.reviewArtifact &&
    grading &&
    grading.status === 'completed' &&
    grading.assessmentArtifact &&
    projection &&
    projection.status === 'completed' &&
    fact &&
    mappingState &&
    mappingState.status === 'confirmed' &&
    mappingFact &&
    projection.reviewVersion === review.reviewVersion &&
    projection.reviewArtifactRef === review.reviewArtifactRef &&
    projection.sourceReviewArtifactFingerprint === review.reviewArtifact.sha256 &&
    projection.sourceReviewSemanticFingerprint === review.decisionSemanticFingerprint &&
    projection.assessmentVersion === grading.gradingVersion &&
    projection.assessmentArtifactRef === grading.assessmentArtifactRef &&
    projection.sourceAssessmentArtifactFingerprint === grading.assessmentArtifact.sha256 &&
    artifact.examSessionId === snapshot.state.examSessionId &&
    artifact.profileId === snapshot.state.profileId &&
    artifact.subjectId === snapshot.state.subjectId &&
    artifact.observedAt === snapshot.state.createdAt &&
    artifact.observationVersion === projection.observationVersion &&
    artifact.observationRef === projection.observationRef &&
    artifact.semanticFingerprint === projection.observationSemanticFingerprint &&
    artifact.sourceReview.reviewVersion === projection.reviewVersion &&
    artifact.sourceReview.reviewArtifactRef === projection.reviewArtifactRef &&
    artifact.sourceReview.reviewArtifactSha256 === projection.sourceReviewArtifactFingerprint &&
    artifact.sourceReview.decisionSemanticFingerprint ===
      projection.sourceReviewSemanticFingerprint &&
    artifact.sourceAssessments.assessmentVersion === projection.assessmentVersion &&
    artifact.sourceAssessments.assessmentArtifactSha256 ===
      projection.sourceAssessmentArtifactFingerprint &&
    artifact.sourceAssessments.semanticFingerprint ===
      projection.sourceAssessmentSemanticFingerprint &&
    projection.mappingVersion === mappingState.mappingVersion &&
    projection.mappingRef === mappingState.mappingRef &&
    projection.mappingArtifactRef === mappingState.mappingArtifactRef &&
    projection.sourceMappingArtifactFingerprint === mappingFact.sha256 &&
    projection.sourceMappingSemanticFingerprint === mappingState.mappingSemanticFingerprint &&
    artifact.sourceMapping.mappingVersion === projection.mappingVersion &&
    artifact.sourceMapping.mappingRef === mapping.mappingRef &&
    artifact.sourceMapping.mappingArtifactSha256 === projection.sourceMappingArtifactFingerprint &&
    artifact.sourceMapping.semanticFingerprint === projection.sourceMappingSemanticFingerprint &&
    canonicalBytes.byteLength === fact.byteLength &&
    sha256(canonicalBytes) === fact.sha256 &&
    artifact.observationCount === fact.observationCount &&
    artifact.evaluatedCount === fact.evaluatedCount &&
    artifact.correctCount === fact.correctCount &&
    artifact.incorrectCount === fact.incorrectCount &&
    artifact.unassessedCount === fact.unassessedCount,
  );
}

export async function resolveConfirmedExamObservationsFromRuntime(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  sources?: ResolvedKnowledgeSources,
): Promise<ConfirmedExamObservationsArtifactV1> {
  requireKnowledgeMappingReady(snapshot);
  const projection = snapshot.state.observationProjection;
  const fact = projection?.observationArtifact;
  if (!projection || projection.status !== 'completed' || !fact) {
    throw new ExamError('EXAM_KNOWLEDGE_MAPPING_NOT_READY');
  }
  const resolvedSources = sources ?? (await resolveKnowledgeSources(deps, snapshot));
  const mapping = await resolveConfirmedExamKnowledgeMappingFromRuntime(
    deps,
    snapshot,
    resolvedSources,
  );
  const mappingBytes = serializeConfirmedExamKnowledgeMappingArtifact(mapping);
  const bytes = await readOptionalObject(
    deps,
    observationsObjectKey(snapshot),
    'EXAM_OBSERVATION_ARTIFACT_CORRUPT',
  );
  if (!bytes || bytes.byteLength !== fact.byteLength || sha256(bytes) !== fact.sha256) {
    throw new ExamError('EXAM_OBSERVATION_ARTIFACT_CORRUPT');
  }
  let artifact: ConfirmedExamObservationsArtifactV1;
  let canonicalBytes: Buffer;
  let expectedBytes: Buffer;
  try {
    artifact = parseConfirmedExamObservationsArtifact(bytes);
    canonicalBytes = serializeConfirmedExamObservationsArtifact(artifact);
    expectedBytes = serializeConfirmedExamObservationsArtifact(
      buildConfirmedExamObservationsArtifact({
        profileId: snapshot.state.profileId,
        subjectId: snapshot.state.subjectId,
        observedAt: snapshot.state.createdAt,
        confirmedReview: resolvedSources.confirmedReview,
        confirmedReviewArtifactSha256: snapshot.state.humanReview!.reviewArtifact!.sha256,
        assessments: resolvedSources.assessments,
        assessmentArtifactSha256: snapshot.state.grading!.assessmentArtifact!.sha256,
        mapping,
        mappingArtifactSha256: sha256(mappingBytes),
      }),
    );
  } catch (error) {
    if (
      error instanceof ExamKnowledgeMappingPrivateError &&
      error.code === 'EXAM_OBSERVATION_SOURCE_INVALID'
    ) {
      throw new ExamError('EXAM_OBSERVATION_SOURCE_CHANGED');
    }
    throw new ExamError('EXAM_OBSERVATION_ARTIFACT_CORRUPT');
  }
  if (!bytes.equals(canonicalBytes)) {
    throw new ExamError('EXAM_OBSERVATION_ARTIFACT_CORRUPT');
  }
  if (
    !bytes.equals(expectedBytes) ||
    !observationsMatchRuntime(artifact, canonicalBytes, mapping, snapshot)
  ) {
    throw new ExamError('EXAM_OBSERVATION_SOURCE_CHANGED');
  }
  return artifact;
}

export async function resolveConfirmedExamObservations(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<ConfirmedExamObservationsArtifactV1> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    return resolveConfirmedExamObservationsFromRuntime(deps, snapshot);
  });
}

export async function confirmExamKnowledgeMappingAndProjectObservations(
  deps: ExamServiceDeps,
  examSessionId: string,
  input: unknown,
): Promise<ConfirmExamKnowledgeMappingResult> {
  let request: ExamKnowledgeMappingRequestV1;
  try {
    request = parseExamKnowledgeMappingRequest(input);
  } catch (error) {
    throw mapPrivateMappingError(error);
  }

  return deps.withExamMutationLock(examSessionId, async () => {
    let snapshot = await loadExamRuntime(deps, examSessionId);
    requireKnowledgeMappingReady(snapshot);
    const replayed = snapshot.state.observationProjection?.status === 'completed';
    const sources = await resolveKnowledgeSources(deps, snapshot);
    const preparedMapping = prepareMapping(snapshot, sources, request);

    if (!snapshot.state.knowledgeMapping) {
      snapshot = await appendKnowledgeEvent(
        deps,
        snapshot,
        mappingStartedEvent(deps, snapshot, preparedMapping.plan),
        'EXAM_KNOWLEDGE_MAPPING_FAILED',
      );
    }
    if (
      !snapshot.state.knowledgeMapping ||
      !mappingPlanMatches(snapshot.state.knowledgeMapping, preparedMapping.plan)
    ) {
      throw new ExamError('EXAM_KNOWLEDGE_MAPPING_CONFLICT');
    }
    if (snapshot.state.knowledgeMapping.status !== 'confirmed') {
      await putAndVerifyArtifact(deps, mappingObjectKey(snapshot), preparedMapping.bytes, {
        failureCode: 'EXAM_KNOWLEDGE_MAPPING_FAILED',
        conflictCode: 'EXAM_KNOWLEDGE_MAPPING_CONFLICT',
      });
      snapshot = await appendKnowledgeEvent(
        deps,
        snapshot,
        mappingConfirmedEvent(deps, snapshot, preparedMapping),
        'EXAM_KNOWLEDGE_MAPPING_FAILED',
      );
    }
    const mapping = await resolveConfirmedExamKnowledgeMappingFromRuntime(deps, snapshot, sources);
    const mappingBytes = serializeConfirmedExamKnowledgeMappingArtifact(mapping);
    if (!mappingBytes.equals(preparedMapping.bytes)) {
      throw new ExamError('EXAM_KNOWLEDGE_MAPPING_CONFLICT');
    }

    const preparedObservations = prepareObservations(snapshot, sources, mapping, mappingBytes);
    if (!snapshot.state.observationProjection) {
      snapshot = await appendKnowledgeEvent(
        deps,
        snapshot,
        observationStartedEvent(deps, snapshot, preparedObservations.plan),
        'EXAM_OBSERVATION_PROJECTION_FAILED',
      );
    }
    if (
      !snapshot.state.observationProjection ||
      !observationPlanMatches(snapshot.state.observationProjection, preparedObservations.plan)
    ) {
      throw new ExamError('EXAM_OBSERVATION_SOURCE_CHANGED');
    }
    if (snapshot.state.observationProjection.status !== 'completed') {
      await putAndVerifyArtifact(
        deps,
        observationsObjectKey(snapshot),
        preparedObservations.bytes,
        {
          failureCode: 'EXAM_OBSERVATION_PROJECTION_FAILED',
          conflictCode: 'EXAM_OBSERVATION_SOURCE_CHANGED',
        },
      );
      snapshot = await appendKnowledgeEvent(
        deps,
        snapshot,
        observationsProjectedEvent(deps, snapshot, preparedObservations),
        'EXAM_OBSERVATION_PROJECTION_FAILED',
      );
    }
    const observations = await resolveConfirmedExamObservationsFromRuntime(deps, snapshot, sources);
    if (
      !serializeConfirmedExamObservationsArtifact(observations).equals(preparedObservations.bytes)
    ) {
      throw new ExamError('EXAM_OBSERVATION_SOURCE_CHANGED');
    }
    const publicExam = toPublicExamSession(snapshot.state);
    return {
      examSessionId: snapshot.state.examSessionId,
      knowledgeMapping: publicExam.knowledgeMapping,
      observationProjection: publicExam.observationProjection,
      replayed,
    };
  });
}
