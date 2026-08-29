import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AICallFn } from '@openmaic/generation';
import type { RuntimeStore } from '@openmaic/storage';
import type { PgAgentSessionStore } from '@openmaic/storage/agent-session/pg';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import {
  abandonCoachProblem,
  getCoachProblemState,
  requestCoachFullSolution,
  requestCoachHint,
  recordCoachPresentationFailure,
  startCoachProblem,
  submitCoachAttempt,
  submitCoachTransferAnswer,
  type CoachActionResult,
  type TrustedCoachUserMessage,
} from '@/lib/server/zhongkao/coach-service';
import type { CoachRuntimeSnapshot } from '@/lib/server/zhongkao/coach-runtime';
import {
  completePendingTransferAnswerEvaluation,
  completeTransferAnswerEvaluation,
  completeTransferQuestionGeneration,
} from '@/lib/server/zhongkao/coach-transfer';
import {
  completeCoachHintRequest,
  completeOriginalFullSolutionRequest,
  type CoachPresentation,
} from '@/lib/server/zhongkao/coach-presentation';
import { CoachError, isCoachError } from '@/lib/zhongkao/coach-errors';
import { evaluateCurriculumClaim } from '@/lib/zhongkao/curriculum';
import {
  COACH_MODEL_ACTIONS,
  allowedCoachActions,
  directiveForCoachState,
} from '@/lib/zhongkao/coach-policy';
import type { CoachState } from '@/lib/zhongkao/coach-state';
import {
  COACH_TRUSTED_MESSAGE_MAX_LENGTH,
  assertCoachEvent,
  isCoachPresentationFailureCodeForKind,
  type CoachPresentationFailureCode,
  type CoachPresentationKind,
} from '@/lib/zhongkao/coach-event';
import {
  COACH_FULL_SOLUTION_PRESENTATION_SCHEMA,
  COACH_HINT_PRESENTATION_SCHEMA,
  COACH_TRANSFER_QUESTION_PRESENTATION_SCHEMA,
  COACH_TRANSFER_RESULT_PRESENTATION_SCHEMA,
} from '@/lib/zhongkao/coach-public-presentation';

import { listAgentUserMessages } from './user-messages';
import type { ZhongkaoMaterialSourceAdapter } from './zhongkao-material-source';

const CLOSED = { additionalProperties: false } as const;
const IDENTIFIER = Type.String({ minLength: 1, maxLength: 128 });
const EXPECTED_REVISION = Type.Integer({ minimum: 0 });

const StartProblemBase = {
  action: Type.Literal('start_problem'),
  profileId: IDENTIFIER,
  subjectId: IDENTIFIER,
  knowledgePointIds: Type.Array(IDENTIFIER, {
    minItems: 1,
    maxItems: 32,
    uniqueItems: true,
  }),
} as const;

const StartProblemSchema = Type.Union([
  Type.Object(
    {
      ...StartProblemBase,
      questionSourceType: Type.Literal('typed'),
    },
    CLOSED,
  ),
  Type.Object(
    {
      ...StartProblemBase,
      questionSourceType: Type.Literal('material'),
      materialId: IDENTIFIER,
    },
    CLOSED,
  ),
]);

const GetStateSchema = Type.Object(
  {
    action: Type.Literal('get_state'),
    profileId: IDENTIFIER,
    coachSessionId: IDENTIFIER,
  },
  CLOSED,
);

function continuationSchema<
  TAction extends Exclude<(typeof COACH_MODEL_ACTIONS)[number], 'start_problem' | 'get_state'>,
>(action: TAction) {
  return Type.Object(
    {
      action: Type.Literal(action),
      profileId: IDENTIFIER,
      coachSessionId: IDENTIFIER,
      expectedRevision: EXPECTED_REVISION,
    },
    CLOSED,
  );
}

export const ZHONGKAO_COACH_ACTION_SCHEMA = Type.Union([
  StartProblemSchema,
  GetStateSchema,
  continuationSchema('submit_attempt'),
  continuationSchema('request_hint'),
  continuationSchema('request_full_solution'),
  continuationSchema('submit_transfer_answer'),
  continuationSchema('abandon_problem'),
]);

const CoachErrorCodeSchema = Type.Union([
  Type.Literal('COACH_INPUT_INVALID'),
  Type.Literal('COACH_PROFILE_NOT_FOUND'),
  Type.Literal('COACH_SESSION_NOT_FOUND'),
  Type.Literal('COACH_SESSION_CONFLICT'),
  Type.Literal('COACH_ACTION_NOT_ALLOWED'),
  Type.Literal('STUDENT_ATTEMPT_REQUIRED'),
  Type.Literal('FULL_SOLUTION_LOCKED'),
  Type.Literal('FULL_SOLUTION_REQUEST_REQUIRED'),
  Type.Literal('HINT_LIMIT_REACHED'),
  Type.Literal('HINT_GENERATION_PENDING'),
  Type.Literal('TRANSFER_QUESTION_REQUIRED'),
  Type.Literal('COACH_MESSAGE_ALREADY_COUNTED'),
  Type.Literal('COACH_EVENT_CONFLICT'),
  Type.Literal('COACH_RUNTIME_UNAVAILABLE'),
  Type.Literal('MATERIAL_SOURCE_NOT_SUPPORTED'),
  Type.Literal('MATERIAL_SOURCE_NOT_VERIFIED'),
  Type.Literal('HINT_GENERATION_FAILED'),
  Type.Literal('HINT_CONTENT_INVALID'),
  Type.Literal('HINT_CONTENT_LEAKED'),
  Type.Literal('FULL_SOLUTION_GENERATION_FAILED'),
  Type.Literal('FULL_SOLUTION_CONTENT_INVALID'),
  Type.Literal('COACH_GENERATION_UNAVAILABLE'),
  Type.Literal('TRANSFER_QUESTION_GENERATION_FAILED'),
  Type.Literal('TRANSFER_QUESTION_INVALID'),
  Type.Literal('TRANSFER_QUESTION_TYPE_UNSUPPORTED'),
  Type.Literal('TRANSFER_QUESTION_NOT_VERIFIED'),
  Type.Literal('TRANSFER_ANSWER_INVALID'),
  Type.Literal('TRANSFER_EVALUATION_FAILED'),
]);

const CoachActionSchema = Type.Union([
  Type.Literal('start_problem'),
  Type.Literal('get_state'),
  Type.Literal('submit_attempt'),
  Type.Literal('request_hint'),
  Type.Literal('request_full_solution'),
  Type.Literal('submit_transfer_answer'),
  Type.Literal('abandon_problem'),
]);

const CoachDirectiveSchema = Type.Union([
  Type.Literal('ASK_FOR_ATTEMPT'),
  Type.Literal('GENERATE_ONE_HINT'),
  Type.Literal('FULL_SOLUTION_LOCKED'),
  Type.Literal('FULL_SOLUTION_AVAILABLE'),
  Type.Literal('GENERATE_FULL_SOLUTION'),
  Type.Literal('GENERATE_TRANSFER_QUESTION'),
  Type.Literal('WAIT_FOR_TRANSFER_ANSWER'),
  Type.Literal('EVALUATE_TRANSFER_ANSWER'),
  Type.Literal('PROJECT_STUDY_ATTEMPTS'),
  Type.Literal('COMPLETED'),
  Type.Literal('ABANDONED'),
]);

const PublicOriginalStateSchema = Type.Object(
  {
    attemptCount: Type.Integer({ minimum: 0 }),
    hintsRequested: Type.Integer({ minimum: 0, maximum: 3 }),
    hintsIssued: Type.Integer({ minimum: 0, maximum: 3 }),
    keyHintUsed: Type.Boolean(),
    fullSolutionRequests: Type.Integer({ minimum: 0 }),
    fullSolutionAvailable: Type.Boolean(),
    viewedFullAnswer: Type.Boolean(),
    resolved: Type.Boolean(),
  },
  CLOSED,
);

const PublicTransferStateSchema = Type.Object(
  {
    assigned: Type.Boolean(),
    attemptCount: Type.Integer({ minimum: 0, maximum: 1 }),
    hintsRequested: Type.Integer({ minimum: 0, maximum: 3 }),
    hintsIssued: Type.Integer({ minimum: 0, maximum: 3 }),
    keyHintUsed: Type.Boolean(),
    viewedFullAnswer: Type.Boolean(),
    evaluated: Type.Boolean(),
  },
  CLOSED,
);

const PublicCoachStateSchema = Type.Object(
  {
    coachSessionId: IDENTIFIER,
    profileId: IDENTIFIER,
    status: Type.Union([
      Type.Literal('awaiting_student_attempt'),
      Type.Literal('hint_pending'),
      Type.Literal('hinting'),
      Type.Literal('solution_locked'),
      Type.Literal('solution_available'),
      Type.Literal('transfer_pending'),
      Type.Literal('finalizing'),
      Type.Literal('completed'),
      Type.Literal('abandoned'),
    ]),
    revision: Type.Integer({ minimum: 0 }),
    original: PublicOriginalStateSchema,
    transfer: PublicTransferStateSchema,
  },
  CLOSED,
);

const CoachPresentationSchema = Type.Union([
  COACH_HINT_PRESENTATION_SCHEMA,
  COACH_FULL_SOLUTION_PRESENTATION_SCHEMA,
  COACH_TRANSFER_QUESTION_PRESENTATION_SCHEMA,
  COACH_TRANSFER_RESULT_PRESENTATION_SCHEMA,
]);

export const ZHONGKAO_COACH_OUTPUT_SCHEMA = Type.Object(
  {
    ok: Type.Boolean(),
    code: Type.Optional(CoachErrorCodeSchema),
    coachSessionId: Type.Optional(IDENTIFIER),
    revision: Type.Optional(Type.Integer({ minimum: 0 })),
    state: Type.Optional(PublicCoachStateSchema),
    presentation: Type.Optional(CoachPresentationSchema),
    facts: Type.Object(
      {
        replayed: Type.Boolean(),
        eventAppended: Type.Boolean(),
      },
      CLOSED,
    ),
    allowedActions: Type.Array(CoachActionSchema),
    directive: Type.Optional(CoachDirectiveSchema),
  },
  CLOSED,
);

export type CoachToolParams = Static<typeof ZHONGKAO_COACH_ACTION_SCHEMA>;
export type ZhongkaoCoachToolOutput = Static<typeof ZHONGKAO_COACH_OUTPUT_SCHEMA>;

export interface TrustedAgentTurn {
  ownerId: string;
  agentSessionId: string;
  userMessageSeq: number;
  userMessageId?: string;
}

export interface ZhongkaoCoachToolContext {
  trustedTurn: TrustedAgentTurn;
  runtimeStore: RuntimeStore;
  readTrustedUserMessage: () => Promise<TrustedCoachUserMessage>;
  createGenerationCall?: (signal?: AbortSignal) => AICallFn;
  createTransferVerificationCall?: (signal?: AbortSignal) => AICallFn;
  /** @deprecated Tests may use this seam; production callers must bind the execution signal. */
  generationCall?: AICallFn;
  /** @deprecated Tests may inject an independent deterministic verifier. */
  transferVerificationCall?: AICallFn;
  materialSource?: ZhongkaoMaterialSourceAdapter;
  beforeExecute?: () => Promise<void>;
  now?: () => string;
}

export interface AgentSessionCoachMessageReaderInput {
  store: Pick<PgAgentSessionStore, 'getSession' | 'readEventsAfter' | 'listUserMessages'>;
  trustedTurn: TrustedAgentTurn;
}

function freezeTrustedTurn(turn: TrustedAgentTurn): Readonly<TrustedAgentTurn> {
  if (
    typeof turn.ownerId !== 'string' ||
    turn.ownerId.length === 0 ||
    typeof turn.agentSessionId !== 'string' ||
    turn.agentSessionId.length === 0 ||
    !Number.isSafeInteger(turn.userMessageSeq) ||
    turn.userMessageSeq < 1 ||
    (turn.userMessageId !== undefined &&
      (typeof turn.userMessageId !== 'string' || turn.userMessageId.length === 0))
  ) {
    throw new CoachError('COACH_INPUT_INVALID');
  }
  return Object.freeze({
    ownerId: turn.ownerId,
    agentSessionId: turn.agentSessionId,
    userMessageSeq: turn.userMessageSeq,
    ...(turn.userMessageId === undefined ? {} : { userMessageId: turn.userMessageId }),
  });
}

export function createAgentSessionCoachMessageReader(
  input: AgentSessionCoachMessageReaderInput,
): () => Promise<TrustedCoachUserMessage> {
  const turn = freezeTrustedTurn(input.trustedTurn);
  return async () => {
    const session = await input.store.getSession(turn.agentSessionId);
    if (!session || session.id !== turn.agentSessionId || session.ownerId !== turn.ownerId) {
      throw new CoachError('COACH_INPUT_INVALID');
    }
    const messages = await listAgentUserMessages(input.store, turn.agentSessionId);
    // listAgentUserMessages projects only persisted user_message events, so the
    // exact match below establishes both the user role and durable provenance.
    const matches = messages.filter((candidate) => candidate.seq === turn.userMessageSeq);
    if (matches.length !== 1) throw new CoachError('COACH_INPUT_INVALID');
    const message = matches[0]!;
    if (
      typeof message.text !== 'string' ||
      message.text.trim().length === 0 ||
      message.text.length > COACH_TRUSTED_MESSAGE_MAX_LENGTH
    ) {
      throw new CoachError('COACH_INPUT_INVALID');
    }
    return { seq: message.seq, text: message.text };
  };
}

function publicState(state: CoachState): Static<typeof PublicCoachStateSchema> {
  return {
    coachSessionId: state.coachSessionId,
    profileId: state.profileId,
    status: state.status,
    revision: state.revision,
    original: {
      attemptCount: state.original.attemptCount,
      hintsRequested: state.original.hintRequestEventIds.length,
      hintsIssued: state.original.hintsIssued,
      keyHintUsed: state.original.keyHintUsed,
      fullSolutionRequests: state.original.fullSolutionRequestEventIds.length,
      fullSolutionAvailable: state.original.fullSolutionAvailable,
      viewedFullAnswer: state.original.viewedFullAnswer,
      resolved: state.original.resolved,
    },
    transfer: {
      assigned: state.transfer.assigned,
      attemptCount: state.transfer.attemptCount,
      hintsRequested: state.transfer.hintRequestEventIds.length,
      hintsIssued: state.transfer.hintsIssued,
      keyHintUsed: state.transfer.keyHintUsed,
      viewedFullAnswer: state.transfer.viewedFullAnswer,
      evaluated: state.transfer.evaluationEventId !== undefined,
    },
  };
}

function validateOutput(value: unknown): ZhongkaoCoachToolOutput {
  if (!Value.Check(ZHONGKAO_COACH_OUTPUT_SCHEMA, value)) {
    throw new Error('Zhongkao coach public DTO validation failed');
  }
  return value as ZhongkaoCoachToolOutput;
}

export function buildCoachToolSuccessOutput(
  snapshot: CoachRuntimeSnapshot,
  facts: { replayed: boolean; eventAppended: boolean },
  code?: CoachActionResult['code'],
  presentation?: CoachPresentation,
): ZhongkaoCoachToolOutput {
  return validateOutput({
    ok: code === undefined,
    ...(code ? { code } : {}),
    coachSessionId: snapshot.state.coachSessionId,
    revision: snapshot.state.revision,
    state: publicState(snapshot.state),
    ...(presentation ? { presentation } : {}),
    facts,
    allowedActions: allowedCoachActions(snapshot.state),
    directive:
      code === 'FULL_SOLUTION_LOCKED'
        ? 'FULL_SOLUTION_LOCKED'
        : directiveForCoachState(snapshot.state),
  });
}

export function buildCoachToolErrorOutput(error: unknown): ZhongkaoCoachToolOutput {
  const code = isCoachError(error) ? error.code : 'COACH_RUNTIME_UNAVAILABLE';
  return validateOutput({
    ok: false,
    code,
    ...(error instanceof CoachError && error.latestRevision !== undefined
      ? { revision: error.latestRevision }
      : {}),
    facts: { replayed: false, eventAppended: false },
    allowedActions: [],
  });
}

function toolResult(output: ZhongkaoCoachToolOutput) {
  const validated = validateOutput(output);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(validated) }],
    details: validated,
    ...(validated.ok ? {} : { isError: true }),
  };
}

function errorResult(error: unknown) {
  return toolResult(buildCoachToolErrorOutput(error));
}

function presentationFailureCode(
  error: unknown,
  presentationKind: CoachPresentationKind,
  signal?: AbortSignal,
): CoachPresentationFailureCode | undefined {
  if (signal?.aborted || !isCoachError(error)) return undefined;
  return isCoachPresentationFailureCodeForKind(presentationKind, error.code)
    ? error.code
    : undefined;
}

function exactPresentationRequest(
  snapshot: CoachRuntimeSnapshot,
  turn: Readonly<TrustedAgentTurn>,
  presentationKind: CoachPresentationKind,
): { eventId: string; phase: 'original' | 'transfer' } {
  const requestType = presentationKind === 'hint' ? 'hint_requested' : 'full_solution_requested';
  const matches = snapshot.records.flatMap((record) => {
    assertCoachEvent(record.payload);
    const event = record.payload;
    return event.eventType === requestType &&
      event.agentSessionId === turn.agentSessionId &&
      event.sourceUserMessageSeq === turn.userMessageSeq
      ? [event]
      : [];
  });
  if (matches.length !== 1) throw new CoachError('COACH_EVENT_CONFLICT');
  const request = matches[0]!;
  return { eventId: request.eventId, phase: request.phase };
}

async function settlePresentationFailure(input: {
  deps: Parameters<typeof recordCoachPresentationFailure>[0];
  requestSnapshot: CoachRuntimeSnapshot;
  turn: Readonly<TrustedAgentTurn>;
  presentationKind: CoachPresentationKind;
  profileId: string;
  coachSessionId: string;
  error: unknown;
  signal?: AbortSignal;
}): Promise<
  | {
      failureCode: CoachPresentationFailureCode;
      result: Awaited<ReturnType<typeof recordCoachPresentationFailure>>;
    }
  | undefined
> {
  const failureCode = presentationFailureCode(input.error, input.presentationKind, input.signal);
  if (!failureCode) return undefined;
  try {
    const request = exactPresentationRequest(
      input.requestSnapshot,
      input.turn,
      input.presentationKind,
    );
    const expectedRevision =
      input.error instanceof CoachError &&
      input.error.code === 'COACH_SESSION_CONFLICT' &&
      input.error.latestRevision !== undefined
        ? input.error.latestRevision
        : input.requestSnapshot.state.revision;
    const result = await recordCoachPresentationFailure(input.deps, {
      profileId: input.profileId,
      coachSessionId: input.coachSessionId,
      expectedRevision,
      phase: request.phase,
      presentationKind: input.presentationKind,
      requestEventId: request.eventId,
      failureCode,
    });
    if (input.signal?.aborted) return undefined;
    return { failureCode, result };
  } catch {
    return undefined;
  }
}

export function createZhongkaoCoachActionTool(
  context: ZhongkaoCoachToolContext,
): AgentTool<never, never> {
  const turn = freezeTrustedTurn(context.trustedTurn);
  const tool: AgentTool<typeof ZHONGKAO_COACH_ACTION_SCHEMA, unknown> = {
    name: 'zhongkao_coach_action',
    label: 'Zhongkao coach action',
    description:
      'Advance or inspect one deterministic Zhongkao tutoring problem. Student text is read from the bound durable user turn and is never supplied in this tool input.',
    parameters: ZHONGKAO_COACH_ACTION_SCHEMA,
    async execute(_toolCallId, params: CoachToolParams, signal) {
      try {
        await context.beforeExecute?.();
        if (signal?.aborted) return errorResult(new Error('aborted'));
        const generationCall = context.createGenerationCall?.(signal) ?? context.generationCall;
        const transferVerificationCall =
          context.createTransferVerificationCall?.(signal) ?? context.transferVerificationCall;
        const deps = {
          store: context.runtimeStore,
          ownerId: turn.ownerId,
          agentSessionId: turn.agentSessionId,
          ...(context.now ? { now: context.now } : {}),
          ...(generationCall ? { generationCall } : {}),
          ...(transferVerificationCall ? { transferVerificationCall } : {}),
          ...(context.materialSource ? { materialSource: context.materialSource } : {}),
          ...(signal ? { abortSignal: signal } : {}),
        };
        if (params.action === 'get_state') {
          const observed = await getCoachProblemState(
            deps,
            params.profileId,
            params.coachSessionId,
          );
          if (signal?.aborted) return errorResult(new Error('aborted'));
          if (
            observed.state.transfer.attemptCount === 1 &&
            !observed.state.studyAttemptsProjected
          ) {
            const completed = await completePendingTransferAnswerEvaluation(deps, {
              profileId: params.profileId,
              coachSessionId: params.coachSessionId,
            });
            if (!completed) throw new CoachError('TRANSFER_EVALUATION_FAILED');
            if (signal?.aborted) return errorResult(new Error('aborted'));
            return toolResult(
              buildCoachToolSuccessOutput(
                completed.snapshot,
                { replayed: completed.replayed, eventAppended: completed.eventAppended },
                undefined,
                completed.presentation,
              ),
            );
          }
          const shouldPresentTransferQuestion =
            (observed.state.transfer.assigned && observed.state.transfer.attemptCount === 0) ||
            (!observed.state.transfer.assigned &&
              directiveForCoachState(observed.state) === 'GENERATE_TRANSFER_QUESTION');
          if (shouldPresentTransferQuestion) {
            const completed = await completeTransferQuestionGeneration(deps, {
              profileId: params.profileId,
              coachSessionId: params.coachSessionId,
            });
            if (signal?.aborted) return errorResult(new Error('aborted'));
            return toolResult(
              buildCoachToolSuccessOutput(
                completed.snapshot,
                { replayed: completed.replayed, eventAppended: completed.eventAppended },
                undefined,
                completed.presentation,
              ),
            );
          }
          return toolResult(
            buildCoachToolSuccessOutput(observed, { replayed: false, eventAppended: false }),
          );
        }

        const message = await context.readTrustedUserMessage();
        if (signal?.aborted) return errorResult(new Error('aborted'));
        if (message.seq !== turn.userMessageSeq) throw new CoachError('COACH_INPUT_INVALID');

        let result: CoachActionResult;
        if (params.action === 'start_problem') {
          let questionSource: { type: 'typed' } | { type: 'material'; materialId: string } = {
            type: 'typed',
          };
          if (params.questionSourceType === 'material') {
            const verified = await context.materialSource?.resolve(params.materialId);
            if (signal?.aborted) return errorResult(new Error('aborted'));
            const decision = verified
              ? evaluateCurriculumClaim(
                  'confirmed',
                  { type: 'source_attribution', source: verified.source },
                  verified.verifier,
                )
              : { allowed: false as const };
            if (!verified || !decision.allowed || verified.materialId !== params.materialId) {
              throw new CoachError('MATERIAL_SOURCE_NOT_VERIFIED');
            }
            questionSource = { type: 'material', materialId: verified.materialId };
          }
          result = await startCoachProblem(deps, {
            profileId: params.profileId,
            subjectId: params.subjectId,
            knowledgePointIds: params.knowledgePointIds,
            questionSource,
            message,
          });
        } else {
          const continuation = { ...params, message };
          switch (params.action) {
            case 'submit_attempt':
              result = await submitCoachAttempt(deps, continuation);
              break;
            case 'request_hint':
              result = await requestCoachHint(deps, continuation);
              break;
            case 'request_full_solution':
              result = await requestCoachFullSolution(deps, continuation);
              break;
            case 'submit_transfer_answer':
              result = await submitCoachTransferAnswer(deps, continuation);
              break;
            case 'abandon_problem':
              result = await abandonCoachProblem(deps, continuation);
              break;
          }
        }
        if (signal?.aborted) return errorResult(new Error('aborted'));
        let presentation: CoachPresentation | undefined;
        let snapshot = result.snapshot;
        let facts = { replayed: result.replayed, eventAppended: result.eventAppended };
        let code = result.code;
        if (params.action === 'request_hint' && result.code === undefined) {
          try {
            const completed = await completeCoachHintRequest(deps, {
              profileId: params.profileId,
              coachSessionId: params.coachSessionId,
              userMessageSeq: turn.userMessageSeq,
            });
            if (completed) {
              snapshot = completed.snapshot;
              presentation = completed.presentation;
              facts = { replayed: completed.replayed, eventAppended: completed.eventAppended };
            }
          } catch (error) {
            const failed = await settlePresentationFailure({
              deps,
              requestSnapshot: result.snapshot,
              turn,
              presentationKind: 'hint',
              profileId: params.profileId,
              coachSessionId: params.coachSessionId,
              error,
              signal,
            });
            if (!failed) throw error;
            snapshot = failed.result.snapshot;
            facts = {
              replayed: failed.result.replayed,
              eventAppended: failed.result.eventAppended,
            };
            code = failed.failureCode;
          }
        } else if (params.action === 'request_full_solution' && result.code === undefined) {
          try {
            const completed = await completeOriginalFullSolutionRequest(deps, {
              profileId: params.profileId,
              coachSessionId: params.coachSessionId,
              userMessageSeq: turn.userMessageSeq,
            });
            snapshot = completed.snapshot;
            presentation = completed.presentation;
            facts = { replayed: completed.replayed, eventAppended: completed.eventAppended };
          } catch (error) {
            const failed = await settlePresentationFailure({
              deps,
              requestSnapshot: result.snapshot,
              turn,
              presentationKind: 'full_solution',
              profileId: params.profileId,
              coachSessionId: params.coachSessionId,
              error,
              signal,
            });
            if (!failed) throw error;
            snapshot = failed.result.snapshot;
            facts = {
              replayed: failed.result.replayed,
              eventAppended: failed.result.eventAppended,
            };
            code = failed.failureCode;
          }
        } else if (params.action === 'submit_transfer_answer' && result.code === undefined) {
          const completed = await completeTransferAnswerEvaluation(deps, {
            profileId: params.profileId,
            coachSessionId: params.coachSessionId,
            userMessageSeq: turn.userMessageSeq,
          });
          snapshot = completed.snapshot;
          presentation = completed.presentation;
          facts = { replayed: completed.replayed, eventAppended: completed.eventAppended };
        }
        if (signal?.aborted) return errorResult(new Error('aborted'));
        return toolResult(buildCoachToolSuccessOutput(snapshot, facts, code, presentation));
      } catch (error) {
        return errorResult(error);
      }
    },
  };
  return tool as unknown as AgentTool<never, never>;
}

export const ZHONGKAO_COACH_TOOL_NAME = 'zhongkao_coach_action' as const;
