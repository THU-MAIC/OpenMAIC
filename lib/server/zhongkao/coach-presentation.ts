import type { AICallFn } from '@openmaic/generation';

import type {
  VerifiedZhongkaoMaterialSource,
  ZhongkaoMaterialSourceAdapter,
} from '@/lib/server/agent-runtime/zhongkao-material-source';
import {
  getCoachProblemState,
  recordFullSolutionRevealed,
  recordHintIssued,
  recordOriginalResolvedFromFullSolution,
  type CoachServiceDeps,
} from '@/lib/server/zhongkao/coach-service';
import type { CoachRuntimeSnapshot } from '@/lib/server/zhongkao/coach-runtime';
import { CoachError } from '@/lib/zhongkao/coach-errors';
import type {
  CoachFullSolutionPresentation,
  CoachHintPresentation,
  CoachTransferQuestionPresentation,
  CoachTransferResultPresentation,
} from '@/lib/zhongkao/coach-public-presentation';
import {
  assertCoachEvent,
  type CoachEvent,
  type FullSolutionRequestedEvent,
  type HintRequestedEvent,
  type CoachPresentationFailureCode,
} from '@/lib/zhongkao/coach-event';
import { selectOriginalResolution } from '@/lib/zhongkao/coach-original-resolution';
import {
  curriculumModeForSubject,
  evaluateCurriculumClaim,
  type CurriculumMode,
} from '@/lib/zhongkao/curriculum';
import { loadStudentProfile } from '@/lib/zhongkao/runtime';

import {
  createDeterministicZhongkaoHint,
  generateZhongkaoFullSolution,
  type ZhongkaoGenerationMaterial,
} from './coach-generation';
import {
  completeOriginalAttemptAssessment,
  recoverPreparedOriginalAssessment,
} from './coach-original-assessment';
import { resolveZhongkaoLearnerKeyFromOwnerId } from './learner-identity';

export type CoachPresentation =
  | CoachHintPresentation
  | CoachFullSolutionPresentation
  | CoachTransferQuestionPresentation
  | CoachTransferResultPresentation;

export interface CoachPresentationResult {
  snapshot: CoachRuntimeSnapshot;
  presentation: CoachPresentation;
  replayed: boolean;
  eventAppended: boolean;
}

export interface CoachPresentationDependencies extends CoachServiceDeps {
  generationCall?: AICallFn;
  materialSource?: ZhongkaoMaterialSourceAdapter;
  abortSignal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('aborted');
}

function events(snapshot: CoachRuntimeSnapshot): CoachEvent[] {
  return snapshot.records.map((record) => {
    assertCoachEvent(record.payload);
    return record.payload;
  });
}

function requestForTurn<TType extends 'hint_requested' | 'full_solution_requested'>(
  snapshot: CoachRuntimeSnapshot,
  eventType: TType,
  agentSessionId: string,
  userMessageSeq: number,
): Extract<CoachEvent, { eventType: TType }> {
  const matches = events(snapshot).filter(
    (event): event is Extract<CoachEvent, { eventType: TType }> =>
      event.eventType === eventType &&
      event.agentSessionId === agentSessionId &&
      event.sourceUserMessageSeq === userMessageSeq,
  );
  if (matches.length !== 1) throw new CoachError('COACH_EVENT_CONFLICT');
  return matches[0]!;
}

function startEvent(snapshot: CoachRuntimeSnapshot) {
  const start = events(snapshot).find((event) => event.eventType === 'coach_started');
  if (!start || start.eventType !== 'coach_started') throw new CoachError('COACH_EVENT_CONFLICT');
  return start;
}

function lastOriginalAttempt(snapshot: CoachRuntimeSnapshot) {
  return events(snapshot)
    .filter((event) => event.eventType === 'student_attempt_submitted')
    .at(-1);
}

async function curriculumMode(
  deps: CoachPresentationDependencies,
  snapshot: CoachRuntimeSnapshot,
): Promise<CurriculumMode> {
  throwIfAborted(deps.abortSignal);
  const profile = await loadStudentProfile(snapshot.state.profileId, {
    store: deps.store,
    learnerKey: resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId),
  });
  throwIfAborted(deps.abortSignal);
  if (!profile) throw new CoachError('COACH_PROFILE_NOT_FOUND');
  return curriculumModeForSubject(profile, snapshot.state.subjectId);
}

async function generationMaterial(
  deps: CoachPresentationDependencies,
  snapshot: CoachRuntimeSnapshot,
): Promise<ZhongkaoGenerationMaterial | undefined> {
  throwIfAborted(deps.abortSignal);
  const source = snapshot.state.questionSource;
  if (source.type !== 'material') return undefined;
  if (!deps.materialSource) throw new CoachError('MATERIAL_SOURCE_NOT_VERIFIED');
  const verified = await deps.materialSource.resolve(source.materialId);
  throwIfAborted(deps.abortSignal);
  if (
    verified.materialId !== source.materialId ||
    verified.source.type !== 'uploaded_material' ||
    verified.source.sourceId !== source.materialId
  ) {
    throw new CoachError('MATERIAL_SOURCE_NOT_VERIFIED');
  }
  assertVerifiedAttribution(verified);
  return {
    materialId: verified.materialId,
    displayName: verified.displayName,
    verifiedSource: verified.source,
    ...(verified.text ? { text: verified.text } : {}),
  };
}

function assertVerifiedAttribution(source: VerifiedZhongkaoMaterialSource): void {
  const decision = evaluateCurriculumClaim(
    'confirmed',
    { type: 'source_attribution', source: source.source },
    source.verifier,
  );
  if (!decision.allowed) throw new CoachError('MATERIAL_SOURCE_NOT_VERIFIED');
}

function persistedHint(
  snapshot: CoachRuntimeSnapshot,
  request: HintRequestedEvent,
): CoachPresentation | undefined {
  const issued = events(snapshot).find(
    (event) => event.eventType === 'hint_issued' && event.requestEventId === request.eventId,
  );
  return issued?.eventType === 'hint_issued' ? { kind: 'hint', text: issued.hintText } : undefined;
}

function persistedSolution(
  snapshot: CoachRuntimeSnapshot,
  request: FullSolutionRequestedEvent,
): CoachPresentation | undefined {
  const revealed = events(snapshot).find(
    (event) =>
      event.eventType === 'full_solution_revealed' && event.requestEventId === request.eventId,
  );
  return revealed?.eventType === 'full_solution_revealed'
    ? {
        kind: 'full_solution',
        explanation: revealed.explanation,
        ...(revealed.finalAnswer ? { finalAnswer: revealed.finalAnswer } : {}),
      }
    : undefined;
}

export async function ensureFullSolutionResolution(
  deps: CoachPresentationDependencies,
  snapshot: CoachRuntimeSnapshot,
) {
  let current = snapshot;
  let replayed = true;
  let eventAppended = false;
  if (!current.state.original.resolved && current.state.original.assessment.status === 'pending') {
    const attemptEventId = current.state.original.attemptEventIds[0];
    if (!attemptEventId) throw new CoachError('COACH_EVENT_CONFLICT');
    const assessed = await completeOriginalAttemptAssessment(deps, {
      profileId: current.state.profileId,
      coachSessionId: current.state.coachSessionId,
      attemptEventId,
    });
    current = assessed.snapshot;
    replayed &&= assessed.replayed;
    eventAppended ||= assessed.eventAppended;
  }
  if (!current.state.original.resolved && current.state.original.assessment.status === 'prepared') {
    const recovered = await recoverPreparedOriginalAssessment(deps, {
      profileId: current.state.profileId,
      coachSessionId: current.state.coachSessionId,
    });
    if (!recovered) throw new CoachError('COACH_EVENT_CONFLICT');
    current = recovered.snapshot;
    replayed &&= recovered.replayed;
    eventAppended ||= recovered.eventAppended;
  }
  if (current.state.original.resolved) {
    return {
      snapshot: current,
      replayed,
      eventAppended,
    };
  }
  const decision = selectOriginalResolution(current);
  if (decision.kind !== 'full_solution') {
    throw new CoachError('COACH_EVENT_CONFLICT');
  }
  const resolved = await recordOriginalResolvedFromFullSolution(deps, {
    profileId: current.state.profileId,
    coachSessionId: current.state.coachSessionId,
    expectedRevision: current.state.revision,
    fullSolutionEventId: decision.fullSolutionEventId,
  });
  return {
    snapshot: resolved.snapshot,
    replayed: replayed && resolved.replayed,
    eventAppended: eventAppended || resolved.eventAppended,
  };
}

function persistedFailure(
  snapshot: CoachRuntimeSnapshot,
  requestEventId: string,
  presentationKind: 'hint' | 'full_solution',
): CoachPresentationFailureCode | undefined {
  const failures = events(snapshot).filter(
    (event) =>
      event.eventType === 'presentation_failed' &&
      event.requestEventId === requestEventId &&
      event.presentationKind === presentationKind,
  );
  if (failures.length > 1) throw new CoachError('COACH_EVENT_CONFLICT');
  return failures[0]?.eventType === 'presentation_failed' ? failures[0].failureCode : undefined;
}

export async function completeCoachHintRequest(
  deps: CoachPresentationDependencies,
  input: {
    profileId: string;
    coachSessionId: string;
    userMessageSeq: number;
    requiredPhase?: 'original' | 'transfer';
  },
): Promise<CoachPresentationResult | undefined> {
  const snapshot = await getCoachProblemState(deps, input.profileId, input.coachSessionId);
  throwIfAborted(deps.abortSignal);
  const request = requestForTurn(
    snapshot,
    'hint_requested',
    deps.agentSessionId,
    input.userMessageSeq,
  );
  if (input.requiredPhase !== undefined && request.phase !== input.requiredPhase) return undefined;
  const replay = persistedHint(snapshot, request);
  if (replay) {
    return { snapshot, presentation: replay, replayed: true, eventAppended: false };
  }
  const failure = persistedFailure(snapshot, request.eventId, 'hint');
  if (failure) throw new CoachError(failure);
  const phase = request.phase === 'original' ? snapshot.state.original : snapshot.state.transfer;
  if (phase.pendingHintRequestEventId !== request.eventId) {
    throw new CoachError('COACH_ACTION_NOT_ALLOWED');
  }

  const hintOrdinal = (phase.hintsIssued + 1) as 1 | 2 | 3;
  const generated = createDeterministicZhongkaoHint({
    hintOrdinal,
    isKeyHint: hintOrdinal === 3,
  });
  throwIfAborted(deps.abortSignal);
  const recorded = await recordHintIssued(deps, {
    profileId: input.profileId,
    coachSessionId: input.coachSessionId,
    expectedRevision: snapshot.state.revision,
    requestEventId: request.eventId,
    hintText: generated.output.hint,
  });
  throwIfAborted(deps.abortSignal);
  const presentation = persistedHint(recorded.snapshot, request);
  if (!presentation) throw new CoachError('COACH_EVENT_CONFLICT');
  return {
    snapshot: recorded.snapshot,
    presentation,
    replayed: recorded.replayed,
    eventAppended: recorded.eventAppended,
  };
}

export async function completeOriginalHintRequest(
  deps: CoachPresentationDependencies,
  input: { profileId: string; coachSessionId: string; userMessageSeq: number },
): Promise<CoachPresentationResult | undefined> {
  return completeCoachHintRequest(deps, { ...input, requiredPhase: 'original' });
}

export async function completeOriginalFullSolutionRequest(
  deps: CoachPresentationDependencies,
  input: { profileId: string; coachSessionId: string; userMessageSeq: number },
): Promise<CoachPresentationResult> {
  const snapshot = await getCoachProblemState(deps, input.profileId, input.coachSessionId);
  throwIfAborted(deps.abortSignal);
  const request = requestForTurn(
    snapshot,
    'full_solution_requested',
    deps.agentSessionId,
    input.userMessageSeq,
  );
  const replay = persistedSolution(snapshot, request);
  if (replay) {
    const resolved = await ensureFullSolutionResolution(deps, snapshot);
    return {
      snapshot: resolved.snapshot,
      presentation: replay,
      replayed: resolved.replayed,
      eventAppended: resolved.eventAppended,
    };
  }
  const failure = persistedFailure(snapshot, request.eventId, 'full_solution');
  if (failure) throw new CoachError(failure);
  if (
    snapshot.state.original.pendingFullSolutionRequestEventId !== request.eventId ||
    !snapshot.state.original.fullSolutionAvailable
  ) {
    throw new CoachError('FULL_SOLUTION_REQUEST_REQUIRED');
  }

  const start = startEvent(snapshot);
  const material = await generationMaterial(deps, snapshot);
  throwIfAborted(deps.abortSignal);
  const originalAttempt = lastOriginalAttempt(snapshot);
  const mode = await curriculumMode(deps, snapshot);
  throwIfAborted(deps.abortSignal);
  const generated = await generateZhongkaoFullSolution(
    deps.generationCall,
    {
      subjectId: snapshot.state.subjectId,
      knowledgePointIds: snapshot.state.knowledgePointIds,
      questionText: start.questionText,
      ...(originalAttempt ? { studentAttempt: originalAttempt.studentResponse } : {}),
      curriculumMode: mode,
      ...(material ? { material } : {}),
    },
    deps.abortSignal,
  );
  throwIfAborted(deps.abortSignal);
  const recorded = await recordFullSolutionRevealed(deps, {
    profileId: input.profileId,
    coachSessionId: input.coachSessionId,
    expectedRevision: snapshot.state.revision,
    requestEventId: request.eventId,
    explanation: generated.explanation,
    ...(generated.finalAnswer ? { finalAnswer: generated.finalAnswer } : {}),
  });
  throwIfAborted(deps.abortSignal);
  const presentation = persistedSolution(recorded.snapshot, request);
  if (!presentation) throw new CoachError('COACH_EVENT_CONFLICT');
  const resolved = await ensureFullSolutionResolution(deps, recorded.snapshot);
  return {
    snapshot: resolved.snapshot,
    presentation,
    replayed: recorded.replayed && resolved.replayed,
    eventAppended: recorded.eventAppended || resolved.eventAppended,
  };
}
