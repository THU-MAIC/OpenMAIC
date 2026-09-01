import { createHash } from 'node:crypto';

import { examHumanReviewObjectKey } from '@/lib/server/materials/object-keys';
import { MaterialByteStoreError } from '@/lib/server/materials/bytes';
import type { PublicExamHumanReviewSummary } from '@/lib/zhongkao/exam';
import { ExamError, isExamError } from '@/lib/zhongkao/exam-errors';
import {
  EXAM_EVENT_SCHEMA_VERSION,
  type ExamHumanReviewCompletedEvent,
  type ExamHumanReviewPlanFacts,
  type ExamHumanReviewStartedEvent,
} from '@/lib/zhongkao/exam-event';
import {
  EXAM_HUMAN_REVIEW_SCHEMA_VERSION,
  EXAM_HUMAN_REVIEW_VERSION,
  ExamHumanReviewError,
  buildConfirmedExamReviewFacts,
  createExamHumanReviewDecisionSemanticFingerprint,
  parseConfirmedExamReviewFacts,
  parseExamHumanReviewRequest,
  serializeConfirmedExamReviewFacts,
  type ConfirmedExamQuestionV1,
  type ConfirmedExamReviewFactsV1,
  type ConfirmedQuestionResponseMatchV1,
  type ConfirmedStudentResponseV1,
  type ExamHumanReviewRequest,
  type RejectedExamQuestionCandidateV1,
  type RejectedStudentResponseCandidateV1,
} from '@/lib/zhongkao/exam-human-review';
import type {
  ExamQuestionCandidateV1,
  ExamQuestionExtractionDiagnostic,
  ExamQuestionSourceSpan,
} from '@/lib/zhongkao/exam-question-candidate';
import type { ExamQuestionLocator } from '@/lib/zhongkao/exam-question-locator';
import type {
  ExamQuestionResponseMatchV1,
  StudentResponseCandidateV1,
} from '@/lib/zhongkao/exam-student-response';
import { toPublicExamSession, type ExamHumanReviewState } from '@/lib/zhongkao/exam-state';

import { resolveExamStudentResponsesFromRuntime } from './exam-response-service';
import {
  appendExamRuntimeEvent,
  createExamOperationFingerprint,
  deriveExamEventId,
  deriveExamHumanReviewArtifactRef,
  deriveExamHumanReviewCompletedOperationId,
  deriveExamHumanReviewRef,
  deriveExamHumanReviewStartedOperationId,
  loadExamRuntime,
  type ExamRuntimeSnapshot,
} from './exam-runtime';
import type { ExamServiceDeps } from './exam-service';

export interface HumanReviewQuestionV1 {
  questionCandidateId: string;
  candidateKind: ExamQuestionCandidateV1['candidateKind'];
  rawLabel: string;
  locator: ExamQuestionLocator;
  text: string;
  parentContext?: {
    questionCandidateId: string;
    rawLabel: string;
    text: string;
  };
  sourceSpans: readonly ExamQuestionSourceSpan[];
  contentStatus: ExamQuestionCandidateV1['contentStatus'];
  confidenceBand: ExamQuestionCandidateV1['confidenceBand'];
  diagnosticReasonCodes: ExamQuestionCandidateV1['confidenceReasonCodes'];
}

export interface HumanReviewResponseV1 {
  responseCandidateId: string;
  rawLabel: string;
  locator: ExamQuestionLocator;
  rawAnswerText: string;
  answerStatus: StudentResponseCandidateV1['answerStatus'];
}

export interface HumanReviewMatchV1 {
  responseCandidateId: string;
  status: ExamQuestionResponseMatchV1['status'];
  questionCandidateIds: readonly string[];
  reasonCodes: ExamQuestionResponseMatchV1['reasonCodes'];
}

export interface HumanReviewConfirmedOverlayV1 {
  confirmedQuestions: readonly ConfirmedExamQuestionV1[];
  confirmedResponses: readonly ConfirmedStudentResponseV1[];
  confirmedMatches: readonly ConfirmedQuestionResponseMatchV1[];
  rejectedQuestionCandidates: readonly RejectedExamQuestionCandidateV1[];
  rejectedResponseCandidates: readonly RejectedStudentResponseCandidateV1[];
}

export interface HumanReviewBundleV1 {
  schemaVersion: typeof EXAM_HUMAN_REVIEW_SCHEMA_VERSION;
  examSessionId: string;
  profileId: string;
  subjectId: string;
  title?: string;
  reviewStatus: PublicExamHumanReviewSummary['status'];
  questions: readonly HumanReviewQuestionV1[];
  responses: readonly HumanReviewResponseV1[];
  matches: readonly HumanReviewMatchV1[];
  structuralDiagnostics: readonly ExamQuestionExtractionDiagnostic[];
  confirmed?: HumanReviewConfirmedOverlayV1;
}

export interface ConfirmExamHumanReviewResult {
  examSessionId: string;
  humanReview: PublicExamHumanReviewSummary;
  replayed: boolean;
}

interface PreparedReview {
  reviewRef: string;
  plan: ExamHumanReviewPlanFacts;
  artifact: ConfirmedExamReviewFactsV1;
  bytes: Buffer;
}

type ReviewEvent = ExamHumanReviewStartedEvent | ExamHumanReviewCompletedEvent;

function serviceNow(deps: ExamServiceDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function missingObject(error: unknown): boolean {
  return error instanceof MaterialByteStoreError && error.code === 'ENOENT';
}

function parseReviewRequest(input: unknown): ExamHumanReviewRequest {
  try {
    return parseExamHumanReviewRequest(input);
  } catch {
    throw new ExamError('EXAM_REVIEW_INPUT_INVALID');
  }
}

function requireReviewReady(snapshot: ExamRuntimeSnapshot): void {
  if (snapshot.state.status === 'deleting' || snapshot.state.status === 'deleted') {
    throw new ExamError('EXAM_NOT_FOUND');
  }
  if (
    snapshot.state.status !== 'ready_for_extraction' ||
    snapshot.state.questionExtraction?.status !== 'question_candidates_ready' ||
    snapshot.state.studentResponseCapture?.status !== 'matching_ready'
  ) {
    throw new ExamError('EXAM_REVIEW_NOT_READY');
  }
}

function sourcePlan(
  snapshot: ExamRuntimeSnapshot,
  decisionSemanticFingerprint: string,
): { reviewRef: string; plan: ExamHumanReviewPlanFacts } {
  requireReviewReady(snapshot);
  const extraction = snapshot.state.questionExtraction!;
  const segmentation = extraction.segmentation!;
  const questionArtifact = segmentation.candidateArtifact!;
  const capture = snapshot.state.studentResponseCapture!;
  const responseArtifact = capture.responseArtifact!;
  const matchingArtifact = capture.matchingArtifact!;
  const planSources = {
    reviewVersion: EXAM_HUMAN_REVIEW_VERSION,
    questionExtractionVersion: extraction.extractionVersion,
    questionSegmentationVersion: segmentation.segmentationVersion,
    responseCaptureVersion: capture.captureVersion,
    matchingVersion: capture.matchingVersion,
    questionCandidateArtifactRef: segmentation.candidateArtifactRef,
    sourceQuestionCandidateFingerprint: questionArtifact.sha256,
    responseArtifactRef: capture.responseArtifactRef,
    sourceResponseArtifactFingerprint: responseArtifact.sha256,
    matchingArtifactRef: capture.matchingArtifactRef,
    sourceMatchingArtifactFingerprint: matchingArtifact.sha256,
  };
  const reviewRef = deriveExamHumanReviewRef({
    examSessionId: snapshot.state.examSessionId,
    ...planSources,
  });
  return {
    reviewRef,
    plan: {
      ...planSources,
      decisionSemanticFingerprint,
      reviewArtifactRef: deriveExamHumanReviewArtifactRef(reviewRef),
    },
  };
}

function sourceFieldsMatch(state: ExamHumanReviewState, plan: ExamHumanReviewPlanFacts): boolean {
  return (
    state.reviewVersion === plan.reviewVersion &&
    state.questionExtractionVersion === plan.questionExtractionVersion &&
    state.questionSegmentationVersion === plan.questionSegmentationVersion &&
    state.responseCaptureVersion === plan.responseCaptureVersion &&
    state.matchingVersion === plan.matchingVersion &&
    state.questionCandidateArtifactRef === plan.questionCandidateArtifactRef &&
    state.sourceQuestionCandidateFingerprint === plan.sourceQuestionCandidateFingerprint &&
    state.responseArtifactRef === plan.responseArtifactRef &&
    state.sourceResponseArtifactFingerprint === plan.sourceResponseArtifactFingerprint &&
    state.matchingArtifactRef === plan.matchingArtifactRef &&
    state.sourceMatchingArtifactFingerprint === plan.sourceMatchingArtifactFingerprint &&
    state.reviewArtifactRef === plan.reviewArtifactRef
  );
}

function assertPersistedPlan(
  state: ExamHumanReviewState | undefined,
  plan: ExamHumanReviewPlanFacts,
): void {
  if (!state) return;
  if (!sourceFieldsMatch(state, plan)) throw new ExamError('EXAM_REVIEW_SOURCE_CHANGED');
  if (state.decisionSemanticFingerprint !== plan.decisionSemanticFingerprint) {
    throw new ExamError('EXAM_REVIEW_CONFLICT');
  }
}

async function verifiedSources(deps: ExamServiceDeps, snapshot: ExamRuntimeSnapshot) {
  try {
    return await resolveExamStudentResponsesFromRuntime(deps, snapshot);
  } catch (error) {
    if (isExamError(error)) throw error;
    throw new ExamError('EXAM_REVIEW_SOURCE_CHANGED');
  }
}

async function prepareReview(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  request: ExamHumanReviewRequest,
): Promise<PreparedReview> {
  const sources = await verifiedSources(deps, snapshot);
  const preparedPlan = sourcePlan(
    snapshot,
    createExamHumanReviewDecisionSemanticFingerprint(request),
  );
  assertPersistedPlan(snapshot.state.humanReview, preparedPlan.plan);
  const extraction = snapshot.state.questionExtraction!;
  const segmentation = extraction.segmentation!;
  const capture = snapshot.state.studentResponseCapture!;
  let artifact: ConfirmedExamReviewFactsV1;
  try {
    artifact = buildConfirmedExamReviewFacts({
      examSessionId: snapshot.state.examSessionId,
      reviewRef: preparedPlan.reviewRef,
      reviewArtifactRef: preparedPlan.plan.reviewArtifactRef,
      questionArtifactRef: preparedPlan.plan.questionCandidateArtifactRef,
      questionArtifactSha256: preparedPlan.plan.sourceQuestionCandidateFingerprint,
      questionExtractionVersion: extraction.extractionVersion,
      questionSegmentationVersion: segmentation.segmentationVersion,
      responseArtifactRef: preparedPlan.plan.responseArtifactRef,
      responseArtifactSha256: preparedPlan.plan.sourceResponseArtifactFingerprint,
      responseCaptureVersion: capture.captureVersion,
      matchingArtifactRef: preparedPlan.plan.matchingArtifactRef,
      matchingArtifactSha256: preparedPlan.plan.sourceMatchingArtifactFingerprint,
      matchingVersion: capture.matchingVersion,
      questionCandidatesArtifact: sources.questionCandidates,
      responseCandidatesArtifact: sources.responseCandidates,
      questionResponseMatchesArtifact: sources.questionResponseMatches,
      request,
    });
  } catch (error) {
    if (error instanceof ExamHumanReviewError) {
      if (error.code === 'EXAM_REVIEW_INCOMPLETE') {
        throw new ExamError('EXAM_REVIEW_INCOMPLETE');
      }
      if (error.code === 'EXAM_REVIEW_INPUT_INVALID') {
        throw new ExamError('EXAM_REVIEW_INPUT_INVALID');
      }
      throw new ExamError('EXAM_REVIEW_SOURCE_CHANGED');
    }
    throw new ExamError('EXAM_REVIEW_FAILED');
  }
  let bytes: Buffer;
  try {
    bytes = serializeConfirmedExamReviewFacts(artifact);
  } catch {
    throw new ExamError('EXAM_REVIEW_FAILED');
  }
  return { reviewRef: preparedPlan.reviewRef, plan: preparedPlan.plan, artifact, bytes };
}

function reviewObjectKey(snapshot: ExamRuntimeSnapshot): string {
  const review = snapshot.state.humanReview;
  if (!review) throw new ExamError('EXAM_REVIEW_NOT_READY');
  return examHumanReviewObjectKey(
    snapshot.state.examSessionId,
    review.responseCaptureVersion,
    review.matchingVersion,
    review.reviewVersion,
  );
}

async function readOptionalReviewObject(
  deps: ExamServiceDeps,
  key: string,
  failure: 'EXAM_REVIEW_FAILED' | 'EXAM_REVIEW_ARTIFACT_CORRUPT',
): Promise<Buffer | undefined> {
  try {
    return await deps.byteStore.get(key);
  } catch (error) {
    if (missingObject(error)) return undefined;
    throw new ExamError(failure);
  }
}

async function putAndVerifyReviewArtifact(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  expected: Buffer,
): Promise<void> {
  const key = reviewObjectKey(snapshot);
  const existing = await readOptionalReviewObject(deps, key, 'EXAM_REVIEW_FAILED');
  if (existing) {
    if (!existing.equals(expected)) throw new ExamError('EXAM_REVIEW_CONFLICT');
    return;
  }
  try {
    await deps.byteStore.put(key, expected, 'application/json');
  } catch {
    const recovered = await readOptionalReviewObject(deps, key, 'EXAM_REVIEW_FAILED').catch(
      () => undefined,
    );
    if (!recovered) throw new ExamError('EXAM_REVIEW_FAILED');
    if (!recovered.equals(expected)) throw new ExamError('EXAM_REVIEW_CONFLICT');
  }
  const readBack = await readOptionalReviewObject(deps, key, 'EXAM_REVIEW_FAILED');
  if (!readBack) throw new ExamError('EXAM_REVIEW_FAILED');
  if (!readBack.equals(expected)) throw new ExamError('EXAM_REVIEW_CONFLICT');
}

function startedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  plan: ExamHumanReviewPlanFacts,
): ExamHumanReviewStartedEvent {
  const operationId = deriveExamHumanReviewStartedOperationId(
    snapshot.state.examSessionId,
    plan.reviewVersion,
  );
  const facts = {
    action: 'exam_human_review_started',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    ...plan,
  } as const;
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_human_review_started',
    createdAt: serviceNow(deps),
    operationId,
    operationFingerprint: createExamOperationFingerprint(facts),
    ...plan,
  };
}

function completedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  prepared: PreparedReview,
): ExamHumanReviewCompletedEvent {
  const operationId = deriveExamHumanReviewCompletedOperationId(
    snapshot.state.examSessionId,
    prepared.plan.reviewVersion,
  );
  const artifactFacts = {
    artifactByteLength: prepared.bytes.byteLength,
    artifactSha256: sha256(prepared.bytes),
    confirmedQuestionCount: prepared.artifact.confirmedQuestionCount,
    confirmedResponseCount: prepared.artifact.confirmedResponseCount,
    confirmedMatchCount: prepared.artifact.confirmedMatchCount,
    rejectedQuestionCount: prepared.artifact.rejectedQuestionCount,
    rejectedResponseCount: prepared.artifact.rejectedResponseCount,
  } as const;
  const facts = {
    action: 'exam_human_review_completed',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    ...prepared.plan,
    ...artifactFacts,
  } as const;
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_human_review_completed',
    createdAt: serviceNow(deps),
    operationId,
    operationFingerprint: createExamOperationFingerprint(facts),
    ...prepared.plan,
    ...artifactFacts,
  };
}

async function appendReviewEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  event: ReviewEvent,
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
    throw new ExamError('EXAM_REVIEW_FAILED');
  }
}

function artifactMatchesPlan(
  artifact: ConfirmedExamReviewFactsV1,
  reviewRef: string,
  plan: ExamHumanReviewPlanFacts,
): boolean {
  return (
    artifact.reviewVersion === plan.reviewVersion &&
    artifact.reviewRef === reviewRef &&
    artifact.reviewArtifactRef === plan.reviewArtifactRef &&
    artifact.questionExtractionVersion === plan.questionExtractionVersion &&
    artifact.questionSegmentationVersion === plan.questionSegmentationVersion &&
    artifact.responseCaptureVersion === plan.responseCaptureVersion &&
    artifact.matchingVersion === plan.matchingVersion &&
    artifact.questionArtifactRef === plan.questionCandidateArtifactRef &&
    artifact.questionArtifactSha256 === plan.sourceQuestionCandidateFingerprint &&
    artifact.responseArtifactRef === plan.responseArtifactRef &&
    artifact.responseArtifactSha256 === plan.sourceResponseArtifactFingerprint &&
    artifact.matchingArtifactRef === plan.matchingArtifactRef &&
    artifact.matchingArtifactSha256 === plan.sourceMatchingArtifactFingerprint &&
    artifact.decisionSemanticFingerprint === plan.decisionSemanticFingerprint
  );
}

/** Resolve confirmed facts while the caller already owns the per-Exam mutation lock. */
export async function resolveConfirmedExamReviewFactsFromRuntime(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
): Promise<ConfirmedExamReviewFactsV1> {
  requireReviewReady(snapshot);
  const state = snapshot.state.humanReview;
  const fact = state?.reviewArtifact;
  if (!state || state.status !== 'confirmed' || !fact) {
    throw new ExamError('EXAM_REVIEW_NOT_READY');
  }
  const bytes = await readOptionalReviewObject(
    deps,
    reviewObjectKey(snapshot),
    'EXAM_REVIEW_ARTIFACT_CORRUPT',
  );
  if (!bytes || bytes.byteLength !== fact.byteLength || sha256(bytes) !== fact.sha256) {
    throw new ExamError('EXAM_REVIEW_ARTIFACT_CORRUPT');
  }
  let artifact: ConfirmedExamReviewFactsV1;
  let canonicalBytes: Buffer;
  try {
    artifact = parseConfirmedExamReviewFacts(bytes);
    canonicalBytes = serializeConfirmedExamReviewFacts(artifact);
  } catch {
    throw new ExamError('EXAM_REVIEW_ARTIFACT_CORRUPT');
  }
  const { reviewRef, plan } = sourcePlan(snapshot, state.decisionSemanticFingerprint);
  if (!sourceFieldsMatch(state, plan) || !artifactMatchesPlan(artifact, reviewRef, plan)) {
    throw new ExamError('EXAM_REVIEW_SOURCE_CHANGED');
  }
  const sources = await verifiedSources(deps, snapshot);
  let expected: ConfirmedExamReviewFactsV1;
  let expectedBytes: Buffer;
  try {
    expected = buildConfirmedExamReviewFacts({
      examSessionId: snapshot.state.examSessionId,
      reviewRef,
      reviewArtifactRef: plan.reviewArtifactRef,
      questionArtifactRef: plan.questionCandidateArtifactRef,
      questionArtifactSha256: plan.sourceQuestionCandidateFingerprint,
      questionExtractionVersion: plan.questionExtractionVersion,
      questionSegmentationVersion: plan.questionSegmentationVersion,
      responseArtifactRef: plan.responseArtifactRef,
      responseArtifactSha256: plan.sourceResponseArtifactFingerprint,
      responseCaptureVersion: plan.responseCaptureVersion,
      matchingArtifactRef: plan.matchingArtifactRef,
      matchingArtifactSha256: plan.sourceMatchingArtifactFingerprint,
      matchingVersion: plan.matchingVersion,
      questionCandidatesArtifact: sources.questionCandidates,
      responseCandidatesArtifact: sources.responseCandidates,
      questionResponseMatchesArtifact: sources.questionResponseMatches,
      request: { schemaVersion: EXAM_HUMAN_REVIEW_SCHEMA_VERSION, decisions: artifact.decisions },
    });
    expectedBytes = serializeConfirmedExamReviewFacts(expected);
  } catch {
    throw new ExamError('EXAM_REVIEW_ARTIFACT_CORRUPT');
  }
  if (
    !bytes.equals(canonicalBytes) ||
    !bytes.equals(expectedBytes) ||
    artifact.confirmedQuestionCount !== fact.confirmedQuestionCount ||
    artifact.confirmedResponseCount !== fact.confirmedResponseCount ||
    artifact.confirmedMatchCount !== fact.confirmedMatchCount ||
    artifact.rejectedQuestionCount !== fact.rejectedQuestionCount ||
    artifact.rejectedResponseCount !== fact.rejectedResponseCount
  ) {
    throw new ExamError('EXAM_REVIEW_ARTIFACT_CORRUPT');
  }
  return artifact;
}

function cloneLocator(locator: ExamQuestionLocator): ExamQuestionLocator {
  return {
    sectionPath: locator.sectionPath.map((section) => ({ ...section })),
    printedNumber: locator.printedNumber,
    subquestionPath: [...locator.subquestionPath],
  };
}

function reviewBundle(
  snapshot: ExamRuntimeSnapshot,
  sources: Awaited<ReturnType<typeof resolveExamStudentResponsesFromRuntime>>,
  confirmed?: ConfirmedExamReviewFactsV1,
): HumanReviewBundleV1 {
  const byId = new Map(
    sources.questionCandidates.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  return {
    schemaVersion: EXAM_HUMAN_REVIEW_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    subjectId: snapshot.state.subjectId,
    ...(snapshot.state.title === undefined ? {} : { title: snapshot.state.title }),
    reviewStatus: snapshot.state.humanReview?.status ?? 'not_started',
    questions: sources.questionCandidates.candidates.map((candidate) => {
      const parent = candidate.parentCandidateId
        ? byId.get(candidate.parentCandidateId)
        : undefined;
      return {
        questionCandidateId: candidate.candidateId,
        candidateKind: candidate.candidateKind,
        rawLabel: candidate.rawLabel,
        locator: cloneLocator(candidate.locator),
        text: candidate.text,
        ...(parent === undefined
          ? {}
          : {
              parentContext: {
                questionCandidateId: parent.candidateId,
                rawLabel: parent.rawLabel,
                text: parent.text,
              },
            }),
        sourceSpans: candidate.sourceSpans.map((span) => ({
          ...span,
          ...(span.bbox === undefined ? {} : { bbox: { ...span.bbox } }),
        })),
        contentStatus: candidate.contentStatus,
        confidenceBand: candidate.confidenceBand,
        diagnosticReasonCodes: [...candidate.confidenceReasonCodes],
      };
    }),
    responses: sources.responseCandidates.candidates.map((candidate) => ({
      responseCandidateId: candidate.candidateId,
      rawLabel: candidate.rawLabel,
      locator: cloneLocator(candidate.locator),
      rawAnswerText: candidate.rawAnswerText,
      answerStatus: candidate.answerStatus,
    })),
    matches: sources.questionResponseMatches.matches.map((match) => ({
      responseCandidateId: match.responseCandidateId,
      status: match.status,
      questionCandidateIds: [...match.questionCandidateIds],
      reasonCodes: [...match.reasonCodes],
    })),
    structuralDiagnostics: sources.questionCandidates.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      ...(diagnostic.locator === undefined ? {} : { locator: cloneLocator(diagnostic.locator) }),
      ...(diagnostic.candidateIds === undefined
        ? {}
        : { candidateIds: [...diagnostic.candidateIds] }),
      ...(diagnostic.subquestionPath === undefined
        ? {}
        : { subquestionPath: [...diagnostic.subquestionPath] }),
    })),
    ...(confirmed === undefined
      ? {}
      : {
          confirmed: {
            confirmedQuestions: confirmed.confirmedQuestions,
            confirmedResponses: confirmed.confirmedResponses,
            confirmedMatches: confirmed.confirmedMatches,
            rejectedQuestionCandidates: confirmed.rejectedQuestionCandidates,
            rejectedResponseCandidates: confirmed.rejectedResponseCandidates,
          },
        }),
  };
}

export async function getExamHumanReview(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<HumanReviewBundleV1> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    requireReviewReady(snapshot);
    const sources = await verifiedSources(deps, snapshot);
    const confirmed =
      snapshot.state.humanReview?.status === 'confirmed'
        ? await resolveConfirmedExamReviewFactsFromRuntime(deps, snapshot)
        : undefined;
    return reviewBundle(snapshot, sources, confirmed);
  });
}

export async function confirmExamHumanReview(
  deps: ExamServiceDeps,
  examSessionId: string,
  input: unknown,
): Promise<ConfirmExamHumanReviewResult> {
  const request = parseReviewRequest(input);
  return deps.withExamMutationLock(examSessionId, async () => {
    let snapshot = await loadExamRuntime(deps, examSessionId);
    requireReviewReady(snapshot);
    const replayed = snapshot.state.humanReview?.status === 'confirmed';
    const prepared = await prepareReview(deps, snapshot, request);

    if (!snapshot.state.humanReview) {
      snapshot = await appendReviewEvent(
        deps,
        snapshot,
        startedEvent(deps, snapshot, prepared.plan),
      );
    }
    assertPersistedPlan(snapshot.state.humanReview, prepared.plan);

    if (snapshot.state.humanReview?.status !== 'confirmed') {
      await putAndVerifyReviewArtifact(deps, snapshot, prepared.bytes);
      snapshot = await appendReviewEvent(deps, snapshot, completedEvent(deps, snapshot, prepared));
    }
    const resolved = await resolveConfirmedExamReviewFactsFromRuntime(deps, snapshot);
    if (!serializeConfirmedExamReviewFacts(resolved).equals(prepared.bytes)) {
      throw new ExamError('EXAM_REVIEW_CONFLICT');
    }
    return {
      examSessionId: snapshot.state.examSessionId,
      humanReview: toPublicExamSession(snapshot.state).humanReview,
      replayed,
    };
  });
}

export async function resolveConfirmedExamReviewFacts(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<ConfirmedExamReviewFactsV1> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    return resolveConfirmedExamReviewFactsFromRuntime(deps, snapshot);
  });
}
