import { createHash } from 'node:crypto';

import {
  examQuestionResponseMatchesObjectKey,
  examStudentResponseCandidatesObjectKey,
} from '@/lib/server/materials/object-keys';
import { MaterialByteStoreError } from '@/lib/server/materials/bytes';
import type { PublicExamSession } from '@/lib/zhongkao/exam';
import { ExamError, isExamError, type ExamErrorCode } from '@/lib/zhongkao/exam-errors';
import {
  EXAM_EVENT_SCHEMA_VERSION,
  type ExamResponseCandidatesRecordedEvent,
  type ExamResponseMatchingCompletedEvent,
  type ExamStudentResponseCaptureStartedEvent,
} from '@/lib/zhongkao/exam-event';
import type { ExamQuestionCandidatesArtifactV1 } from '@/lib/zhongkao/exam-question-candidate';
import {
  EXAM_QUESTION_RESPONSE_MATCHING_VERSION,
  EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
  ExamStudentResponseError,
  buildExamQuestionResponseMatchesArtifact,
  buildStudentResponseCandidatesArtifact,
  createExamStudentResponseInputSemanticFingerprint,
  parseExamQuestionResponseMatchesArtifact,
  parseExamStudentResponseCaptureRequest,
  parseStudentResponseCandidatesArtifact,
  serializeExamQuestionResponseMatchesArtifact,
  serializeStudentResponseCandidatesArtifact,
  type ExamQuestionResponseMatchesArtifactV1,
  type ExamStudentResponseCaptureRequest,
  type StudentResponseCandidatesArtifactV1,
} from '@/lib/zhongkao/exam-student-response';
import {
  toPublicExamSession,
  type ExamStudentResponseCaptureState,
} from '@/lib/zhongkao/exam-state';

import { resolveExamQuestionCandidatesFromRuntime } from './exam-extraction-service';
import {
  appendExamRuntimeEvent,
  createExamOperationFingerprint,
  deriveExamEventId,
  deriveExamMatchingArtifactRef,
  deriveExamResponseArtifactRef,
  deriveExamResponseCandidatesRecordedOperationId,
  deriveExamResponseCaptureRef,
  deriveExamResponseMatchingCompletedOperationId,
  deriveExamStudentResponseCaptureStartedOperationId,
  loadExamRuntime,
  type ExamRuntimeSnapshot,
} from './exam-runtime';
import type { ExamServiceDeps } from './exam-service';

export interface CaptureExamStudentResponsesResult {
  exam: PublicExamSession;
  replayed: boolean;
}

export interface ResolvedExamStudentResponses {
  responseCandidates: StudentResponseCandidatesArtifactV1;
  questionResponseMatches: ExamQuestionResponseMatchesArtifactV1;
}

interface ExamResponseCapturePlan {
  captureVersion: typeof EXAM_STUDENT_RESPONSE_CAPTURE_VERSION;
  matchingVersion: typeof EXAM_QUESTION_RESPONSE_MATCHING_VERSION;
  segmentationVersion: number;
  questionCandidateArtifactRef: string;
  sourceQuestionCandidateFingerprint: string;
  inputSemanticFingerprint: string;
  captureRef: string;
  responseArtifactRef: string;
  matchingArtifactRef: string;
}

type ExamResponseEvent =
  | ExamStudentResponseCaptureStartedEvent
  | ExamResponseCandidatesRecordedEvent
  | ExamResponseMatchingCompletedEvent;

function serviceNow(deps: ExamServiceDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isMissingObject(error: unknown): boolean {
  return error instanceof MaterialByteStoreError && error.code === 'ENOENT';
}

function parseCaptureRequest(input: unknown): ExamStudentResponseCaptureRequest {
  try {
    return parseExamStudentResponseCaptureRequest(input);
  } catch (error) {
    if (
      error instanceof ExamStudentResponseError &&
      error.code === 'EXAM_STUDENT_RESPONSE_LIMIT_EXCEEDED'
    ) {
      throw new ExamError('EXAM_RESPONSE_INPUT_TOO_LARGE');
    }
    throw new ExamError('EXAM_RESPONSE_INPUT_INVALID');
  }
}

async function readOptionalObject(
  deps: ExamServiceDeps,
  key: string,
  failure: ExamErrorCode,
): Promise<Buffer | undefined> {
  try {
    return await deps.byteStore.get(key);
  } catch (error) {
    if (isMissingObject(error)) return undefined;
    throw new ExamError(failure);
  }
}

async function putAndVerifyExpected(input: {
  deps: ExamServiceDeps;
  key: string;
  expected: Buffer;
  failure: ExamErrorCode;
  conflict: ExamErrorCode;
}): Promise<void> {
  const existing = await readOptionalObject(input.deps, input.key, input.failure);
  if (existing) {
    if (!existing.equals(input.expected)) throw new ExamError(input.conflict);
    return;
  }

  try {
    await input.deps.byteStore.put(input.key, input.expected, 'application/json');
  } catch {
    const recovered = await readOptionalObject(input.deps, input.key, input.failure).catch(
      () => undefined,
    );
    if (!recovered) throw new ExamError(input.failure);
    if (!recovered.equals(input.expected)) throw new ExamError(input.conflict);
  }

  const readBack = await readOptionalObject(input.deps, input.key, input.failure);
  if (!readBack) throw new ExamError(input.failure);
  if (!readBack.equals(input.expected)) throw new ExamError(input.conflict);
}

async function appendResponseEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  event: ExamResponseEvent,
  failure: ExamErrorCode,
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
    throw new ExamError(failure);
  }
}

function responseCapturePlan(input: {
  snapshot: ExamRuntimeSnapshot;
  questionCandidates: ExamQuestionCandidatesArtifactV1;
  responseCandidates: StudentResponseCandidatesArtifactV1;
}): ExamResponseCapturePlan {
  const extraction = input.snapshot.state.questionExtraction;
  const segmentation = extraction?.segmentation;
  const questionFact = segmentation?.candidateArtifact;
  if (
    extraction?.status !== 'question_candidates_ready' ||
    !segmentation ||
    !questionFact ||
    input.questionCandidates.segmentationVersion !== segmentation.segmentationVersion
  ) {
    throw new ExamError('EXAM_RESPONSES_NOT_READY');
  }
  const captureRef = deriveExamResponseCaptureRef(
    input.snapshot.state.examSessionId,
    EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
    segmentation.segmentationVersion,
    questionFact.sha256,
  );
  const responseArtifactRef = deriveExamResponseArtifactRef(captureRef);
  const matchingArtifactRef = deriveExamMatchingArtifactRef(
    captureRef,
    EXAM_QUESTION_RESPONSE_MATCHING_VERSION,
  );
  if (
    input.responseCandidates.captureRef !== captureRef ||
    input.responseCandidates.responseArtifactRef !== responseArtifactRef ||
    input.responseCandidates.questionCandidateArtifactRef !== segmentation.candidateArtifactRef ||
    input.responseCandidates.questionCandidateArtifactSha256 !== questionFact.sha256 ||
    input.responseCandidates.questionSegmentationVersion !== segmentation.segmentationVersion
  ) {
    throw new ExamError('EXAM_RESPONSE_CAPTURE_FAILED');
  }
  return {
    captureVersion: EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
    matchingVersion: EXAM_QUESTION_RESPONSE_MATCHING_VERSION,
    segmentationVersion: segmentation.segmentationVersion,
    questionCandidateArtifactRef: segmentation.candidateArtifactRef,
    sourceQuestionCandidateFingerprint: questionFact.sha256,
    inputSemanticFingerprint: input.responseCandidates.inputSemanticFingerprint,
    captureRef,
    responseArtifactRef,
    matchingArtifactRef,
  };
}

function captureStartedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  plan: ExamResponseCapturePlan,
): ExamStudentResponseCaptureStartedEvent {
  const operationId = deriveExamStudentResponseCaptureStartedOperationId(
    snapshot.state.examSessionId,
    plan.captureVersion,
    plan.segmentationVersion,
    plan.sourceQuestionCandidateFingerprint,
  );
  const facts = {
    action: 'exam_student_response_capture_started',
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
    eventType: 'exam_student_response_capture_started',
    createdAt: serviceNow(deps),
    operationId,
    operationFingerprint: createExamOperationFingerprint(facts),
    ...plan,
  };
}

function candidatesRecordedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  plan: ExamResponseCapturePlan,
  bytes: Buffer,
  artifact: StudentResponseCandidatesArtifactV1,
): ExamResponseCandidatesRecordedEvent {
  const operationId = deriveExamResponseCandidatesRecordedOperationId(
    snapshot.state.examSessionId,
    plan.captureVersion,
    plan.segmentationVersion,
    plan.sourceQuestionCandidateFingerprint,
  );
  const facts = {
    action: 'exam_response_candidates_recorded',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    ...plan,
    artifactByteLength: bytes.byteLength,
    artifactSha256: sha256(bytes),
    responseCount: artifact.candidateCount,
  } as const;
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_response_candidates_recorded',
    createdAt: serviceNow(deps),
    operationId,
    operationFingerprint: createExamOperationFingerprint(facts),
    ...plan,
    artifactByteLength: facts.artifactByteLength,
    artifactSha256: facts.artifactSha256,
    responseCount: facts.responseCount,
  };
}

function matchingCompletedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  plan: ExamResponseCapturePlan,
  responseBytes: Buffer,
  matchingBytes: Buffer,
  artifact: ExamQuestionResponseMatchesArtifactV1,
): ExamResponseMatchingCompletedEvent {
  const operationId = deriveExamResponseMatchingCompletedOperationId(
    snapshot.state.examSessionId,
    plan.captureVersion,
    plan.matchingVersion,
    plan.segmentationVersion,
    plan.sourceQuestionCandidateFingerprint,
  );
  const facts = {
    action: 'exam_response_matching_completed',
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    ...plan,
    responseArtifactFingerprint: sha256(responseBytes),
    artifactByteLength: matchingBytes.byteLength,
    artifactSha256: sha256(matchingBytes),
    responseCount: artifact.matchCount,
    matchedCount: artifact.matchedCount,
    ambiguousCount: artifact.ambiguousCount,
    unmatchedCount: artifact.unmatchedCount,
    needsReview: true as const,
  };
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_response_matching_completed',
    createdAt: serviceNow(deps),
    operationId,
    operationFingerprint: createExamOperationFingerprint(facts),
    ...plan,
    responseArtifactFingerprint: facts.responseArtifactFingerprint,
    artifactByteLength: facts.artifactByteLength,
    artifactSha256: facts.artifactSha256,
    responseCount: facts.responseCount,
    matchedCount: facts.matchedCount,
    ambiguousCount: facts.ambiguousCount,
    unmatchedCount: facts.unmatchedCount,
    needsReview: facts.needsReview,
  };
}

function capturePlanMatches(
  capture: ExamStudentResponseCaptureState,
  plan: ExamResponseCapturePlan,
): boolean {
  return (
    capture.captureVersion === plan.captureVersion &&
    capture.matchingVersion === plan.matchingVersion &&
    capture.segmentationVersion === plan.segmentationVersion &&
    capture.questionCandidateArtifactRef === plan.questionCandidateArtifactRef &&
    capture.sourceQuestionCandidateFingerprint === plan.sourceQuestionCandidateFingerprint &&
    capture.inputSemanticFingerprint === plan.inputSemanticFingerprint &&
    capture.captureRef === plan.captureRef &&
    capture.responseArtifactRef === plan.responseArtifactRef &&
    capture.matchingArtifactRef === plan.matchingArtifactRef
  );
}

function assertCapturePlan(snapshot: ExamRuntimeSnapshot, plan: ExamResponseCapturePlan): void {
  const capture = snapshot.state.studentResponseCapture;
  if (capture && !capturePlanMatches(capture, plan)) {
    throw new ExamError('EXAM_RESPONSE_CAPTURE_CONFLICT');
  }
}

function responseObjectKey(snapshot: ExamRuntimeSnapshot): string {
  const capture = snapshot.state.studentResponseCapture;
  if (!capture) throw new ExamError('EXAM_RESPONSES_NOT_READY');
  return examStudentResponseCandidatesObjectKey(
    snapshot.state.examSessionId,
    capture.captureVersion,
  );
}

function matchingObjectKey(snapshot: ExamRuntimeSnapshot): string {
  const capture = snapshot.state.studentResponseCapture;
  if (!capture) throw new ExamError('EXAM_RESPONSES_NOT_READY');
  return examQuestionResponseMatchesObjectKey(
    snapshot.state.examSessionId,
    capture.captureVersion,
    capture.matchingVersion,
  );
}

async function resolveResponseCandidatesFromRuntime(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
): Promise<{ artifact: StudentResponseCandidatesArtifactV1; bytes: Buffer }> {
  const capture = snapshot.state.studentResponseCapture;
  const fact = capture?.responseArtifact;
  if (!capture || !fact) throw new ExamError('EXAM_RESPONSES_NOT_READY');
  const bytes = await readOptionalObject(
    deps,
    responseObjectKey(snapshot),
    'EXAM_RESPONSE_ARTIFACT_CORRUPT',
  );
  if (!bytes || bytes.byteLength !== fact.byteLength || sha256(bytes) !== fact.sha256) {
    throw new ExamError('EXAM_RESPONSE_ARTIFACT_CORRUPT');
  }

  let artifact: StudentResponseCandidatesArtifactV1;
  let canonicalBytes: Buffer;
  try {
    artifact = parseStudentResponseCandidatesArtifact(bytes);
    canonicalBytes = serializeStudentResponseCandidatesArtifact(artifact);
  } catch {
    throw new ExamError('EXAM_RESPONSE_ARTIFACT_CORRUPT');
  }
  if (
    !bytes.equals(canonicalBytes) ||
    artifact.examSessionId !== snapshot.state.examSessionId ||
    artifact.captureVersion !== capture.captureVersion ||
    artifact.captureRef !== capture.captureRef ||
    artifact.responseArtifactRef !== capture.responseArtifactRef ||
    artifact.inputSemanticFingerprint !== capture.inputSemanticFingerprint ||
    artifact.inputSemanticFingerprint !==
      createExamStudentResponseInputSemanticFingerprint(artifact) ||
    artifact.questionCandidateArtifactRef !== capture.questionCandidateArtifactRef ||
    artifact.questionCandidateArtifactSha256 !== capture.sourceQuestionCandidateFingerprint ||
    artifact.questionSegmentationVersion !== capture.segmentationVersion ||
    artifact.candidateCount !== fact.responseCount
  ) {
    throw new ExamError('EXAM_RESPONSE_ARTIFACT_CORRUPT');
  }
  return { artifact, bytes };
}

async function resolveQuestionResponseMatchesFromRuntime(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  questionCandidates: ExamQuestionCandidatesArtifactV1,
  response: { artifact: StudentResponseCandidatesArtifactV1; bytes: Buffer },
): Promise<ExamQuestionResponseMatchesArtifactV1> {
  const capture = snapshot.state.studentResponseCapture;
  const fact = capture?.matchingArtifact;
  if (!capture || !capture.responseArtifact || !fact) {
    throw new ExamError('EXAM_RESPONSES_NOT_READY');
  }
  const bytes = await readOptionalObject(
    deps,
    matchingObjectKey(snapshot),
    'EXAM_RESPONSE_ARTIFACT_CORRUPT',
  );
  if (!bytes || bytes.byteLength !== fact.byteLength || sha256(bytes) !== fact.sha256) {
    throw new ExamError('EXAM_RESPONSE_ARTIFACT_CORRUPT');
  }

  let artifact: ExamQuestionResponseMatchesArtifactV1;
  let canonicalBytes: Buffer;
  let expectedBytes: Buffer;
  try {
    artifact = parseExamQuestionResponseMatchesArtifact(bytes);
    canonicalBytes = serializeExamQuestionResponseMatchesArtifact(artifact);
    expectedBytes = serializeExamQuestionResponseMatchesArtifact(
      buildExamQuestionResponseMatchesArtifact({
        examSessionId: snapshot.state.examSessionId,
        matchingArtifactRef: capture.matchingArtifactRef,
        questionCandidateArtifactRef: capture.questionCandidateArtifactRef,
        questionCandidateArtifactSha256: capture.sourceQuestionCandidateFingerprint,
        responseArtifactRef: capture.responseArtifactRef,
        questionCandidatesArtifact: questionCandidates,
        responseCandidatesArtifact: response.artifact,
      }),
    );
  } catch {
    throw new ExamError('EXAM_RESPONSE_ARTIFACT_CORRUPT');
  }
  if (
    !bytes.equals(canonicalBytes) ||
    !bytes.equals(expectedBytes) ||
    artifact.examSessionId !== snapshot.state.examSessionId ||
    artifact.matchingVersion !== capture.matchingVersion ||
    artifact.matchingArtifactRef !== capture.matchingArtifactRef ||
    artifact.questionCandidateArtifactRef !== capture.questionCandidateArtifactRef ||
    artifact.questionCandidateArtifactSha256 !== capture.sourceQuestionCandidateFingerprint ||
    artifact.questionSegmentationVersion !== capture.segmentationVersion ||
    artifact.responseArtifactRef !== capture.responseArtifactRef ||
    artifact.responseArtifactSha256 !== capture.responseArtifact.sha256 ||
    artifact.responseArtifactSha256 !== sha256(response.bytes) ||
    artifact.responseCaptureVersion !== capture.captureVersion ||
    artifact.matchCount !== fact.responseCount ||
    artifact.matchedCount !== fact.matchedCount ||
    artifact.ambiguousCount !== fact.ambiguousCount ||
    artifact.unmatchedCount !== fact.unmatchedCount ||
    artifact.needsReview !== fact.needsReview
  ) {
    throw new ExamError('EXAM_RESPONSE_ARTIFACT_CORRUPT');
  }
  return artifact;
}

function buildResponseCandidates(input: {
  snapshot: ExamRuntimeSnapshot;
  request: ExamStudentResponseCaptureRequest;
}): {
  questionFact: NonNullable<
    NonNullable<
      NonNullable<ExamRuntimeSnapshot['state']['questionExtraction']>['segmentation']
    >['candidateArtifact']
  >;
  artifact: StudentResponseCandidatesArtifactV1;
} {
  const extraction = input.snapshot.state.questionExtraction;
  const segmentation = extraction?.segmentation;
  const questionFact = segmentation?.candidateArtifact;
  if (extraction?.status !== 'question_candidates_ready' || !segmentation || !questionFact) {
    throw new ExamError('EXAM_RESPONSES_NOT_READY');
  }
  const captureRef = deriveExamResponseCaptureRef(
    input.snapshot.state.examSessionId,
    EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
    segmentation.segmentationVersion,
    questionFact.sha256,
  );
  try {
    return {
      questionFact,
      artifact: buildStudentResponseCandidatesArtifact({
        examSessionId: input.snapshot.state.examSessionId,
        captureVersion: EXAM_STUDENT_RESPONSE_CAPTURE_VERSION,
        captureRef,
        responseArtifactRef: deriveExamResponseArtifactRef(captureRef),
        questionCandidateArtifactRef: segmentation.candidateArtifactRef,
        questionCandidateArtifactSha256: questionFact.sha256,
        questionSegmentationVersion: segmentation.segmentationVersion,
        request: input.request,
      }),
    };
  } catch (error) {
    if (error instanceof ExamStudentResponseError) {
      if (error.code === 'EXAM_STUDENT_RESPONSE_LIMIT_EXCEEDED') {
        throw new ExamError('EXAM_RESPONSE_INPUT_TOO_LARGE');
      }
      if (error.code === 'EXAM_STUDENT_RESPONSE_INPUT_INVALID') {
        throw new ExamError('EXAM_RESPONSE_INPUT_INVALID');
      }
    }
    throw new ExamError('EXAM_RESPONSE_CAPTURE_FAILED');
  }
}

function buildMatches(input: {
  snapshot: ExamRuntimeSnapshot;
  plan: ExamResponseCapturePlan;
  questionCandidates: ExamQuestionCandidatesArtifactV1;
  responseCandidates: StudentResponseCandidatesArtifactV1;
}): ExamQuestionResponseMatchesArtifactV1 {
  try {
    return buildExamQuestionResponseMatchesArtifact({
      examSessionId: input.snapshot.state.examSessionId,
      matchingArtifactRef: input.plan.matchingArtifactRef,
      questionCandidateArtifactRef: input.plan.questionCandidateArtifactRef,
      questionCandidateArtifactSha256: input.plan.sourceQuestionCandidateFingerprint,
      responseArtifactRef: input.plan.responseArtifactRef,
      questionCandidatesArtifact: input.questionCandidates,
      responseCandidatesArtifact: input.responseCandidates,
    });
  } catch {
    throw new ExamError('EXAM_RESPONSE_MATCHING_FAILED');
  }
}

async function ensureResponseCandidates(input: {
  deps: ExamServiceDeps;
  snapshot: ExamRuntimeSnapshot;
  plan: ExamResponseCapturePlan;
  prepared: StudentResponseCandidatesArtifactV1;
}): Promise<{
  snapshot: ExamRuntimeSnapshot;
  response: { artifact: StudentResponseCandidatesArtifactV1; bytes: Buffer };
}> {
  let snapshot = input.snapshot;
  let preparedBytes: Buffer;
  try {
    preparedBytes = serializeStudentResponseCandidatesArtifact(input.prepared);
  } catch {
    throw new ExamError('EXAM_RESPONSE_CAPTURE_FAILED');
  }

  if (!snapshot.state.studentResponseCapture?.responseArtifact) {
    await putAndVerifyExpected({
      deps: input.deps,
      key: responseObjectKey(snapshot),
      expected: preparedBytes,
      failure: 'EXAM_RESPONSE_CAPTURE_FAILED',
      conflict: 'EXAM_RESPONSE_CAPTURE_CONFLICT',
    });
    snapshot = await appendResponseEvent(
      input.deps,
      snapshot,
      candidatesRecordedEvent(input.deps, snapshot, input.plan, preparedBytes, input.prepared),
      'EXAM_RESPONSE_CAPTURE_FAILED',
    );
  }

  const response = await resolveResponseCandidatesFromRuntime(input.deps, snapshot);
  if (!response.bytes.equals(preparedBytes)) {
    throw new ExamError('EXAM_RESPONSE_CAPTURE_CONFLICT');
  }
  return { snapshot, response };
}

async function ensureQuestionResponseMatches(input: {
  deps: ExamServiceDeps;
  snapshot: ExamRuntimeSnapshot;
  plan: ExamResponseCapturePlan;
  questionCandidates: ExamQuestionCandidatesArtifactV1;
  response: { artifact: StudentResponseCandidatesArtifactV1; bytes: Buffer };
}): Promise<ExamRuntimeSnapshot> {
  let snapshot = input.snapshot;
  const artifact = buildMatches({
    snapshot,
    plan: input.plan,
    questionCandidates: input.questionCandidates,
    responseCandidates: input.response.artifact,
  });
  let bytes: Buffer;
  try {
    bytes = serializeExamQuestionResponseMatchesArtifact(artifact);
  } catch {
    throw new ExamError('EXAM_RESPONSE_MATCHING_FAILED');
  }

  if (!snapshot.state.studentResponseCapture?.matchingArtifact) {
    await putAndVerifyExpected({
      deps: input.deps,
      key: matchingObjectKey(snapshot),
      expected: bytes,
      failure: 'EXAM_RESPONSE_MATCHING_FAILED',
      conflict: 'EXAM_RESPONSE_MATCHING_CONFLICT',
    });
    snapshot = await appendResponseEvent(
      input.deps,
      snapshot,
      matchingCompletedEvent(
        input.deps,
        snapshot,
        input.plan,
        input.response.bytes,
        bytes,
        artifact,
      ),
      'EXAM_RESPONSE_MATCHING_FAILED',
    );
  }

  await resolveQuestionResponseMatchesFromRuntime(
    input.deps,
    snapshot,
    input.questionCandidates,
    input.response,
  );
  return snapshot;
}

export async function captureExamStudentResponses(
  deps: ExamServiceDeps,
  examSessionId: string,
  input: unknown,
): Promise<CaptureExamStudentResponsesResult> {
  const request = parseCaptureRequest(input);
  return deps.withExamMutationLock(examSessionId, async () => {
    let snapshot = await loadExamRuntime(deps, examSessionId);
    if (snapshot.state.status === 'deleted' || snapshot.state.status === 'deleting') {
      throw new ExamError('EXAM_NOT_FOUND');
    }
    if (snapshot.state.status !== 'ready_for_extraction') {
      throw new ExamError('EXAM_RESPONSES_NOT_READY');
    }
    if (snapshot.state.questionExtraction?.status !== 'question_candidates_ready') {
      throw new ExamError('EXAM_RESPONSES_NOT_READY');
    }

    const questionCandidates = await resolveExamQuestionCandidatesFromRuntime(deps, snapshot);
    const prepared = buildResponseCandidates({ snapshot, request }).artifact;
    const plan = responseCapturePlan({
      snapshot,
      questionCandidates,
      responseCandidates: prepared,
    });
    assertCapturePlan(snapshot, plan);
    const replayed = snapshot.state.studentResponseCapture?.status === 'matching_ready';

    if (!snapshot.state.studentResponseCapture) {
      snapshot = await appendResponseEvent(
        deps,
        snapshot,
        captureStartedEvent(deps, snapshot, plan),
        'EXAM_RESPONSE_CAPTURE_FAILED',
      );
    }

    const responseResult = await ensureResponseCandidates({
      deps,
      snapshot,
      plan,
      prepared,
    });
    snapshot = await ensureQuestionResponseMatches({
      deps,
      snapshot: responseResult.snapshot,
      plan,
      questionCandidates,
      response: responseResult.response,
    });
    if (snapshot.state.studentResponseCapture?.status !== 'matching_ready') {
      throw new ExamError('EXAM_RESPONSE_MATCHING_FAILED');
    }
    return { exam: toPublicExamSession(snapshot.state), replayed };
  });
}

export async function resolveExamStudentResponseCandidates(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<StudentResponseCandidatesArtifactV1> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    if (snapshot.state.status !== 'ready_for_extraction') throw new ExamError('EXAM_NOT_FOUND');
    return (await resolveResponseCandidatesFromRuntime(deps, snapshot)).artifact;
  });
}

export async function resolveExamQuestionResponseMatches(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<ExamQuestionResponseMatchesArtifactV1> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    if (snapshot.state.status !== 'ready_for_extraction') throw new ExamError('EXAM_NOT_FOUND');
    const questionCandidates = await resolveExamQuestionCandidatesFromRuntime(deps, snapshot);
    const response = await resolveResponseCandidatesFromRuntime(deps, snapshot);
    return resolveQuestionResponseMatchesFromRuntime(deps, snapshot, questionCandidates, response);
  });
}

export async function resolveExamStudentResponses(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<ResolvedExamStudentResponses> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    if (snapshot.state.status !== 'ready_for_extraction') throw new ExamError('EXAM_NOT_FOUND');
    const questionCandidates = await resolveExamQuestionCandidatesFromRuntime(deps, snapshot);
    const response = await resolveResponseCandidatesFromRuntime(deps, snapshot);
    return {
      responseCandidates: response.artifact,
      questionResponseMatches: await resolveQuestionResponseMatchesFromRuntime(
        deps,
        snapshot,
        questionCandidates,
        response,
      ),
    };
  });
}
