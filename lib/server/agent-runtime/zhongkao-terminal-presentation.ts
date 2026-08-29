import { createHash } from 'node:crypto';

import type { AfterToolCallContext, AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import {
  buildCoachNotice,
  COACH_TERMINAL_PRESENTATION_SCHEMA,
  renderCoachTerminalPresentation,
  validateCoachTerminalPresentation,
  type CoachTerminalNoticeReason,
  type CoachTerminalPresentation,
} from '@/lib/zhongkao/coach-public-presentation';
import { isCoachPresentationFailureCodeForKind } from '@/lib/zhongkao/coach-event';

import { durableUserMessageSeq } from './trusted-turn';
import {
  ZHONGKAO_COACH_ACTION_SCHEMA,
  ZHONGKAO_COACH_OUTPUT_SCHEMA,
  ZHONGKAO_COACH_TOOL_NAME,
  type CoachToolParams,
  type ZhongkaoCoachToolOutput,
} from './zhongkao-coach-tool';
import { isInterruptedToolResult } from './tool-call-integrity';

const CLOSED = { additionalProperties: false } as const;
const CORRELATION_PATTERN = '^coach-(?:turn|fallback)-v1:[A-Za-z0-9_-]{43}$';
const COACH_PRESENTATION_MARKER = 'openmaicCoachTerminalPresentation';

const CoachCorrelationInputSchema = Type.Object(
  {
    agentSessionId: Type.String({ minLength: 1, maxLength: 128 }),
    userMessageSeq: Type.Integer({ minimum: 1 }),
  },
  CLOSED,
);

const CoachFallbackCorrelationInputSchema = Type.Object(
  {
    agentSessionId: Type.String({ minLength: 1, maxLength: 128 }),
    fallbackUserMessageSeq: Type.Integer({ minimum: 1 }),
  },
  CLOSED,
);

const CoachPresentationMarkerSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    correlation: Type.String({ pattern: CORRELATION_PATTERN }),
    presentation: COACH_TERMINAL_PRESENTATION_SCHEMA,
  },
  CLOSED,
);

type CoachPresentationMarker = Static<typeof CoachPresentationMarkerSchema>;

export interface CoachPresentationCorrelationInput {
  agentSessionId: string;
  userMessageSeq: number;
}

export interface CoachFallbackCorrelationInput {
  agentSessionId: string;
  /** Stable durable row used only for idempotency, never as trusted provenance. */
  fallbackUserMessageSeq: number;
}

export type CoachTerminalPresentationSource =
  | { kind: 'tool_output'; output: unknown }
  | { kind: 'notice'; reason: CoachTerminalNoticeReason };

export interface ParsedCoachToolOutput {
  toolCallId: string;
  output: ZhongkaoCoachToolOutput;
}

export interface ParsedLiveCoachToolExecution extends ParsedCoachToolOutput {
  params: CoachToolParams;
}

export type CoachPresentationMessageModel = Pick<Model<Api>, 'api' | 'provider' | 'id'>;

export type CoachPublicationInspection =
  | { status: 'absent' }
  | {
      status: 'published';
      message: AgentMessage;
      presentation: CoachTerminalPresentation;
    }
  | { status: 'conflict' };

export type CoachPublicationPlan =
  | {
      kind: 'append';
      correlation: string;
      presentation: CoachTerminalPresentation;
      message: AgentMessage;
    }
  | {
      kind: 'already-published';
      correlation: string;
      presentation: CoachTerminalPresentation;
      message: AgentMessage;
    }
  | { kind: 'conflict'; correlation: string };

export interface RecoveredCoachToolPresentation {
  toolCallId: string;
  output: ZhongkaoCoachToolOutput;
  presentation: CoachTerminalPresentation;
  correlation: string;
}

export type DurableCoachToolCallRecovery =
  | { status: 'absent' }
  | { status: 'invalid' }
  | {
      status: 'recoverable';
      toolCallId: string;
      params: CoachToolParams;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Validate a Coach DTO with the same runtime schema used by the tool boundary. */
export function validateZhongkaoCoachToolOutput(value: unknown): ZhongkaoCoachToolOutput | null {
  return Value.Check(ZHONGKAO_COACH_OUTPUT_SCHEMA, value)
    ? (value as ZhongkaoCoachToolOutput)
    : null;
}

function parseOutputEnvelope(value: unknown): ZhongkaoCoachToolOutput | null {
  if (!isRecord(value)) return null;
  if (value.details !== undefined) {
    // A present details field is authoritative. Do not accept contradictory
    // JSON text when authoritative details are malformed.
    return validateZhongkaoCoachToolOutput(value.details);
  }
  if (!Array.isArray(value.content) || value.content.length !== 1) return null;
  const block = value.content[0];
  if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return null;
  try {
    return validateZhongkaoCoachToolOutput(JSON.parse(block.text));
  } catch {
    return null;
  }
}

/** Parse the live Pi hook context without trusting a caller-supplied tool name. */
export function parseCoachAfterToolCallContext(
  context: Pick<AfterToolCallContext, 'toolCall' | 'result'> | unknown,
): ParsedLiveCoachToolExecution | null {
  if (!isRecord(context) || !isRecord(context.toolCall)) return null;
  if (
    context.toolCall.name !== ZHONGKAO_COACH_TOOL_NAME ||
    typeof context.toolCall.id !== 'string' ||
    context.toolCall.id.length === 0 ||
    !Value.Check(ZHONGKAO_COACH_ACTION_SCHEMA, context.toolCall.arguments)
  ) {
    return null;
  }
  const output = parseOutputEnvelope(context.result);
  return output
    ? {
        toolCallId: context.toolCall.id,
        params: context.toolCall.arguments as CoachToolParams,
        output,
      }
    : null;
}

/** Parse a checkpointed Pi receipt; malformed or non-Coach results fail closed. */
export function parseDurableCoachToolResult(message: unknown): ParsedCoachToolOutput | null {
  if (
    !isRecord(message) ||
    message.role !== 'toolResult' ||
    message.toolName !== ZHONGKAO_COACH_TOOL_NAME ||
    typeof message.toolCallId !== 'string' ||
    message.toolCallId.length === 0
  ) {
    return null;
  }
  const output = parseOutputEnvelope(message);
  return output ? { toolCallId: message.toolCallId, output } : null;
}

function noticeReasonForOutput(output: ZhongkaoCoachToolOutput): CoachTerminalNoticeReason {
  if (!output.ok && output.code) return output.code;
  if (output.directive === 'FULL_SOLUTION_LOCKED') return 'FULL_SOLUTION_LOCKED';
  return 'COACH_PRESENTATION_NOT_PERSISTED';
}

/**
 * Convert a schema-valid tool DTO or a stable gate state into the sole public
 * terminal union. Invalid DTOs and unproven presentation provenance become
 * fixed server copy rather than model or provider error text.
 */
export function buildCoachTerminalPresentation(
  source: CoachTerminalPresentationSource,
): CoachTerminalPresentation {
  if (source.kind === 'notice') return buildCoachNotice(source.reason);

  const output = validateZhongkaoCoachToolOutput(source.output);
  if (!output) return buildCoachNotice('COACH_TOOL_RESULT_INVALID');
  if (!output.ok || output.code !== undefined) {
    return buildCoachNotice(noticeReasonForOutput(output));
  }
  if (output.presentation !== undefined) {
    const presentation = validateCoachTerminalPresentation(output.presentation);
    const persisted = output.facts.eventAppended || output.facts.replayed;
    if (presentation && presentation.kind !== 'coach_notice' && persisted) return presentation;
    return buildCoachNotice('COACH_PRESENTATION_NOT_PERSISTED');
  }
  return buildCoachNotice(noticeReasonForOutput(output));
}

/** Derive one turn-stable opaque id without depending on a retried tool call id. */
export function createCoachPresentationCorrelation(
  input: CoachPresentationCorrelationInput,
): string {
  if (!Value.Check(CoachCorrelationInputSchema, input)) {
    throw new Error('Invalid Coach presentation correlation input');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(['coach-turn', 1, input.agentSessionId, input.userMessageSeq]), 'utf8')
    .digest('base64url');
  return `coach-turn-v1:${digest}`;
}

/**
 * Derive a retry-stable id when damaged provenance permits only a fixed notice.
 * Its separate hash domain prevents the fallback from impersonating a user turn.
 */
export function createCoachFallbackCorrelation(input: CoachFallbackCorrelationInput): string {
  if (!Value.Check(CoachFallbackCorrelationInputSchema, input)) {
    throw new Error('Invalid Coach fallback correlation input');
  }
  const digest = createHash('sha256')
    .update(
      JSON.stringify(['coach-fallback', 1, input.agentSessionId, input.fallbackUserMessageSeq]),
      'utf8',
    )
    .digest('base64url');
  return `coach-fallback-v1:${digest}`;
}

function markerFor(
  correlation: string,
  presentation: CoachTerminalPresentation,
): CoachPresentationMarker {
  const marker = { schemaVersion: 1 as const, correlation, presentation };
  if (!Value.Check(CoachPresentationMarkerSchema, marker)) {
    throw new Error('Invalid Coach presentation marker');
  }
  return marker;
}

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

const SERVER_PRESENTATION_MODEL = {
  api: 'unknown',
  provider: 'openmaic-server',
  id: 'zhongkao-coach',
} as unknown as CoachPresentationMessageModel;

/** Build one complete assistant frame whose visible text comes only from the public payload. */
export function createCoachPresentationAssistantMessage(input: {
  presentation: CoachTerminalPresentation;
  correlation: string;
  model?: CoachPresentationMessageModel;
  now?: () => number;
}): AgentMessage {
  const presentation = validateCoachTerminalPresentation(input.presentation);
  if (!presentation) throw new Error('Invalid Coach terminal presentation');
  const marker = markerFor(input.correlation, presentation);
  const model = input.model ?? SERVER_PRESENTATION_MODEL;
  return {
    role: 'assistant',
    content: [{ type: 'text', text: renderCoachTerminalPresentation(presentation) }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
    stopReason: 'stop',
    timestamp: (input.now ?? Date.now)(),
    [COACH_PRESENTATION_MARKER]: marker,
  } as AssistantMessage as AgentMessage;
}

function markerCorrelation(value: unknown): string | null {
  return isRecord(value) && typeof value.correlation === 'string' ? value.correlation : null;
}

function presentationFromMarkedMessage(message: AgentMessage, correlation: string) {
  if (message.role !== 'assistant') return null;
  const record = message as AgentMessage & Record<string, unknown>;
  const rawMarker = record[COACH_PRESENTATION_MARKER];
  if (!Value.Check(CoachPresentationMarkerSchema, rawMarker)) return null;
  const marker = rawMarker as CoachPresentationMarker;
  if (marker.correlation !== correlation) return null;
  const presentation = validateCoachTerminalPresentation(marker.presentation);
  if (!presentation) return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block = content[0];
  if (
    !isRecord(block) ||
    block.type !== 'text' ||
    block.text !== renderCoachTerminalPresentation(presentation)
  ) {
    return null;
  }
  return presentation;
}

/** Inspect raw append-only messages so retries do not append the same causal output twice. */
export function inspectCoachPresentationPublication(
  cursorMessages: readonly AgentMessage[],
  correlation: string,
): CoachPublicationInspection {
  if (!new RegExp(CORRELATION_PATTERN).test(correlation)) return { status: 'conflict' };
  const candidates = cursorMessages.filter((message) => {
    if (!isRecord(message)) return false;
    const marker = message[COACH_PRESENTATION_MARKER];
    return markerCorrelation(marker) === correlation;
  });
  if (candidates.length === 0) return { status: 'absent' };
  if (candidates.length !== 1) return { status: 'conflict' };
  const presentation = presentationFromMarkedMessage(candidates[0]!, correlation);
  return presentation
    ? { status: 'published', message: candidates[0]!, presentation }
    : { status: 'conflict' };
}

/** Inspect the event.data shape used by durable message_start/message_end rows. */
export function inspectCoachPresentationEventData(
  eventData: unknown,
  correlation: string,
): CoachPublicationInspection {
  if (!isRecord(eventData) || !isRecord(eventData.message)) return { status: 'absent' };
  return inspectCoachPresentationPublication(
    [eventData.message as unknown as AgentMessage],
    correlation,
  );
}

/** Keep durable idempotency metadata server-side when replaying an event to clients. */
export function redactCoachPresentationMarkerForPublicEventData(eventData: unknown): unknown {
  if (!isRecord(eventData) || !isRecord(eventData.message)) return eventData;
  if (!Object.hasOwn(eventData.message, COACH_PRESENTATION_MARKER)) return eventData;
  const { [COACH_PRESENTATION_MARKER]: _marker, ...message } = eventData.message;
  return { ...eventData, message };
}

function samePresentation(
  left: CoachTerminalPresentation,
  right: CoachTerminalPresentation,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'hint' && right.kind === 'hint') return left.text === right.text;
  if (left.kind === 'coach_notice' && right.kind === 'coach_notice') {
    return left.text === right.text;
  }
  if (left.kind === 'transfer_result' && right.kind === 'transfer_result') {
    return left.outcome === right.outcome && left.message === right.message;
  }
  if (left.kind === 'transfer_question' && right.kind === 'transfer_question') {
    if (
      left.transferQuestionId !== right.transferQuestionId ||
      left.type !== right.type ||
      left.question !== right.question ||
      left.difficulty !== right.difficulty
    ) {
      return false;
    }
    const leftChoice = 'options' in left;
    const rightChoice = 'options' in right;
    if (!leftChoice || !rightChoice) return !leftChoice && !rightChoice;
    if (left.options.length !== right.options.length) return false;
    return left.options.every(
      (option, index) =>
        option.id === right.options[index]?.id && option.text === right.options[index]?.text,
    );
  }
  return (
    left.kind === 'full_solution' &&
    right.kind === 'full_solution' &&
    left.explanation === right.explanation &&
    left.finalAnswer === right.finalAnswer
  );
}

/** One pure idempotency decision for append, replay, or corrupted durable state. */
export function planCoachPresentationPublication(input: {
  cursorMessages: readonly AgentMessage[];
  presentation: CoachTerminalPresentation;
  correlation: string;
  model?: CoachPresentationMessageModel;
  now?: () => number;
}): CoachPublicationPlan {
  const presentation = validateCoachTerminalPresentation(input.presentation);
  if (!presentation) return { kind: 'conflict', correlation: input.correlation };
  const inspected = inspectCoachPresentationPublication(input.cursorMessages, input.correlation);
  if (inspected.status === 'conflict') {
    return { kind: 'conflict', correlation: input.correlation };
  }
  if (inspected.status === 'published') {
    return samePresentation(inspected.presentation, presentation)
      ? {
          kind: 'already-published',
          correlation: input.correlation,
          presentation: inspected.presentation,
          message: inspected.message,
        }
      : { kind: 'conflict', correlation: input.correlation };
  }
  return {
    kind: 'append',
    correlation: input.correlation,
    presentation,
    message: createCoachPresentationAssistantMessage({
      presentation,
      correlation: input.correlation,
      ...(input.model ? { model: input.model } : {}),
      ...(input.now ? { now: input.now } : {}),
    }),
  };
}

type DurableCoachTurnInspection =
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'retryable'; toolCallId: string; params: CoachToolParams }
  | {
      status: 'completed';
      toolCallId: string;
      params: CoachToolParams;
      output: ZhongkaoCoachToolOutput;
    };

type CoachOutputCode = NonNullable<ZhongkaoCoachToolOutput['code']>;

const STABLE_UNPROVEN_CODES_BY_ACTION: Readonly<
  Record<CoachToolParams['action'], ReadonlySet<CoachOutputCode>>
> = {
  start_problem: new Set([
    'COACH_INPUT_INVALID',
    'COACH_PROFILE_NOT_FOUND',
    'COACH_SESSION_NOT_FOUND',
  ]),
  get_state: new Set([
    'COACH_INPUT_INVALID',
    'COACH_SESSION_NOT_FOUND',
    'TRANSFER_QUESTION_GENERATION_FAILED',
    'TRANSFER_QUESTION_INVALID',
    'TRANSFER_QUESTION_TYPE_UNSUPPORTED',
    'TRANSFER_QUESTION_NOT_VERIFIED',
  ]),
  submit_attempt: new Set([
    'COACH_INPUT_INVALID',
    'COACH_SESSION_NOT_FOUND',
    'COACH_ACTION_NOT_ALLOWED',
    'COACH_MESSAGE_ALREADY_COUNTED',
  ]),
  request_hint: new Set([
    'COACH_INPUT_INVALID',
    'COACH_SESSION_NOT_FOUND',
    'COACH_ACTION_NOT_ALLOWED',
    'HINT_LIMIT_REACHED',
    'HINT_GENERATION_PENDING',
  ]),
  request_full_solution: new Set([
    'COACH_INPUT_INVALID',
    'COACH_SESSION_NOT_FOUND',
    'COACH_ACTION_NOT_ALLOWED',
  ]),
  submit_transfer_answer: new Set([
    'COACH_INPUT_INVALID',
    'COACH_SESSION_NOT_FOUND',
    'COACH_ACTION_NOT_ALLOWED',
    'TRANSFER_QUESTION_REQUIRED',
    'TRANSFER_QUESTION_NOT_VERIFIED',
    'TRANSFER_ANSWER_INVALID',
    'TRANSFER_EVALUATION_FAILED',
    'COACH_MESSAGE_ALREADY_COUNTED',
  ]),
  abandon_problem: new Set([
    'COACH_INPUT_INVALID',
    'COACH_SESSION_NOT_FOUND',
    'COACH_ACTION_NOT_ALLOWED',
  ]),
};

function unprovenCoachErrorCanSettle(params: CoachToolParams, code: CoachOutputCode): boolean {
  if (
    params.action === 'start_problem' &&
    (code === 'MATERIAL_SOURCE_NOT_SUPPORTED' || code === 'MATERIAL_SOURCE_NOT_VERIFIED')
  ) {
    return params.questionSourceType === 'material';
  }
  return STABLE_UNPROVEN_CODES_BY_ACTION[params.action].has(code);
}

function provenCoachErrorCanSettle(params: CoachToolParams, code: CoachOutputCode): boolean {
  if (params.action === 'request_hint') {
    return isCoachPresentationFailureCodeForKind('hint', code);
  }
  if (params.action === 'request_full_solution') {
    return (
      code === 'FULL_SOLUTION_LOCKED' ||
      isCoachPresentationFailureCodeForKind('full_solution', code)
    );
  }
  return false;
}

/** Decide whether a Coach result can permanently settle its exact durable turn. */
export function coachToolOutputCanSettle(
  params: CoachToolParams,
  output: ZhongkaoCoachToolOutput,
): boolean {
  const operationProven = output.facts.eventAppended || output.facts.replayed;
  if (output.ok) {
    if (output.code !== undefined) return false;
    if (params.action === 'get_state') {
      return (
        output.presentation === undefined ||
        (operationProven &&
          (output.presentation.kind === 'transfer_question' ||
            output.presentation.kind === 'transfer_result'))
      );
    }
    if (params.action === 'request_hint') {
      return operationProven && output.presentation?.kind === 'hint';
    }
    if (params.action === 'request_full_solution') {
      return operationProven && output.presentation?.kind === 'full_solution';
    }
    if (params.action === 'submit_transfer_answer') {
      return operationProven && output.presentation?.kind === 'transfer_result';
    }
    if (!operationProven) return false;
    return output.presentation === undefined;
  }
  if (output.code === undefined) return false;
  if (output.presentation !== undefined) return false;
  return operationProven
    ? provenCoachErrorCanSettle(params, output.code)
    : unprovenCoachErrorCanSettle(params, output.code);
}

/**
 * Inspect the exact tagged turn once. Complete forced-Skill preload pairs may
 * precede the sole Coach call; every other ambiguity fails closed. A unique
 * malformed/timeout receipt remains retryable because the Coach operation is
 * idempotent and may already have committed before its response was lost.
 */
function inspectDurableCoachTurn(input: {
  cursorMessages: readonly AgentMessage[];
  userMessageSeq: number;
}): DurableCoachTurnInspection {
  const userIndexes = input.cursorMessages.flatMap((message, index) =>
    durableUserMessageSeq(message) === input.userMessageSeq ? [index] : [],
  );
  if (userIndexes.length !== 1) return { status: 'invalid' };
  const start = userIndexes[0]! + 1;
  const nextUserOffset = input.cursorMessages
    .slice(start)
    .findIndex((message) => message.role === 'user');
  const end = nextUserOffset < 0 ? input.cursorMessages.length : start + nextUserOffset;
  const turnMessages = input.cursorMessages.slice(start, end);
  const calls = turnMessages.flatMap((message, messageIndex) => {
    if (message.role !== 'assistant') return [];
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part, partIndex) =>
      isRecord(part) && part.type === 'toolCall' ? [{ call: part, messageIndex, partIndex }] : [],
    );
  });
  const receipts = turnMessages.flatMap((message, messageIndex) =>
    message.role === 'toolResult' ? [{ message, messageIndex }] : [],
  );
  if (calls.length === 0) {
    return receipts.length === 0 ? { status: 'absent' } : { status: 'invalid' };
  }
  if (
    calls.some(
      ({ call }) =>
        typeof call.id !== 'string' || call.id.length === 0 || typeof call.name !== 'string',
    ) ||
    new Set(calls.map(({ call }) => call.id)).size !== calls.length
  ) {
    return { status: 'invalid' };
  }

  const coachCalls = calls.filter(({ call }) => call.name === ZHONGKAO_COACH_TOOL_NAME);
  if (coachCalls.length > 1) return { status: 'invalid' };

  const receiptFor = (id: string) => receipts.filter(({ message }) => message.toolCallId === id);
  const receiptMatchesCall = (
    entry: (typeof receipts)[number],
    expected: Record<string, unknown>,
  ) => entry.message.toolCallId === expected.id && entry.message.toolName === expected.name;

  // Forced Skill loading is durably represented before the model runs as one
  // or more complete assistant(read) + toolResult pairs. Those server-authored
  // prefix pairs belong to this turn and must not make a later orphaned Coach
  // call ambiguous. Any incomplete, duplicate, or out-of-order prefix still
  // fails closed.
  if (coachCalls.length === 0) {
    const knownIds = new Set(calls.map(({ call }) => call.id as string));
    const completePrefix =
      receipts.every(({ message }) => knownIds.has(message.toolCallId)) &&
      calls.every(({ call, messageIndex }) => {
        const matches = receiptFor(call.id as string);
        return (
          call.name === 'read' &&
          matches.length === 1 &&
          matches[0]!.messageIndex > messageIndex &&
          receiptMatchesCall(matches[0]!, call) &&
          !isInterruptedToolResult(matches[0]!.message)
        );
      });
    return completePrefix ? { status: 'absent' } : { status: 'invalid' };
  }

  const coachEntry = coachCalls[0]!;
  const call = coachEntry.call;
  if (!Value.Check(ZHONGKAO_COACH_ACTION_SCHEMA, call.arguments)) {
    return { status: 'invalid' };
  }
  if (
    calls.some(
      (entry) =>
        entry !== coachEntry &&
        (entry.call.name !== 'read' ||
          entry.messageIndex >= coachEntry.messageIndex ||
          receiptFor(entry.call.id as string).length !== 1 ||
          receiptFor(entry.call.id as string)[0]!.messageIndex <= entry.messageIndex ||
          receiptFor(entry.call.id as string)[0]!.messageIndex >= coachEntry.messageIndex ||
          !receiptMatchesCall(receiptFor(entry.call.id as string)[0]!, entry.call) ||
          isInterruptedToolResult(receiptFor(entry.call.id as string)[0]!.message)),
    )
  ) {
    return { status: 'invalid' };
  }
  const knownIds = new Set(calls.map(({ call: knownCall }) => knownCall.id as string));
  if (receipts.some(({ message }) => !knownIds.has(message.toolCallId))) {
    return { status: 'invalid' };
  }
  const coachReceipts = receiptFor(call.id as string);
  if (coachReceipts.length > 1) {
    return { status: 'invalid' };
  }
  const params = call.arguments as CoachToolParams;
  if (coachReceipts.length === 0) {
    return { status: 'retryable', toolCallId: call.id as string, params };
  }
  const coachReceipt = coachReceipts[0]!;
  if (
    coachReceipt.messageIndex <= coachEntry.messageIndex ||
    coachReceipt.message.toolName !== ZHONGKAO_COACH_TOOL_NAME
  ) {
    return { status: 'invalid' };
  }
  if (isInterruptedToolResult(coachReceipt.message)) {
    return { status: 'retryable', toolCallId: call.id as string, params };
  }
  const parsed = parseDurableCoachToolResult(coachReceipt.message);
  if (
    !parsed ||
    parsed.toolCallId !== call.id ||
    coachReceipt.message.isError !== !parsed.output.ok ||
    !coachToolOutputCanSettle(params, parsed.output)
  ) {
    return { status: 'retryable', toolCallId: call.id as string, params };
  }
  return {
    status: 'completed',
    toolCallId: call.id as string,
    params,
    output: parsed.output,
  };
}

/** Recover only a causally matched, authoritative Coach call + receipt pair. */
export function recoverCoachToolPresentation(input: {
  cursorMessages: readonly AgentMessage[];
  agentSessionId: string;
  userMessageSeq: number;
}): RecoveredCoachToolPresentation | null {
  const inspected = inspectDurableCoachTurn(input);
  if (inspected.status !== 'completed') return null;
  return {
    toolCallId: inspected.toolCallId,
    output: inspected.output,
    presentation: buildCoachTerminalPresentation({
      kind: 'tool_output',
      output: inspected.output,
    }),
    correlation: createCoachPresentationCorrelation({
      agentSessionId: input.agentSessionId,
      userMessageSeq: input.userMessageSeq,
    }),
  };
}

/** Project an orphan/uncertain exact call for bounded idempotent re-execution. */
export function recoverDurableCoachToolCall(input: {
  cursorMessages: readonly AgentMessage[];
  userMessageSeq: number;
}): DurableCoachToolCallRecovery {
  const inspected = inspectDurableCoachTurn(input);
  if (inspected.status === 'absent' || inspected.status === 'invalid') return inspected;
  if (inspected.status === 'completed') return { status: 'invalid' };
  return {
    status: 'recoverable',
    toolCallId: inspected.toolCallId,
    params: inspected.params,
  };
}
