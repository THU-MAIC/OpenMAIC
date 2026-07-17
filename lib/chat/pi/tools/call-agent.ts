import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import type { LanguageModel } from 'ai';
import { nanoid } from 'nanoid';
import { buildAgent } from '@/lib/agent/runtime/build-agent';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import {
  createParserState,
  finalizeParser,
  looksLikeStructuredFragment,
  parseStructuredChunk,
  type ParseResult,
} from '@/lib/orchestration/stateless-generate';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { AgentTurnSummary, WhiteboardActionRecord } from '@/lib/orchestration/types';
import type { ThinkingConfig } from '@/lib/types/provider';
import type { ParsedAction, StatelessChatRequest } from '@/lib/types/chat';
import {
  buildChildPrompt,
  buildChildTurnPrompt,
  extractLastAssistantText,
  sanitizeVisibleSpeech,
  toHistoryMessages,
} from '../prompts';
import type { SendEvent } from '../types';
import { buildChildActionTools, createPiWhiteboardRuntimeState } from './classroom-actions';

const CallAgentParams = Type.Object({
  agentId: Type.String({
    description: 'ID of the classroom agent that should speak next.',
  }),
  instruction: Type.String({
    description: 'Specific instruction and context for the selected agent response.',
  }),
  turnKind: Type.Optional(
    Type.Union([Type.Literal('normal'), Type.Literal('wrap_up')], {
      description:
        'Use "wrap_up" only for one final teacher summary before cue_user or close_session. Normal discussion turns should omit this or use "normal".',
    }),
  ),
});

type CallAgentParams = Static<typeof CallAgentParams>;

type ChildActionTool = ReturnType<typeof buildChildActionTools>[number];
type ChildMessageEvent = {
  type: string;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
  };
};
type ActionWarning = {
  actionName?: string;
  reason: 'unknown_action' | 'invalid_params' | 'raw_structured_fallback';
  message: string;
};

const SHAPE_TYPES = new Set(['rectangle', 'circle', 'triangle']);
const CHART_TYPES = new Set(['bar', 'column', 'line', 'pie', 'ring', 'area', 'radar', 'scatter']);
const LINE_STYLES = new Set(['solid', 'dashed']);
const CODE_EDIT_OPERATIONS = new Set([
  'insert_after',
  'insert_before',
  'delete_lines',
  'replace_lines',
]);

function getAssistantTextDelta(event: ChildMessageEvent): string | null {
  if (event.type !== 'message_update') return null;
  const assistantEvent = event.assistantMessageEvent;
  if (!assistantEvent) return null;
  if (assistantEvent.type !== 'text_delta') return null;
  return assistantEvent.delta ?? '';
}

async function emitTextDelta(opts: {
  content: string;
  messageId: string;
  send: SendEvent;
  appendText: (content: string) => void;
}): Promise<void> {
  const visibleDelta = sanitizeVisibleSpeech(opts.content);
  if (!visibleDelta) return;
  opts.appendText(visibleDelta);
  await opts.send({
    type: 'text_delta',
    data: { content: visibleDelta, messageId: opts.messageId },
  });
}

function isLikelyRawStructuredFallback(content: string): boolean {
  // Backstop only — the structured parser (finalizeParser) is the primary
  // defense. Delegate to the shared structural classifier rather than the old
  // brittle substring checks so brace-less JSON fragments are caught too.
  return looksLikeStructuredFragment(content);
}

function requireString(
  params: Record<string, unknown>,
  field: string,
  actionName: string,
): string | null {
  return typeof params[field] === 'string' && params[field].length > 0
    ? null
    : `${actionName} requires params.${field} string`;
}

function requireNumber(
  params: Record<string, unknown>,
  field: string,
  actionName: string,
): string | null {
  return typeof params[field] === 'number' ? null : `${actionName} requires params.${field} number`;
}

function optionalNumber(
  params: Record<string, unknown>,
  field: string,
  actionName: string,
): string | null {
  return params[field] !== undefined && typeof params[field] !== 'number'
    ? `${actionName} params.${field} must be a number`
    : null;
}

function optionalString(
  params: Record<string, unknown>,
  field: string,
  actionName: string,
): string | null {
  return params[field] !== undefined && typeof params[field] !== 'string'
    ? `${actionName} params.${field} must be a string`
    : null;
}

function validateOptionalElementId(
  params: Record<string, unknown>,
  actionName: string,
): string | null {
  return optionalString(params, 'elementId', actionName);
}

function validateRequiredPosition(
  params: Record<string, unknown>,
  actionName: string,
  fields: string[],
): string | null {
  for (const field of fields) {
    const error = requireNumber(params, field, actionName);
    if (error) return error;
  }
  return null;
}

function validateOptionalBox(
  params: Record<string, unknown>,
  actionName: string,
  fields: string[],
): string | null {
  for (const field of fields) {
    const error = optionalNumber(params, field, actionName);
    if (error) return error;
  }
  return null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNumberMatrix(value: unknown): value is number[][] {
  return (
    Array.isArray(value) &&
    value.every((row) => Array.isArray(row) && row.every((item) => typeof item === 'number'))
  );
}

function isStringMatrix(value: unknown): value is string[][] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const columnCount = Array.isArray(value[0]) ? value[0].length : 0;
  return (
    columnCount > 0 &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === columnCount &&
        row.every((item) => typeof item === 'string'),
    )
  );
}

function validateChartData(params: Record<string, unknown>): string | null {
  const data = params.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'wb_draw_chart requires params.data object';
  }
  const chartData = data as Record<string, unknown>;
  if (!isStringArray(chartData.labels)) {
    return 'wb_draw_chart params.data.labels must be a string array';
  }
  if (!isStringArray(chartData.legends)) {
    return 'wb_draw_chart params.data.legends must be a string array';
  }
  if (!isNumberMatrix(chartData.series)) {
    return 'wb_draw_chart params.data.series must be a number matrix';
  }
  return null;
}

function validateLinePoints(params: Record<string, unknown>): string | null {
  const points = params.points;
  if (points === undefined) return null;
  if (!Array.isArray(points) || points.length !== 2) {
    return 'wb_draw_line params.points must be a two-item marker tuple';
  }
  if (!points.every((marker) => marker === '' || marker === 'arrow')) {
    return 'wb_draw_line params.points markers must be "" or "arrow"';
  }
  return null;
}

function validateActionParams(action: ParsedAction): string | null {
  const params = action.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return 'params must be an object';
  }

  if (action.actionName === 'spotlight') {
    return (
      requireString(params, 'elementId', 'spotlight') ??
      optionalNumber(params, 'dimOpacity', 'spotlight')
    );
  }

  if (action.actionName === 'laser') {
    return requireString(params, 'elementId', 'laser') ?? optionalString(params, 'color', 'laser');
  }

  if (action.actionName === 'play_video') {
    return requireString(params, 'elementId', 'play_video');
  }

  if (
    action.actionName === 'wb_open' ||
    action.actionName === 'wb_close' ||
    action.actionName === 'wb_clear'
  ) {
    return null;
  }

  if (action.actionName === 'wb_delete') {
    return requireString(params, 'elementId', 'wb_delete');
  }

  if (action.actionName === 'wb_draw_text') {
    return (
      requireString(params, 'content', 'wb_draw_text') ??
      validateRequiredPosition(params, 'wb_draw_text', ['x', 'y']) ??
      validateOptionalBox(params, 'wb_draw_text', ['width', 'height', 'fontSize']) ??
      optionalString(params, 'color', 'wb_draw_text') ??
      validateOptionalElementId(params, 'wb_draw_text')
    );
  }

  if (action.actionName === 'wb_draw_shape') {
    return (
      (typeof params.shape === 'string' && SHAPE_TYPES.has(params.shape)
        ? null
        : 'wb_draw_shape requires params.shape rectangle|circle|triangle') ??
      validateRequiredPosition(params, 'wb_draw_shape', ['x', 'y', 'width', 'height']) ??
      optionalString(params, 'fillColor', 'wb_draw_shape') ??
      validateOptionalElementId(params, 'wb_draw_shape')
    );
  }

  if (action.actionName === 'wb_draw_chart') {
    return (
      (typeof params.chartType === 'string' && CHART_TYPES.has(params.chartType)
        ? null
        : 'wb_draw_chart requires params.chartType bar|column|line|pie|ring|area|radar|scatter') ??
      validateRequiredPosition(params, 'wb_draw_chart', ['x', 'y', 'width', 'height']) ??
      validateChartData(params) ??
      (params.themeColors !== undefined && !isStringArray(params.themeColors)
        ? 'wb_draw_chart params.themeColors must be a string array'
        : null) ??
      validateOptionalElementId(params, 'wb_draw_chart')
    );
  }

  if (action.actionName === 'wb_draw_latex') {
    return (
      requireString(params, 'latex', 'wb_draw_latex') ??
      validateRequiredPosition(params, 'wb_draw_latex', ['x', 'y']) ??
      validateOptionalBox(params, 'wb_draw_latex', ['width', 'height']) ??
      optionalString(params, 'color', 'wb_draw_latex') ??
      validateOptionalElementId(params, 'wb_draw_latex')
    );
  }

  if (action.actionName === 'wb_draw_table') {
    return (
      validateRequiredPosition(params, 'wb_draw_table', ['x', 'y', 'width', 'height']) ??
      (isStringMatrix(params.data)
        ? null
        : 'wb_draw_table requires a non-empty rectangular params.data string matrix') ??
      validateOptionalElementId(params, 'wb_draw_table')
    );
  }

  if (action.actionName === 'wb_draw_line') {
    return (
      validateRequiredPosition(params, 'wb_draw_line', ['startX', 'startY', 'endX', 'endY']) ??
      optionalString(params, 'color', 'wb_draw_line') ??
      optionalNumber(params, 'width', 'wb_draw_line') ??
      (params.style !== undefined &&
      (typeof params.style !== 'string' || !LINE_STYLES.has(params.style))
        ? 'wb_draw_line params.style must be solid or dashed'
        : null) ??
      validateLinePoints(params) ??
      validateOptionalElementId(params, 'wb_draw_line')
    );
  }

  if (action.actionName === 'wb_draw_code') {
    return (
      requireString(params, 'language', 'wb_draw_code') ??
      requireString(params, 'code', 'wb_draw_code') ??
      validateRequiredPosition(params, 'wb_draw_code', ['x', 'y']) ??
      validateOptionalBox(params, 'wb_draw_code', ['width', 'height']) ??
      optionalString(params, 'fileName', 'wb_draw_code') ??
      validateOptionalElementId(params, 'wb_draw_code')
    );
  }

  if (action.actionName === 'wb_edit_code') {
    const commonError =
      requireString(params, 'elementId', 'wb_edit_code') ??
      (typeof params.operation === 'string' && CODE_EDIT_OPERATIONS.has(params.operation)
        ? null
        : 'wb_edit_code requires params.operation insert_after|insert_before|delete_lines|replace_lines');
    if (commonError) return commonError;

    if (params.operation === 'insert_after' || params.operation === 'insert_before') {
      if (requireString(params, 'lineId', 'wb_edit_code')) {
        return `wb_edit_code ${params.operation} requires params.lineId string`;
      }
      return requireString(params, 'content', 'wb_edit_code')
        ? `wb_edit_code ${params.operation} requires params.content string`
        : null;
    }

    if (!isStringArray(params.lineIds) || params.lineIds.length === 0) {
      return `wb_edit_code ${String(params.operation)} requires non-empty params.lineIds string array`;
    }

    return params.operation === 'replace_lines' && requireString(params, 'content', 'wb_edit_code')
      ? 'wb_edit_code replace_lines requires params.content string'
      : null;
  }

  return null;
}

function findCurrentSlideElement(
  body: StatelessChatRequest,
  elementId: string,
): { type?: string } | null {
  const currentScene = body.storeState.currentSceneId
    ? body.storeState.scenes.find((scene) => scene.id === body.storeState.currentSceneId)
    : undefined;
  if (currentScene?.content.type !== 'slide') return null;
  return currentScene.content.canvas.elements.find((element) => element.id === elementId) ?? null;
}

async function executeParsedAction(
  action: ParsedAction,
  body: StatelessChatRequest,
  toolsByName: Map<string, ChildActionTool>,
  warn: (warning: ActionWarning) => void,
): Promise<void> {
  const tool = toolsByName.get(action.actionName);
  if (!tool) {
    warn({
      actionName: action.actionName,
      reason: 'unknown_action',
      message: `Action "${action.actionName}" is not available for this agent/scene.`,
    });
    return;
  }
  const validationError = validateActionParams(action);
  if (validationError) {
    warn({
      actionName: action.actionName,
      reason: 'invalid_params',
      message: validationError,
    });
    return;
  }
  if (action.actionName === 'play_video') {
    const elementId = action.params.elementId;
    const slideElement =
      typeof elementId === 'string' ? findCurrentSlideElement(body, elementId) : null;
    if (!slideElement) {
      warn({
        actionName: action.actionName,
        reason: 'invalid_params',
        message: `play_video params.elementId "${String(elementId)}" was not found on the current slide`,
      });
      return;
    }
    if (slideElement.type !== 'video') {
      warn({
        actionName: action.actionName,
        reason: 'invalid_params',
        message: `play_video params.elementId "${elementId}" must reference a video element, got ${slideElement.type ?? 'unknown'}`,
      });
      return;
    }
  }
  const result = await tool.execute(action.actionId, action.params);
  if (
    (action.actionName === 'wb_edit_code' ||
      action.actionName === 'wb_delete' ||
      action.actionName.startsWith('wb_draw_')) &&
    result &&
    typeof result === 'object' &&
    'details' in result &&
    (result.details as { skipped?: boolean } | undefined)?.skipped
  ) {
    const details = result.details as { skipped?: boolean; reason?: string } | undefined;
    const reportSkippedTarget =
      action.actionName === 'wb_edit_code' ||
      (action.actionName === 'wb_delete' && details?.reason === 'whiteboard_element_not_found') ||
      (action.actionName.startsWith('wb_draw_') &&
        details?.reason === 'whiteboard_element_id_conflict');
    if (!reportSkippedTarget) return;
    const content = 'content' in result && Array.isArray(result.content) ? result.content : [];
    const message = content.find((item): item is { type: 'text'; text: string } =>
      Boolean(
        item &&
        typeof item === 'object' &&
        'type' in item &&
        item.type === 'text' &&
        'text' in item &&
        typeof item.text === 'string',
      ),
    )?.text;
    warn({
      actionName: action.actionName,
      reason: 'invalid_params',
      message: message ?? `${action.actionName} was skipped`,
    });
  }
}

async function processParseResult(opts: {
  result: ParseResult;
  messageId: string;
  send: SendEvent;
  toolsByName: Map<string, ChildActionTool>;
  body: StatelessChatRequest;
  appendText: (content: string) => void;
  warn: (warning: ActionWarning) => void;
}): Promise<void> {
  let emittedOrderedTextCount = 0;
  for (const entry of opts.result.ordered) {
    if (entry.type === 'text') {
      const content = opts.result.textChunks[entry.index];
      if (!content) continue;
      // Text here already came out of the structured parser (extracted from a
      // `"content"` field) or finalizeParser (which suppresses residue itself),
      // so it is trusted speech. Do NOT re-run the residue classifier over it —
      // legitimate speech that merely discusses JSON/brackets would be dropped.
      await emitTextDelta({
        content,
        messageId: opts.messageId,
        send: opts.send,
        appendText: opts.appendText,
      });
      emittedOrderedTextCount += 1;
      continue;
    }

    const action = opts.result.actions[entry.index];
    if (!action) continue;
    await executeParsedAction(action, opts.body, opts.toolsByName, opts.warn);
  }

  for (let i = emittedOrderedTextCount; i < opts.result.textChunks.length; i += 1) {
    const content = opts.result.textChunks[i];
    if (!content) continue;
    await emitTextDelta({
      content,
      messageId: opts.messageId,
      send: opts.send,
      appendText: opts.appendText,
    });
  }
}

export function buildCallAgentTool(opts: {
  body: StatelessChatRequest;
  agentConfigs: AgentConfig[];
  send: SendEvent;
  languageModel: LanguageModel;
  onAgentDone: (summary: AgentTurnSummary) => void;
  onActionDone: (record?: WhiteboardActionRecord) => void;
  thinkingConfig: ThinkingConfig;
  maxOutputTokens?: number;
  abortSignal: AbortSignal;
  maxAgentTurns: number;
  getAgentTurnCount: () => number;
  getAgentResponses: () => AgentTurnSummary[];
  getWhiteboardLedger: () => WhiteboardActionRecord[];
  maxActionsPerAgent: number;
  enableWhiteboardTools: boolean;
  isTeacherWrapUpUsed?: () => boolean;
  onTeacherWrapUpDone?: () => void;
  isUserCued?: () => boolean;
  isSessionClosed?: () => boolean;
}): AgentTool<typeof CallAgentParams> {
  // Loop-guard (model-agnostic): an empty/errored child turn used to bypass onAgentDone,
  // so getNormalTurnCount never advanced and the maxAgentTurns guard was defeated — a model
  // that returns empty completions (e.g. reasoning eats the output budget) could then trigger
  // unbounded call_agent retries. Track attempts + consecutive empties and stop deterministically.
  const MAX_CONSECUTIVE_EMPTY_TURNS = 2;
  const maxAgentAttempts = Math.max(opts.maxAgentTurns * 3, opts.maxAgentTurns + 3);
  let consecutiveEmptyTurns = 0;
  let totalAgentAttempts = 0;
  const whiteboardState = createPiWhiteboardRuntimeState(opts.body);
  return {
    name: 'call_agent',
    label: 'Call classroom agent',
    description: `Ask one classroom agent to produce the next in-class response. Use this before giving your final director decision. Hard limit: at most ${opts.maxAgentTurns} normal classroom agent turns in this server-side loop. A single final teacher wrap-up may use turnKind="wrap_up" before cue_user or close_session.`,
    parameters: CallAgentParams,
    executionMode: 'sequential',
    execute: async (_toolCallId: string, params: CallAgentParams, signal?: AbortSignal) => {
      if (totalAgentAttempts >= maxAgentAttempts) {
        return {
          content: [
            {
              type: 'text',
              text: `Reached the hard call_agent attempt cap (${maxAgentAttempts}). Finish with cue_user or close_session.`,
            },
          ],
          details: { skipped: true, reason: 'agent_attempt_cap', totalAgentAttempts },
        };
      }
      totalAgentAttempts += 1;

      if (opts.isSessionClosed?.()) {
        return {
          content: [
            {
              type: 'text',
              text: 'The classroom session is already closed. Finish the director loop without calling another agent.',
            },
          ],
          details: { skipped: true, reason: 'session_closed' },
        };
      }

      if (opts.isUserCued?.()) {
        return {
          content: [
            {
              type: 'text',
              text: 'The user has already been cued. Finish the director loop without calling another agent.',
            },
          ],
          details: { skipped: true, reason: 'user_already_cued' },
        };
      }

      const agent = opts.agentConfigs.find((candidate) => candidate.id === params.agentId);
      if (!agent) {
        const availableAgentIds = opts.agentConfigs.map((candidate) => candidate.id).join(', ');
        return {
          content: [
            {
              type: 'text',
              text: `Agent "${params.agentId}" is not available. Available agents: ${availableAgentIds || 'none'}.`,
            },
          ],
          details: {
            skipped: true,
            reason: 'invalid_agent_id',
            requestedAgentId: params.agentId,
            availableAgentIds: opts.agentConfigs.map((candidate) => candidate.id),
          },
        };
      }

      const isTeacherWrapUpTurn = params.turnKind === 'wrap_up';
      if (isTeacherWrapUpTurn && agent.role !== 'teacher') {
        return {
          content: [
            {
              type: 'text',
              text: 'Wrap-up turns are reserved for the teacher. Call a teacher with turnKind="wrap_up", or use a normal turn.',
            },
          ],
          details: {
            skipped: true,
            reason: 'wrap_up_requires_teacher',
            requestedAgentId: agent.id,
          },
        };
      }

      if (isTeacherWrapUpTurn && opts.isTeacherWrapUpUsed?.()) {
        return {
          content: [
            {
              type: 'text',
              text: 'The teacher wrap-up turn has already been used. Finish with cue_user or close_session.',
            },
          ],
          details: { skipped: true, reason: 'teacher_wrap_up_already_used' },
        };
      }

      if (opts.getAgentTurnCount() >= opts.maxAgentTurns && !isTeacherWrapUpTurn) {
        return {
          content: [
            {
              type: 'text',
              text: `Normal agent turn limit (${opts.maxAgentTurns}) reached. Finish the director loop, or call the teacher once with turnKind="wrap_up" for a final summary before cue_user or close_session.`,
            },
          ],
          details: {
            skipped: true,
            reason: 'agent_turn_limit',
            maxAgentTurns: opts.maxAgentTurns,
            wrapUpAvailable: !opts.isTeacherWrapUpUsed?.(),
          },
        };
      }

      if (consecutiveEmptyTurns >= MAX_CONSECUTIVE_EMPTY_TURNS) {
        return {
          content: [
            {
              type: 'text',
              text: `Classroom agents returned empty responses ${consecutiveEmptyTurns} times in a row. Stop calling agents and finish with cue_user or close_session.`,
            },
          ],
          details: { skipped: true, reason: 'consecutive_empty_turns', consecutiveEmptyTurns },
        };
      }

      const childAbort = new AbortController();
      const abortChild = () => childAbort.abort();
      opts.abortSignal.addEventListener('abort', abortChild, { once: true });
      signal?.addEventListener('abort', abortChild, { once: true });

      const messageId = nanoid();
      let text = '';
      let actionCount = 0;
      let sawStructuredOutput = false;
      const whiteboardActions: WhiteboardActionRecord[] = [];
      const actionWarnings: ActionWarning[] = [];
      const warn = (warning: ActionWarning) => {
        if (
          actionWarnings.some(
            (existing) =>
              existing.reason === warning.reason &&
              existing.actionName === warning.actionName &&
              existing.message === warning.message,
          )
        ) {
          return;
        }
        actionWarnings.push(warning);
      };

      await opts.send({
        type: 'agent_start',
        data: {
          messageId,
          agentId: agent.id,
          agentName: agent.name,
          agentAvatar: agent.avatar,
          agentColor: agent.color,
        },
      });

      const childTools = buildChildActionTools({
        body: opts.body,
        agent,
        messageId,
        send: opts.send,
        onActionDone: (record) => {
          actionCount += 1;
          if (record) whiteboardActions.push(record);
          opts.onActionDone(record);
        },
        maxActionsPerAgent: opts.maxActionsPerAgent,
        enableWhiteboardTools: opts.enableWhiteboardTools,
        turnKind: isTeacherWrapUpTurn ? 'wrap_up' : 'normal',
        whiteboardState,
      });
      const childToolsByName = new Map(childTools.map((tool) => [tool.name, tool]));

      const child = buildAgent({
        streamFn: createCallLlmStreamFn({
          languageModel: opts.languageModel,
          source: 'pi-chat-child',
          thinkingConfig: opts.thinkingConfig,
          maxOutputTokens: opts.maxOutputTokens,
          abortSignal: childAbort.signal,
        }),
        systemPrompt: buildChildPrompt(
          opts.body,
          agent,
          opts.getAgentResponses(),
          opts.getWhiteboardLedger(),
          childTools.map((tool) => tool.name),
        ),
        tools: [],
        allowedToolNames: new Set(),
        history: toHistoryMessages(opts.body.messages),
      });

      const parserState = createParserState();
      const unsubscribe = child.subscribe(async (event) => {
        const delta = getAssistantTextDelta(event);
        if (!delta) return;
        sawStructuredOutput = sawStructuredOutput || delta.includes('[');
        const result = parseStructuredChunk(delta, parserState);
        await processParseResult({
          result,
          messageId,
          send: opts.send,
          toolsByName: childToolsByName,
          body: opts.body,
          appendText: (content) => {
            text += content;
          },
          warn,
        });
      });

      let childErrored = false;
      try {
        await child.prompt(buildChildTurnPrompt(params.instruction, agent.role));
        await child.waitForIdle();
      } catch (error) {
        // Propagate genuine aborts; otherwise treat a failed child run as an empty turn
        // so it still records via onAgentDone below (counts toward the turn/retry budget)
        // instead of throwing out of execute and skipping the counter.
        if (opts.abortSignal.aborted || signal?.aborted) throw error;
        childErrored = true;
      } finally {
        unsubscribe();
        opts.abortSignal.removeEventListener('abort', abortChild);
        signal?.removeEventListener('abort', abortChild);
      }

      await processParseResult({
        result: finalizeParser(parserState),
        messageId,
        send: opts.send,
        toolsByName: childToolsByName,
        body: opts.body,
        appendText: (content) => {
          text += content;
        },
        warn,
      });

      const emittedText = text.trim();
      const fallbackText = sawStructuredOutput
        ? ''
        : sanitizeVisibleSpeech(extractLastAssistantText(child.state.messages)).trim();
      // Bug 2 guard: only count a turn as real teaching when it produced genuine
      // visible speech. Two distinct sources need different trust levels:
      //   - `emittedText`: already streamed through processParseResult, where every
      //     chunk was structurally filtered (isLikelyRawStructuredFallback). It is
      //     trusted speech — re-running the residue classifier over the whole
      //     accumulated string would misjudge a real turn that merely *discusses*
      //     JSON/code/brackets as empty, so we do NOT re-classify it.
      //   - `fallbackText`: the raw last-assistant message, which bypassed the
      //     parser entirely, so it still needs the structural backstop.
      // A turn with no trusted speech falls through to the empty-turn guard so the
      // director does not cue_user / switch agents on half a sentence. This does
      // NOT touch the drain lifecycle (waitForIdle -> finalizeParser -> agent_end);
      // it only classifies the already-drained result.
      const safeFallback =
        fallbackText && !isLikelyRawStructuredFallback(fallbackText) ? fallbackText : '';
      const finalText = emittedText || safeFallback;
      const hasVisibleText = finalText.length > 0;
      if (finalText && !emittedText) {
        await opts.send({ type: 'text_delta', data: { content: finalText, messageId } });
      }
      const isEmptyTurn = childErrored || (!hasVisibleText && actionCount === 0);
      consecutiveEmptyTurns = isEmptyTurn ? consecutiveEmptyTurns + 1 : 0;
      await opts.send({ type: 'agent_end', data: { messageId, agentId: agent.id } });
      opts.onAgentDone({
        agentId: agent.id,
        agentName: agent.name,
        contentPreview: finalText.slice(0, 300),
        actionCount,
        whiteboardActions,
        actionWarnings,
        turnKind: isTeacherWrapUpTurn ? 'wrap_up' : 'normal',
      });
      if (isTeacherWrapUpTurn) {
        opts.onTeacherWrapUpDone?.();
      }

      return {
        content: [
          {
            type: 'text',
            text: `${agent.name}: ${finalText || '(no visible response)'}`,
          },
        ],
        details: {
          agentId: agent.id,
          agentName: agent.name,
          text: finalText,
          actionWarnings,
          turnKind: isTeacherWrapUpTurn ? 'wrap_up' : 'normal',
        },
      };
    },
  };
}
