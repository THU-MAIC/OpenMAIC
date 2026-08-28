import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { RuntimeStore } from '@openmaic/storage';
import type { PgAgentSessionStore } from '@openmaic/storage/agent-session/pg';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import {
  abandonCoachProblem,
  getCoachProblemState,
  requestCoachFullSolution,
  requestCoachHint,
  startCoachProblem,
  submitCoachAttempt,
  submitCoachTransferAnswer,
  type CoachActionResult,
  type TrustedCoachUserMessage,
} from '@/lib/server/zhongkao/coach-service';
import type { CoachRuntimeSnapshot } from '@/lib/server/zhongkao/coach-runtime';
import { CoachError, isCoachError } from '@/lib/zhongkao/coach-errors';
import {
  COACH_MODEL_ACTIONS,
  allowedCoachActions,
  directiveForCoachState,
} from '@/lib/zhongkao/coach-policy';
import type { CoachState } from '@/lib/zhongkao/coach-state';
import { COACH_TRUSTED_MESSAGE_MAX_LENGTH } from '@/lib/zhongkao/coach-event';

import { listAgentUserMessages } from './user-messages';

const CLOSED = { additionalProperties: false } as const;
const IDENTIFIER = Type.String({ minLength: 1, maxLength: 128 });
const EXPECTED_REVISION = Type.Integer({ minimum: 0 });

const StartProblemSchema = Type.Object(
  {
    action: Type.Literal('start_problem'),
    profileId: IDENTIFIER,
    subjectId: IDENTIFIER,
    knowledgePointIds: Type.Array(IDENTIFIER, {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
    questionSourceType: Type.Union([Type.Literal('typed'), Type.Literal('material')]),
  },
  CLOSED,
);

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

export const ZHONGKAO_COACH_OUTPUT_SCHEMA = Type.Object(
  {
    ok: Type.Boolean(),
    code: Type.Optional(CoachErrorCodeSchema),
    coachSessionId: Type.Optional(IDENTIFIER),
    revision: Type.Optional(Type.Integer({ minimum: 0 })),
    state: Type.Optional(PublicCoachStateSchema),
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

type CoachToolParams = Static<typeof ZHONGKAO_COACH_ACTION_SCHEMA>;
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
): ZhongkaoCoachToolOutput {
  return validateOutput({
    ok: code === undefined,
    ...(code ? { code } : {}),
    coachSessionId: snapshot.state.coachSessionId,
    revision: snapshot.state.revision,
    state: publicState(snapshot.state),
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
      if (signal?.aborted) return errorResult(new Error('aborted'));
      const deps = {
        store: context.runtimeStore,
        ownerId: turn.ownerId,
        agentSessionId: turn.agentSessionId,
        ...(context.now ? { now: context.now } : {}),
      };
      try {
        if (params.action === 'get_state') {
          const snapshot = await getCoachProblemState(
            deps,
            params.profileId,
            params.coachSessionId,
          );
          return toolResult(
            buildCoachToolSuccessOutput(snapshot, { replayed: false, eventAppended: false }),
          );
        }

        const message = await context.readTrustedUserMessage();
        if (message.seq !== turn.userMessageSeq) throw new CoachError('COACH_INPUT_INVALID');

        let result: CoachActionResult;
        if (params.action === 'start_problem') {
          result = await startCoachProblem(deps, { ...params, message });
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
        return toolResult(
          buildCoachToolSuccessOutput(
            result.snapshot,
            { replayed: result.replayed, eventAppended: result.eventAppended },
            result.code,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  };
  return tool as unknown as AgentTool<never, never>;
}

export const ZHONGKAO_COACH_TOOL_NAME = 'zhongkao_coach_action' as const;
