import type { PPTTextElement } from '@openmaic/dsl';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { RuntimeAppendConflictError } from '@openmaic/storage';
import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { createHash } from 'node:crypto';

import type { AgentConfig } from '@/lib/orchestration/registry/types';
import {
  WhiteboardRuntimeSessionAmbiguousError,
  WhiteboardRuntimeSessionInvariantError,
  type WhiteboardRuntimeService,
} from '@/lib/whiteboard/runtime/store';
import {
  WHITEBOARD_RUNTIME_PAYLOAD_VERSION,
  type WhiteboardRuntimePayloadV1,
} from '@/lib/whiteboard/runtime/types';
import { queryWhiteboardVisibility } from '../whiteboard-visibility';
import type { SendEvent } from '../types';

const EmptyParams = Type.Object({}, { additionalProperties: false });
const ExpectedLastSeq = Type.Union([Type.Null(), Type.Integer({ minimum: 0 })], {
  description:
    'Copy nextMutation.expectedLastSeq exactly from the latest wb_read result. Use null only when that value is null.',
});
const NativeWhiteboardDrawTextParams = Type.Object(
  {
    expectedLastSeq: ExpectedLastSeq,
    content: Type.String({ minLength: 1, pattern: '\\S' }),
    x: Type.Number(),
    y: Type.Number(),
    width: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    height: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    fontSize: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    color: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

type EmptyParams = Static<typeof EmptyParams>;
type NativeWhiteboardDrawTextParams = Static<typeof NativeWhiteboardDrawTextParams>;

const DRAW_KEYS = new Set([
  'expectedLastSeq',
  'content',
  'x',
  'y',
  'width',
  'height',
  'fontSize',
  'color',
]);

function strictArguments<T>(schema: TSchema, args: unknown, keys: ReadonlySet<string>): T {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('Native whiteboard arguments must match the strict schema.');
  }
  try {
    const prototype = Object.getPrototypeOf(args);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      !Reflect.ownKeys(args).every((key) => typeof key === 'string' && keys.has(key)) ||
      !Value.Check(schema, args)
    ) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error('Native whiteboard arguments must match the strict schema.');
  }
  return args as T;
}

function escapeText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function paragraphHtml(content: string, fontSize: number): string {
  return `<p style="font-size: ${fontSize}px;">${escapeText(content).replace(/\r\n|\r|\n/gu, '<br>')}</p>`;
}

function logicalInvocationDigest(messageId: string, toolCallId: string): string {
  return createHash('sha256').update(messageId).update('\0').update(toolCallId).digest('hex');
}

function textResult(text: string, details?: unknown, isError = false): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text }],
    details: details ?? {},
    ...(isError ? { isError: true } : {}),
  };
}

function failedResult(code: string, text: string, details?: Record<string, unknown>) {
  return textResult(text, { code, ...details }, true);
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException(
        typeof signal?.reason === 'string' ? signal.reason : 'Operation aborted',
        'AbortError',
      );
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(
    signal?.aborted ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError'),
  );
}

function durableReadResult(state: Awaited<ReturnType<WhiteboardRuntimeService['read']>>) {
  const whiteboard = state.whiteboard;
  return {
    exists: state.lastSeq !== null,
    lastSeq: state.lastSeq,
    viewportSize: whiteboard?.viewportSize ?? 1000,
    viewportRatio: whiteboard?.viewportRatio ?? 0.5625,
    elements: whiteboard?.elements ?? [],
  };
}

export function buildNativeWhiteboardTools(opts: {
  agent: AgentConfig;
  messageId: string;
  send: SendEvent;
  service: WhiteboardRuntimeService;
  stageId: string;
  learnerKey: string;
  requestStartManualVisibilityRevision: number;
}): AgentTool[] {
  const allowed = new Set(opts.agent.allowedActions);
  const actionNames = ['wb_open', 'wb_draw_text', 'wb_close'].filter((name) => allowed.has(name));
  if (actionNames.length === 0) return [];

  const tools: AgentTool[] = [
    {
      name: 'wb_read',
      label: 'Read whiteboard',
      description:
        'Read the authoritative learner whiteboard and current best-effort Browser visibility. Copy nextMutation.expectedLastSeq exactly into the next mutation. Closed visibility never blocks durable drawing and does not require wb_open first.',
      parameters: EmptyParams,
      executionMode: 'sequential',
      prepareArguments: (args) => strictArguments<EmptyParams>(EmptyParams, args, new Set()),
      execute: async (_toolCallId, _params, signal) => {
        try {
          const state = await opts.service.read(opts.stageId);
          const visibility = await queryWhiteboardVisibility({
            stageId: opts.stageId,
            learnerKey: opts.learnerKey,
            signal,
            timeoutMs: 1_500,
            dispatch: (queryId) =>
              opts.send({
                type: 'whiteboard',
                data: { kind: 'visibility_query', queryId, stageId: opts.stageId },
              }),
          });
          const result = {
            durable: durableReadResult(state),
            presentation: { visibility },
            nextMutation: {
              expectedLastSeq: state.lastSeq,
              drawingAllowedWhenVisibilityClosed: true,
            },
          };
          return textResult(JSON.stringify(result), result);
        } catch (error) {
          if (isAbort(error, signal)) throw abortReason(signal!);
          return failedResult('WHITEBOARD_READ_FAILED', 'Whiteboard read failed.');
        }
      },
    },
  ];

  const effectTool = (name: 'wb_open' | 'wb_close'): AgentTool<typeof EmptyParams> => ({
    name,
    label: name === 'wb_open' ? 'Open whiteboard' : 'Close whiteboard',
    description:
      name === 'wb_open'
        ? 'Request a best-effort UI-only whiteboard open effect. This does not create or mutate durable whiteboard state.'
        : 'Request a best-effort UI-only whiteboard close effect. Do not close merely because drawing is complete.',
    parameters: EmptyParams,
    executionMode: 'sequential',
    prepareArguments: (args) => strictArguments<EmptyParams>(EmptyParams, args, new Set()),
    execute: async (_toolCallId, _params, signal) => {
      if (signal?.aborted) throw abortReason(signal);
      await opts.send({
        type: 'whiteboard',
        data: {
          kind: name === 'wb_open' ? 'open' : 'close',
          stageId: opts.stageId,
          manualVisibilityRevision: opts.requestStartManualVisibilityRevision,
        },
      });
      if (signal?.aborted) throw abortReason(signal);
      return textResult(
        `Whiteboard ${name === 'wb_open' ? 'open' : 'close'} was accepted for best-effort dispatch.`,
        { actionName: name, dispatchedAction: true },
      );
    },
  });

  if (allowed.has('wb_open')) tools.push(effectTool('wb_open'));

  if (allowed.has('wb_draw_text')) {
    const drawTool: AgentTool<typeof NativeWhiteboardDrawTextParams> = {
      name: 'wb_draw_text',
      label: 'Draw whiteboard text',
      description:
        'Append one text element to the authoritative learner whiteboard using nextMutation.expectedLastSeq from the latest wb_read result. Drawing is allowed whether Browser visibility is open, closed, or unknown; this tool never changes visibility.',
      parameters: NativeWhiteboardDrawTextParams,
      executionMode: 'sequential',
      prepareArguments: (args) =>
        strictArguments<NativeWhiteboardDrawTextParams>(
          NativeWhiteboardDrawTextParams,
          args,
          DRAW_KEYS,
        ),
      execute: async (toolCallId, params, signal) => {
        if (signal?.aborted) throw abortReason(signal);
        const invocationDigest = logicalInvocationDigest(opts.messageId, toolCallId);
        const operationId = `native-wb-operation:${invocationDigest}`;
        const element: PPTTextElement = {
          id: `native-wb-element:${invocationDigest}`,
          type: 'text',
          left: params.x,
          top: params.y,
          width: params.width ?? 400,
          height: params.height ?? 100,
          rotate: 0,
          content: paragraphHtml(params.content, params.fontSize ?? 18),
          defaultFontName: 'Microsoft YaHei',
          defaultColor: params.color ?? '#333333',
        };
        const payload: WhiteboardRuntimePayloadV1 = {
          payloadVersion: WHITEBOARD_RUNTIME_PAYLOAD_VERSION,
          operationId,
          operation: { kind: 'element_added', element },
        };

        const committedResult = async (
          committedSeq: number,
          state: Awaited<ReturnType<WhiteboardRuntimeService['read']>>,
          replayed: boolean,
        ): Promise<AgentToolResult<unknown>> => {
          if (signal?.aborted) throw abortReason(signal);
          const affected = state.whiteboard?.elements.find(
            (candidate) => candidate.id === element.id && candidate.type === 'text',
          ) as PPTTextElement | undefined;
          if (!affected || state.lastSeq === null) {
            return failedResult(
              'WHITEBOARD_RUNTIME_POST_COMMIT_VERIFICATION_FAILED',
              'Whiteboard commit verification failed; the commit outcome may be uncertain. Read before any further mutation.',
            );
          }
          try {
            await opts.send({
              type: 'whiteboard',
              data: {
                kind: 'projection',
                stageId: opts.stageId,
                lastSeq: state.lastSeq,
              },
            });
          } catch {
            // Projection is best-effort and cannot change durable settlement.
          }
          const result = {
            committedSeq,
            lastSeq: state.lastSeq,
            replayed,
            affected: { element: affected },
          };
          return textResult(JSON.stringify(result), { ...result, dispatchedAction: true });
        };

        try {
          const appended = await opts.service.append({
            stageId: opts.stageId,
            expectedLastSeq: params.expectedLastSeq,
            payload,
          });
          return committedResult(appended.committedSeq, appended.state, appended.replayed);
        } catch (error) {
          if (isAbort(error, signal)) throw abortReason(signal!);
          if (error instanceof RuntimeAppendConflictError) {
            return failedResult(
              'STALE_STATE',
              'Whiteboard state changed. Call wb_read, then retry or adjust using the new lastSeq.',
              { actualLastSeq: error.actualLastSeq },
            );
          }
          if (error instanceof WhiteboardRuntimeSessionAmbiguousError) {
            return failedResult(
              'WHITEBOARD_RUNTIME_SESSION_AMBIGUOUS',
              'Whiteboard session state is ambiguous; no new mutation was accepted.',
            );
          }
          if (error instanceof WhiteboardRuntimeSessionInvariantError) {
            return failedResult(
              'WHITEBOARD_RUNTIME_SESSION_INVARIANT',
              'Whiteboard session state violates the runtime invariant.',
            );
          }
          try {
            const reconciled = await opts.service.reconcileOperation(opts.stageId, payload);
            if (signal?.aborted) throw abortReason(signal);
            if (reconciled.status === 'exact') {
              return committedResult(reconciled.committedSeq, reconciled.state, true);
            }
          } catch (reconciliationError) {
            if (isAbort(reconciliationError, signal)) throw abortReason(signal!);
          }
          return failedResult(
            'WHITEBOARD_MUTATION_FAILED',
            'Whiteboard mutation outcome could not be confirmed. Read before any further mutation.',
          );
        }
      },
    };
    tools.push(drawTool);
  }

  if (allowed.has('wb_close')) tools.push(effectTool('wb_close'));
  return tools;
}
