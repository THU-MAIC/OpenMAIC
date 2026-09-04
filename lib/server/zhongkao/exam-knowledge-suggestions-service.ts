import { createHash } from 'node:crypto';

import type { AICallFn } from '@openmaic/generation';

import { createGenerationAiCallFactory } from '@/lib/server/agent-runtime/generation-ai-call';
import { examKnowledgeSuggestionsObjectKey } from '@/lib/server/materials/object-keys';
import { MaterialByteStoreError } from '@/lib/server/materials/bytes';
import { ExamError, isExamError } from '@/lib/zhongkao/exam-errors';
import {
  EXAM_EVENT_SCHEMA_VERSION,
  type ExamKnowledgeSuggestionsCompletedEvent,
  type ExamKnowledgeSuggestionsPlanFacts,
  type ExamKnowledgeSuggestionsStartedEvent,
} from '@/lib/zhongkao/exam-event';
import type { ConfirmedExamReviewFactsV1 } from '@/lib/zhongkao/exam-human-review';
import type { ExamKnowledgeSuggestionsState } from '@/lib/zhongkao/exam-state';

import {
  collectExamKnowledgeCandidatePool,
  ExamKnowledgeCandidatePoolError,
  parseExamKnowledgeCandidatePool,
  type ExamKnowledgeCandidatePoolV1,
} from './exam-knowledge-candidate-pool';
import {
  EXAM_KNOWLEDGE_SUGGESTION_CANDIDATE_SCHEMA_VERSION,
  EXAM_KNOWLEDGE_SUGGESTION_GENERATOR_VERSION,
  ExamKnowledgeSuggestionsGeneratorError,
  generateExamKnowledgeSuggestionDrafts,
} from './exam-knowledge-suggestions-generator';
import {
  EXAM_KNOWLEDGE_SUGGESTION_GENERATION_VERSION,
  ExamKnowledgeSuggestionsPrivateError,
  buildExamKnowledgeSuggestionsArtifact,
  parseExamKnowledgeSuggestionsArtifact,
  serializeExamKnowledgeSuggestionsArtifact,
  toPublicExamKnowledgeSuggestionsBundle,
  type ExamKnowledgeSuggestionDraftV1,
  type ExamKnowledgeSuggestionQuestionDraftV1,
  type ExamKnowledgeSuggestionsArtifactV1,
  type PublicExamKnowledgeSuggestionsBundleV1,
} from './exam-knowledge-suggestions-private';
import { resolveConfirmedExamReviewFactsFromRuntime } from './exam-human-review-service';
import {
  appendExamRuntimeEvent,
  createExamOperationFingerprint,
  deriveExamEventId,
  deriveExamKnowledgeSuggestionsArtifactRef,
  deriveExamKnowledgeSuggestionsCompletedOperationId,
  deriveExamKnowledgeSuggestionsGenerationRef,
  deriveExamKnowledgeSuggestionsStartedOperationId,
  loadExamRuntime,
  type ExamRuntimeSnapshot,
} from './exam-runtime';
import { defaultExamServiceDeps, type ExamServiceDeps } from './exam-service';

export type ExamKnowledgeCandidatePoolResolver = (
  deps: ExamServiceDeps,
  profileId: string,
  subjectId: string,
) => Promise<ExamKnowledgeCandidatePoolV1>;

export type ExamKnowledgeSuggestionDraftGenerator = (
  call: AICallFn,
  input: {
    questions: readonly {
      subjectId: string;
      confirmedQuestionId: string;
      questionText: string;
      parentContext?: { questionText: string };
    }[];
    existingKnowledgePointIds: readonly string[];
  },
  signal?: AbortSignal,
) => Promise<ExamKnowledgeSuggestionQuestionDraftV1[]>;

export interface ExamKnowledgeSuggestionsServiceDeps extends ExamServiceDeps {
  knowledgeSuggestionAiCall: AICallFn;
  resolveKnowledgeCandidatePool: ExamKnowledgeCandidatePoolResolver;
  generateKnowledgeSuggestionDrafts: ExamKnowledgeSuggestionDraftGenerator;
  abortSignal?: AbortSignal;
}

export interface GenerateExamKnowledgeSuggestionsResult {
  examSessionId: string;
  knowledgeSuggestions: PublicExamKnowledgeSuggestionsBundleV1;
  replayed: boolean;
}

interface GenerationContext {
  snapshot: ExamRuntimeSnapshot;
  confirmedReview: ConfirmedExamReviewFactsV1;
  confirmedReviewArtifactSha256: string;
  pool: ExamKnowledgeCandidatePoolV1;
  plan: ExamKnowledgeSuggestionsPlanFacts;
}

interface PreparedArtifact {
  artifact: ExamKnowledgeSuggestionsArtifactV1;
  bytes: Buffer;
}

type ReservationResult =
  | { kind: 'resolved'; result: GenerateExamKnowledgeSuggestionsResult }
  | { kind: 'generate'; context: GenerationContext };

const FLIGHTS_SYMBOL = Symbol.for('openmaic.zhongkao.exam-knowledge-suggestions-flights');
const globalFlights = globalThis as typeof globalThis & {
  [FLIGHTS_SYMBOL]?: Map<string, Promise<GenerateExamKnowledgeSuggestionsResult>>;
};
const generationFlights = (globalFlights[FLIGHTS_SYMBOL] ??= new Map());
export const EXAM_KNOWLEDGE_SUGGESTIONS_MAX_OUTPUT_TOKENS = 32_768;

function now(deps: ExamServiceDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isMissingObject(error: unknown): boolean {
  return error instanceof MaterialByteStoreError && error.code === 'ENOENT';
}

function requireGenerationReady(snapshot: ExamRuntimeSnapshot): void {
  if (snapshot.state.status === 'deleting' || snapshot.state.status === 'deleted') {
    throw new ExamError('EXAM_NOT_FOUND');
  }
  if (
    snapshot.state.status !== 'ready_for_extraction' ||
    snapshot.state.humanReview?.status !== 'confirmed' ||
    !snapshot.state.humanReview.reviewArtifact
  ) {
    throw new ExamError('EXAM_KNOWLEDGE_SUGGESTIONS_NOT_READY');
  }
  if (snapshot.state.knowledgeMapping?.status === 'confirmed') {
    throw new ExamError('EXAM_KNOWLEDGE_SUGGESTIONS_ALREADY_CONFIRMED');
  }
  if (snapshot.state.knowledgeMapping) {
    throw new ExamError('EXAM_KNOWLEDGE_SUGGESTION_CONFLICT');
  }
}

function mapReviewError(error: unknown): ExamError {
  if (!isExamError(error)) return new ExamError('EXAM_KNOWLEDGE_SUGGESTION_FAILED');
  switch (error.code) {
    case 'EXAM_NOT_FOUND':
    case 'EXAM_EVENT_CONFLICT':
    case 'EXAM_SESSION_CONFLICT':
      return error;
    case 'EXAM_REVIEW_NOT_READY':
      return new ExamError('EXAM_KNOWLEDGE_SUGGESTIONS_NOT_READY');
    case 'EXAM_REVIEW_SOURCE_CHANGED':
    case 'EXAM_REVIEW_ARTIFACT_CORRUPT':
      return new ExamError('EXAM_KNOWLEDGE_SUGGESTION_SOURCE_CHANGED');
    default:
      return new ExamError('EXAM_KNOWLEDGE_SUGGESTION_FAILED');
  }
}

async function resolveReview(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
): Promise<ConfirmedExamReviewFactsV1> {
  try {
    return await resolveConfirmedExamReviewFactsFromRuntime(deps, snapshot);
  } catch (error) {
    throw mapReviewError(error);
  }
}

function createPlan(
  snapshot: ExamRuntimeSnapshot,
  confirmedReview: ConfirmedExamReviewFactsV1,
  pool: ExamKnowledgeCandidatePoolV1,
): ExamKnowledgeSuggestionsPlanFacts {
  const review = snapshot.state.humanReview;
  const reviewArtifact = review?.reviewArtifact;
  if (!review || review.status !== 'confirmed' || !reviewArtifact) {
    throw new ExamError('EXAM_KNOWLEDGE_SUGGESTIONS_NOT_READY');
  }
  const planWithoutRefs = {
    generationVersion: EXAM_KNOWLEDGE_SUGGESTION_GENERATION_VERSION,
    subjectId: snapshot.state.subjectId,
    generatorVersion: EXAM_KNOWLEDGE_SUGGESTION_GENERATOR_VERSION,
    candidateSchemaVersion: EXAM_KNOWLEDGE_SUGGESTION_CANDIDATE_SCHEMA_VERSION,
    reviewVersion: confirmedReview.reviewVersion,
    reviewArtifactRef: confirmedReview.reviewArtifactRef,
    sourceReviewArtifactFingerprint: reviewArtifact.sha256,
    sourceReviewSemanticFingerprint: confirmedReview.decisionSemanticFingerprint,
    candidatePoolMode: pool.mode,
    candidatePoolFingerprint: pool.fingerprint,
  } as const;
  const generationRef = deriveExamKnowledgeSuggestionsGenerationRef({
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    ...planWithoutRefs,
  });
  return {
    ...planWithoutRefs,
    generationRef,
    suggestionArtifactRef: deriveExamKnowledgeSuggestionsArtifactRef(generationRef),
  };
}

function planMatches(
  state: ExamKnowledgeSuggestionsState,
  plan: ExamKnowledgeSuggestionsPlanFacts,
): boolean {
  return (
    state.generationVersion === plan.generationVersion &&
    state.subjectId === plan.subjectId &&
    state.generatorVersion === plan.generatorVersion &&
    state.candidateSchemaVersion === plan.candidateSchemaVersion &&
    state.reviewVersion === plan.reviewVersion &&
    state.reviewArtifactRef === plan.reviewArtifactRef &&
    state.sourceReviewArtifactFingerprint === plan.sourceReviewArtifactFingerprint &&
    state.sourceReviewSemanticFingerprint === plan.sourceReviewSemanticFingerprint &&
    state.candidatePoolMode === plan.candidatePoolMode &&
    state.candidatePoolFingerprint === plan.candidatePoolFingerprint &&
    state.generationRef === plan.generationRef &&
    state.suggestionArtifactRef === plan.suggestionArtifactRef
  );
}

function planFromState(state: ExamKnowledgeSuggestionsState): ExamKnowledgeSuggestionsPlanFacts {
  return {
    generationVersion: state.generationVersion,
    subjectId: state.subjectId,
    generatorVersion: state.generatorVersion,
    candidateSchemaVersion: state.candidateSchemaVersion,
    reviewVersion: state.reviewVersion,
    reviewArtifactRef: state.reviewArtifactRef,
    sourceReviewArtifactFingerprint: state.sourceReviewArtifactFingerprint,
    sourceReviewSemanticFingerprint: state.sourceReviewSemanticFingerprint,
    candidatePoolMode: state.candidatePoolMode,
    candidatePoolFingerprint: state.candidatePoolFingerprint,
    generationRef: state.generationRef,
    suggestionArtifactRef: state.suggestionArtifactRef,
  };
}

function objectKey(snapshot: ExamRuntimeSnapshot): string {
  const suggestions = snapshot.state.knowledgeSuggestions;
  if (!suggestions) throw new ExamError('EXAM_KNOWLEDGE_SUGGESTIONS_NOT_READY');
  return examKnowledgeSuggestionsObjectKey(
    snapshot.state.examSessionId,
    suggestions.generationVersion,
  );
}

async function readOptionalObject(
  deps: ExamServiceDeps,
  key: string,
  failureCode: 'EXAM_KNOWLEDGE_SUGGESTION_FAILED' | 'EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT',
): Promise<Buffer | undefined> {
  try {
    return await deps.byteStore.get(key);
  } catch (error) {
    if (isMissingObject(error)) return undefined;
    throw new ExamError(failureCode);
  }
}

function artifactQuestionDrafts(
  artifact: ExamKnowledgeSuggestionsArtifactV1,
  confirmedReview: ConfirmedExamReviewFactsV1,
): ExamKnowledgeSuggestionQuestionDraftV1[] {
  const sourceQuestions = new Map(
    confirmedReview.confirmedQuestions.map((question) => [question.confirmedQuestionId, question]),
  );
  if (
    sourceQuestions.size !== confirmedReview.confirmedQuestions.length ||
    sourceQuestions.size !== artifact.questions.length ||
    artifact.questions.some((question) => !sourceQuestions.has(question.confirmedQuestionId))
  ) {
    throw new ExamError('EXAM_KNOWLEDGE_SUGGESTION_SOURCE_CHANGED');
  }
  return artifact.questions.map((question) => {
    const sourceQuestion = sourceQuestions.get(question.confirmedQuestionId)!;
    return {
      confirmedQuestionId: question.confirmedQuestionId,
      questionText: sourceQuestion.questionText,
      ...(sourceQuestion.parentContext
        ? { parentContext: { questionText: sourceQuestion.parentContext.questionText } }
        : {}),
      generationStatus: question.generationStatus,
      suggestions: question.suggestions.map((candidate): ExamKnowledgeSuggestionDraftV1 => {
        if (candidate.kind === 'existing_knowledge_point') {
          return {
            kind: candidate.kind,
            knowledgePointId: candidate.knowledgePointId,
            confidenceBand: candidate.confidenceBand,
            evidencePhrases: [...candidate.evidencePhrases],
          };
        }
        return {
          kind: candidate.kind,
          proposedLabel: candidate.proposedLabel,
          confidenceBand: candidate.confidenceBand,
          evidencePhrases: [...candidate.evidencePhrases],
        };
      }),
    };
  });
}

function artifactPlanMatches(
  artifact: ExamKnowledgeSuggestionsArtifactV1,
  snapshot: ExamRuntimeSnapshot,
  plan: ExamKnowledgeSuggestionsPlanFacts,
): boolean {
  return (
    artifact.examSessionId === snapshot.state.examSessionId &&
    artifact.profileId === snapshot.state.profileId &&
    artifact.subjectId === snapshot.state.subjectId &&
    artifact.generationVersion === plan.generationVersion &&
    artifact.generationRef === plan.generationRef &&
    artifact.suggestionArtifactRef === plan.suggestionArtifactRef &&
    artifact.generator.generatorVersion === plan.generatorVersion &&
    artifact.generator.candidateSchemaVersion === plan.candidateSchemaVersion &&
    artifact.sourceReview.reviewVersion === plan.reviewVersion &&
    artifact.sourceReview.reviewArtifactRef === plan.reviewArtifactRef &&
    artifact.sourceReview.reviewArtifactSha256 === plan.sourceReviewArtifactFingerprint &&
    artifact.sourceReview.decisionSemanticFingerprint === plan.sourceReviewSemanticFingerprint &&
    artifact.pool.mode === plan.candidatePoolMode &&
    artifact.pool.fingerprint === plan.candidatePoolFingerprint
  );
}

function parseBoundArtifact(
  bytes: Buffer,
  snapshot: ExamRuntimeSnapshot,
  confirmedReview: ConfirmedExamReviewFactsV1,
): ExamKnowledgeSuggestionsArtifactV1 {
  const suggestions = snapshot.state.knowledgeSuggestions;
  if (!suggestions) throw new ExamError('EXAM_KNOWLEDGE_SUGGESTIONS_NOT_READY');
  const plan = planFromState(suggestions);
  let artifact: ExamKnowledgeSuggestionsArtifactV1;
  let canonicalBytes: Buffer;
  try {
    artifact = parseExamKnowledgeSuggestionsArtifact(bytes);
    canonicalBytes = serializeExamKnowledgeSuggestionsArtifact(artifact);
  } catch {
    throw new ExamError('EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT');
  }
  if (!bytes.equals(canonicalBytes) || !artifactPlanMatches(artifact, snapshot, plan)) {
    throw new ExamError('EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT');
  }

  let expectedBytes: Buffer;
  try {
    expectedBytes = serializeExamKnowledgeSuggestionsArtifact(
      buildExamKnowledgeSuggestionsArtifact({
        examSessionId: snapshot.state.examSessionId,
        profileId: snapshot.state.profileId,
        subjectId: snapshot.state.subjectId,
        confirmedReview,
        confirmedReviewArtifactSha256: plan.sourceReviewArtifactFingerprint,
        pool: artifact.pool,
        generator: artifact.generator,
        questionDrafts: artifactQuestionDrafts(artifact, confirmedReview),
        generationRef: plan.generationRef,
        suggestionArtifactRef: plan.suggestionArtifactRef,
      }),
    );
  } catch {
    throw new ExamError('EXAM_KNOWLEDGE_SUGGESTION_SOURCE_CHANGED');
  }
  if (!canonicalBytes.equals(expectedBytes)) {
    throw new ExamError('EXAM_KNOWLEDGE_SUGGESTION_SOURCE_CHANGED');
  }

  const fact = suggestions.suggestionArtifact;
  if (
    suggestions.status === 'completed' &&
    (!fact ||
      fact.byteLength !== bytes.byteLength ||
      fact.sha256 !== sha256(bytes) ||
      fact.questionCount !== artifact.questionCount ||
      fact.generatedQuestionCount !== artifact.generatedQuestionCount ||
      fact.noSuggestionQuestionCount !== artifact.noSuggestionQuestionCount ||
      fact.inputTooLargeQuestionCount !== artifact.inputTooLargeQuestionCount ||
      fact.suggestionCount !== artifact.suggestionCount)
  ) {
    throw new ExamError('EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT');
  }
  return artifact;
}

async function resolveCompletedFromRuntime(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  confirmedReview: ConfirmedExamReviewFactsV1,
): Promise<ExamKnowledgeSuggestionsArtifactV1> {
  if (snapshot.state.status === 'deleting' || snapshot.state.status === 'deleted') {
    throw new ExamError('EXAM_NOT_FOUND');
  }
  const suggestions = snapshot.state.knowledgeSuggestions;
  if (suggestions?.status !== 'completed' || !suggestions.suggestionArtifact) {
    throw new ExamError('EXAM_KNOWLEDGE_SUGGESTIONS_NOT_READY');
  }
  const bytes = await readOptionalObject(
    deps,
    objectKey(snapshot),
    'EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT',
  );
  if (!bytes) throw new ExamError('EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT');
  return parseBoundArtifact(bytes, snapshot, confirmedReview);
}

function startedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  plan: ExamKnowledgeSuggestionsPlanFacts,
): ExamKnowledgeSuggestionsStartedEvent {
  const operationId = deriveExamKnowledgeSuggestionsStartedOperationId(
    snapshot.state.examSessionId,
    plan.generationVersion,
  );
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_knowledge_suggestions_started',
    createdAt: now(deps),
    operationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_knowledge_suggestions_started',
      schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
      examSessionId: snapshot.state.examSessionId,
      profileId: snapshot.state.profileId,
      ...plan,
    }),
    ...plan,
  };
}

function completedEvent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  artifact: ExamKnowledgeSuggestionsArtifactV1,
  bytes: Buffer,
): ExamKnowledgeSuggestionsCompletedEvent {
  const suggestions = snapshot.state.knowledgeSuggestions;
  if (!suggestions) throw new ExamError('EXAM_KNOWLEDGE_SUGGESTIONS_NOT_READY');
  const plan = planFromState(suggestions);
  const operationId = deriveExamKnowledgeSuggestionsCompletedOperationId(
    snapshot.state.examSessionId,
    plan.generationVersion,
  );
  const artifactFacts = {
    artifactByteLength: bytes.byteLength,
    artifactSha256: sha256(bytes),
    questionCount: artifact.questionCount,
    generatedQuestionCount: artifact.generatedQuestionCount,
    noSuggestionQuestionCount: artifact.noSuggestionQuestionCount,
    inputTooLargeQuestionCount: artifact.inputTooLargeQuestionCount,
    suggestionCount: artifact.suggestionCount,
  } as const;
  return {
    schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
    eventId: deriveExamEventId(operationId),
    examSessionId: snapshot.state.examSessionId,
    profileId: snapshot.state.profileId,
    eventType: 'exam_knowledge_suggestions_completed',
    createdAt: now(deps),
    operationId,
    operationFingerprint: createExamOperationFingerprint({
      action: 'exam_knowledge_suggestions_completed',
      schemaVersion: EXAM_EVENT_SCHEMA_VERSION,
      examSessionId: snapshot.state.examSessionId,
      profileId: snapshot.state.profileId,
      ...plan,
      ...artifactFacts,
    }),
    ...plan,
    ...artifactFacts,
  };
}

async function appendStarted(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  plan: ExamKnowledgeSuggestionsPlanFacts,
): Promise<ExamRuntimeSnapshot> {
  try {
    return (
      await appendExamRuntimeEvent(deps, {
        event: startedEvent(deps, snapshot, plan),
        expectedRevision: snapshot.state.revision,
      })
    ).snapshot;
  } catch (error) {
    const recovered = await loadExamRuntime(deps, snapshot.state.examSessionId).catch(
      () => undefined,
    );
    if (
      recovered?.state.knowledgeSuggestions &&
      planMatches(recovered.state.knowledgeSuggestions, plan)
    ) {
      return recovered;
    }
    if (isExamError(error)) throw error;
    throw new ExamError('EXAM_KNOWLEDGE_SUGGESTION_FAILED');
  }
}

function completionMatches(
  snapshot: ExamRuntimeSnapshot,
  artifact: ExamKnowledgeSuggestionsArtifactV1,
  bytes: Buffer,
): boolean {
  const state = snapshot.state.knowledgeSuggestions;
  const fact = state?.suggestionArtifact;
  return Boolean(
    state?.status === 'completed' &&
    fact &&
    fact.byteLength === bytes.byteLength &&
    fact.sha256 === sha256(bytes) &&
    fact.questionCount === artifact.questionCount &&
    fact.generatedQuestionCount === artifact.generatedQuestionCount &&
    fact.noSuggestionQuestionCount === artifact.noSuggestionQuestionCount &&
    fact.inputTooLargeQuestionCount === artifact.inputTooLargeQuestionCount &&
    fact.suggestionCount === artifact.suggestionCount,
  );
}

async function appendCompleted(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  artifact: ExamKnowledgeSuggestionsArtifactV1,
  bytes: Buffer,
): Promise<ExamRuntimeSnapshot> {
  try {
    return (
      await appendExamRuntimeEvent(deps, {
        event: completedEvent(deps, snapshot, artifact, bytes),
        expectedRevision: snapshot.state.revision,
      })
    ).snapshot;
  } catch (error) {
    const recovered = await loadExamRuntime(deps, snapshot.state.examSessionId).catch(
      () => undefined,
    );
    if (
      recovered?.state.knowledgeSuggestions &&
      snapshot.state.knowledgeSuggestions &&
      planMatches(
        recovered.state.knowledgeSuggestions,
        planFromState(snapshot.state.knowledgeSuggestions),
      ) &&
      completionMatches(recovered, artifact, bytes)
    ) {
      return recovered;
    }
    if (isExamError(error)) throw error;
    throw new ExamError('EXAM_KNOWLEDGE_SUGGESTION_FAILED');
  }
}

async function recoverArtifactIfPresent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  confirmedReview: ConfirmedExamReviewFactsV1,
): Promise<
  { snapshot: ExamRuntimeSnapshot; artifact: ExamKnowledgeSuggestionsArtifactV1 } | undefined
> {
  const bytes = await readOptionalObject(
    deps,
    objectKey(snapshot),
    'EXAM_KNOWLEDGE_SUGGESTION_FAILED',
  );
  if (!bytes) return undefined;
  const artifact = parseBoundArtifact(bytes, snapshot, confirmedReview);
  const completed = await appendCompleted(deps, snapshot, artifact, bytes);
  return {
    snapshot: completed,
    artifact: await resolveCompletedFromRuntime(deps, completed, confirmedReview),
  };
}

function publicResult(
  snapshot: ExamRuntimeSnapshot,
  artifact: ExamKnowledgeSuggestionsArtifactV1,
  confirmedReview: ConfirmedExamReviewFactsV1,
  replayed: boolean,
): GenerateExamKnowledgeSuggestionsResult {
  return {
    examSessionId: snapshot.state.examSessionId,
    knowledgeSuggestions: toPublicExamKnowledgeSuggestionsBundle(artifact, confirmedReview),
    replayed,
  };
}

async function inspectExisting(
  deps: ExamKnowledgeSuggestionsServiceDeps,
  examSessionId: string,
): Promise<GenerateExamKnowledgeSuggestionsResult | { profileId: string; subjectId: string }> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    requireGenerationReady(snapshot);
    if (snapshot.state.knowledgeSuggestions?.status === 'completed') {
      const confirmedReview = await resolveReview(deps, snapshot);
      const artifact = await resolveCompletedFromRuntime(deps, snapshot, confirmedReview);
      return publicResult(snapshot, artifact, confirmedReview, true);
    }
    const confirmedReview = await resolveReview(deps, snapshot);
    if (snapshot.state.knowledgeSuggestions) {
      const recovered = await recoverArtifactIfPresent(deps, snapshot, confirmedReview);
      if (recovered) {
        return publicResult(recovered.snapshot, recovered.artifact, confirmedReview, true);
      }
    }
    return { profileId: snapshot.state.profileId, subjectId: snapshot.state.subjectId };
  });
}

async function reserveGeneration(
  deps: ExamKnowledgeSuggestionsServiceDeps,
  examSessionId: string,
  pool: ExamKnowledgeCandidatePoolV1,
): Promise<ReservationResult> {
  return deps.withExamMutationLock(examSessionId, async () => {
    let snapshot = await loadExamRuntime(deps, examSessionId);
    requireGenerationReady(snapshot);
    const confirmedReview = await resolveReview(deps, snapshot);
    if (snapshot.state.knowledgeSuggestions?.status === 'completed') {
      const artifact = await resolveCompletedFromRuntime(deps, snapshot, confirmedReview);
      return {
        kind: 'resolved',
        result: publicResult(snapshot, artifact, confirmedReview, true),
      };
    }
    const plan = createPlan(snapshot, confirmedReview, pool);
    if (!snapshot.state.knowledgeSuggestions) {
      snapshot = await appendStarted(deps, snapshot, plan);
    }
    const suggestions = snapshot.state.knowledgeSuggestions;
    if (!suggestions || !planMatches(suggestions, plan)) {
      throw new ExamError('EXAM_KNOWLEDGE_SUGGESTION_SOURCE_CHANGED');
    }
    if (suggestions.status === 'completed') {
      const artifact = await resolveCompletedFromRuntime(deps, snapshot, confirmedReview);
      return {
        kind: 'resolved',
        result: publicResult(snapshot, artifact, confirmedReview, true),
      };
    }
    const recovered = await recoverArtifactIfPresent(deps, snapshot, confirmedReview);
    if (recovered) {
      return {
        kind: 'resolved',
        result: publicResult(recovered.snapshot, recovered.artifact, confirmedReview, true),
      };
    }
    return {
      kind: 'generate',
      context: {
        snapshot,
        confirmedReview,
        confirmedReviewArtifactSha256: plan.sourceReviewArtifactFingerprint,
        pool,
        plan,
      },
    };
  });
}

function mapGenerationError(error: unknown): ExamError {
  if (isExamError(error)) return error;
  if (error instanceof ExamKnowledgeSuggestionsGeneratorError) {
    return new ExamError(
      error.reason === 'provider_unavailable'
        ? 'EXAM_KNOWLEDGE_SUGGESTION_PROVIDER_UNAVAILABLE'
        : 'EXAM_KNOWLEDGE_SUGGESTION_INVALID',
    );
  }
  if (error instanceof ExamKnowledgeSuggestionsPrivateError) {
    switch (error.code) {
      case 'EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT':
        return new ExamError('EXAM_KNOWLEDGE_SUGGESTION_ARTIFACT_CORRUPT');
      case 'EXAM_KNOWLEDGE_SUGGESTION_SOURCE_INVALID':
        return new ExamError('EXAM_KNOWLEDGE_SUGGESTION_SOURCE_CHANGED');
      case 'EXAM_KNOWLEDGE_SUGGESTION_INPUT_INVALID':
      case 'EXAM_KNOWLEDGE_SUGGESTION_INCOMPLETE':
        return new ExamError('EXAM_KNOWLEDGE_SUGGESTION_INVALID');
    }
  }
  return new ExamError('EXAM_KNOWLEDGE_SUGGESTION_FAILED');
}

async function prepareArtifact(
  deps: ExamKnowledgeSuggestionsServiceDeps,
  context: GenerationContext,
): Promise<PreparedArtifact> {
  try {
    const questionDrafts = await deps.generateKnowledgeSuggestionDrafts(
      deps.knowledgeSuggestionAiCall,
      {
        questions: context.confirmedReview.confirmedQuestions.map((question) => ({
          subjectId: context.snapshot.state.subjectId,
          confirmedQuestionId: question.confirmedQuestionId,
          questionText: question.questionText,
          ...(question.parentContext
            ? { parentContext: { questionText: question.parentContext.questionText } }
            : {}),
        })),
        existingKnowledgePointIds: context.pool.knowledgePointIds,
      },
      deps.abortSignal,
    );
    const artifact = buildExamKnowledgeSuggestionsArtifact({
      examSessionId: context.snapshot.state.examSessionId,
      profileId: context.snapshot.state.profileId,
      subjectId: context.snapshot.state.subjectId,
      confirmedReview: context.confirmedReview,
      confirmedReviewArtifactSha256: context.confirmedReviewArtifactSha256,
      pool: context.pool,
      generator: {
        generatorVersion: EXAM_KNOWLEDGE_SUGGESTION_GENERATOR_VERSION,
        candidateSchemaVersion: EXAM_KNOWLEDGE_SUGGESTION_CANDIDATE_SCHEMA_VERSION,
      },
      questionDrafts,
      generationRef: context.plan.generationRef,
      suggestionArtifactRef: context.plan.suggestionArtifactRef,
    });
    return { artifact, bytes: serializeExamKnowledgeSuggestionsArtifact(artifact) };
  } catch (error) {
    throw mapGenerationError(error);
  }
}

async function putArtifactIfAbsent(
  deps: ExamServiceDeps,
  snapshot: ExamRuntimeSnapshot,
  confirmedReview: ConfirmedExamReviewFactsV1,
  prepared: PreparedArtifact,
): Promise<PreparedArtifact> {
  const key = objectKey(snapshot);
  const existing = await readOptionalObject(deps, key, 'EXAM_KNOWLEDGE_SUGGESTION_FAILED');
  if (existing) {
    return {
      artifact: parseBoundArtifact(existing, snapshot, confirmedReview),
      bytes: existing,
    };
  }

  try {
    await deps.byteStore.put(key, prepared.bytes, 'application/json');
  } catch {
    const recovered = await readOptionalObject(deps, key, 'EXAM_KNOWLEDGE_SUGGESTION_FAILED').catch(
      () => undefined,
    );
    if (!recovered) throw new ExamError('EXAM_KNOWLEDGE_SUGGESTION_FAILED');
  }
  const readBack = await readOptionalObject(deps, key, 'EXAM_KNOWLEDGE_SUGGESTION_FAILED');
  if (!readBack) throw new ExamError('EXAM_KNOWLEDGE_SUGGESTION_FAILED');
  return {
    artifact: parseBoundArtifact(readBack, snapshot, confirmedReview),
    bytes: readBack,
  };
}

async function finalizeGeneration(
  deps: ExamKnowledgeSuggestionsServiceDeps,
  context: GenerationContext,
  prepared: PreparedArtifact,
): Promise<GenerateExamKnowledgeSuggestionsResult> {
  return deps.withExamMutationLock(context.snapshot.state.examSessionId, async () => {
    let snapshot = await loadExamRuntime(deps, context.snapshot.state.examSessionId);
    requireGenerationReady(snapshot);
    const confirmedReview = await resolveReview(deps, snapshot);
    if (snapshot.state.knowledgeSuggestions?.status === 'completed') {
      const artifact = await resolveCompletedFromRuntime(deps, snapshot, confirmedReview);
      return publicResult(snapshot, artifact, confirmedReview, true);
    }
    const suggestions = snapshot.state.knowledgeSuggestions;
    if (!suggestions || !planMatches(suggestions, context.plan)) {
      throw new ExamError('EXAM_KNOWLEDGE_SUGGESTION_SOURCE_CHANGED');
    }
    const currentPlan = createPlan(snapshot, confirmedReview, context.pool);
    if (!planMatches(suggestions, currentPlan)) {
      throw new ExamError('EXAM_KNOWLEDGE_SUGGESTION_SOURCE_CHANGED');
    }
    const committed = await putArtifactIfAbsent(deps, snapshot, confirmedReview, prepared);
    snapshot = await appendCompleted(deps, snapshot, committed.artifact, committed.bytes);
    const artifact = await resolveCompletedFromRuntime(deps, snapshot, confirmedReview);
    return publicResult(snapshot, artifact, confirmedReview, false);
  });
}

async function generateWithoutSingleFlight(
  deps: ExamKnowledgeSuggestionsServiceDeps,
  examSessionId: string,
): Promise<GenerateExamKnowledgeSuggestionsResult> {
  const inspected = await inspectExisting(deps, examSessionId);
  if ('knowledgeSuggestions' in inspected) return inspected;

  let pool: ExamKnowledgeCandidatePoolV1;
  try {
    pool = parseExamKnowledgeCandidatePool(
      await deps.resolveKnowledgeCandidatePool(deps, inspected.profileId, inspected.subjectId),
    );
    if (pool.subjectId !== inspected.subjectId) {
      throw new ExamKnowledgeCandidatePoolError('EXAM_KNOWLEDGE_CANDIDATE_POOL_INVALID');
    }
  } catch (error) {
    if (error instanceof ExamKnowledgeCandidatePoolError) {
      throw new ExamError('EXAM_KNOWLEDGE_SUGGESTION_FAILED');
    }
    throw mapGenerationError(error);
  }

  const reservation = await reserveGeneration(deps, examSessionId, pool);
  if (reservation.kind === 'resolved') return reservation.result;
  const prepared = await prepareArtifact(deps, reservation.context);
  return finalizeGeneration(deps, reservation.context, prepared);
}

export async function generateExamKnowledgeSuggestions(
  deps: ExamKnowledgeSuggestionsServiceDeps,
  examSessionId: string,
): Promise<GenerateExamKnowledgeSuggestionsResult> {
  const flightKey = `${deps.ownerId}\0${examSessionId}`;
  const existing = generationFlights.get(flightKey);
  if (existing) {
    const result = await existing;
    return { ...result, replayed: true };
  }
  const flight = generateWithoutSingleFlight(deps, examSessionId);
  generationFlights.set(flightKey, flight);
  try {
    return await flight;
  } finally {
    if (generationFlights.get(flightKey) === flight) generationFlights.delete(flightKey);
  }
}

export async function getExamKnowledgeSuggestions(
  deps: ExamServiceDeps,
  examSessionId: string,
): Promise<PublicExamKnowledgeSuggestionsBundleV1> {
  return deps.withExamMutationLock(examSessionId, async () => {
    const snapshot = await loadExamRuntime(deps, examSessionId);
    if (snapshot.state.status === 'deleting' || snapshot.state.status === 'deleted') {
      throw new ExamError('EXAM_NOT_FOUND');
    }
    const confirmedReview = await resolveReview(deps, snapshot);
    const artifact = await resolveCompletedFromRuntime(deps, snapshot, confirmedReview);
    return toPublicExamKnowledgeSuggestionsBundle(artifact, confirmedReview);
  });
}

export async function defaultExamKnowledgeSuggestionsServiceDeps(
  ownerId: string,
  abortSignal?: AbortSignal,
): Promise<ExamKnowledgeSuggestionsServiceDeps> {
  return {
    ...(await defaultExamServiceDeps(ownerId)),
    knowledgeSuggestionAiCall: createGenerationAiCallFactory({
      abortSignal,
      maxOutputTokens: EXAM_KNOWLEDGE_SUGGESTIONS_MAX_OUTPUT_TOKENS,
    })('exam-knowledge-suggestions'),
    resolveKnowledgeCandidatePool: collectExamKnowledgeCandidatePool,
    generateKnowledgeSuggestionDrafts: generateExamKnowledgeSuggestionDrafts,
    ...(abortSignal ? { abortSignal } : {}),
  };
}
