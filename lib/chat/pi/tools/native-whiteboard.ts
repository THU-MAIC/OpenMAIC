import type {
  CodeLine,
  PPTChartElement,
  PPTCodeElement,
  PPTElement,
  PPTLatexElement,
  PPTLineElement,
  PPTShapeElement,
  PPTTableElement,
  PPTTextElement,
} from '@openmaic/dsl';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { RuntimeAppendConflictError } from '@openmaic/storage';
import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { createHash } from 'node:crypto';
import katex from 'katex';

import type { AgentConfig } from '@/lib/orchestration/registry/types';
import {
  WhiteboardRuntimeSessionAmbiguousError,
  WhiteboardRuntimeSessionInvariantError,
  type WhiteboardRuntimeService,
} from '@/lib/whiteboard/runtime/store';
import {
  WHITEBOARD_RUNTIME_PAYLOAD_VERSION,
  WhiteboardRuntimeCodeLineIdConflictError,
  WhiteboardRuntimeCodeLineNotFoundError,
  WhiteboardRuntimeElementNotFoundError,
  WhiteboardRuntimeElementTypeMismatchError,
  WhiteboardRuntimeNoChangeError,
  type FoldedWhiteboardRuntimeState,
  type WhiteboardCodeLinesEdit,
  type WhiteboardRuntimeOperationV1,
  type WhiteboardRuntimePayloadV1,
} from '@/lib/whiteboard/runtime/types';
import { queryWhiteboardVisibility } from '../whiteboard-visibility';
import type { SendEvent } from '../types';

const EmptyParams = Type.Object({}, { additionalProperties: false });
const ExpectedLastSeq = Type.Unsafe<number | null>({
  type: ['integer', 'null'],
  minimum: 0,
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
const NativeWhiteboardDrawShapeParams = Type.Object(
  {
    expectedLastSeq: ExpectedLastSeq,
    shape: Type.Union([
      Type.Literal('rectangle'),
      Type.Literal('circle'),
      Type.Literal('triangle'),
    ]),
    x: Type.Number(),
    y: Type.Number(),
    width: Type.Number({ exclusiveMinimum: 0 }),
    height: Type.Number({ exclusiveMinimum: 0 }),
    fillColor: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
const NativeWhiteboardDrawChartParams = Type.Object(
  {
    expectedLastSeq: ExpectedLastSeq,
    chartType: Type.Union(
      [
        Type.Literal('bar'),
        Type.Literal('column'),
        Type.Literal('line'),
        Type.Literal('pie'),
        Type.Literal('ring'),
        Type.Literal('area'),
        Type.Literal('radar'),
        Type.Literal('scatter'),
      ],
      {
        description:
          'Use bar for vertical bars with category labels on the x-axis. Use column for horizontal bars with category labels on the y-axis.',
      },
    ),
    x: Type.Number(),
    y: Type.Number(),
    width: Type.Number({ exclusiveMinimum: 0 }),
    height: Type.Number({ exclusiveMinimum: 0 }),
    data: Type.Object(
      {
        labels: Type.Array(Type.String()),
        legends: Type.Array(Type.String()),
        series: Type.Array(Type.Array(Type.Number(), { minItems: 1 }), { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
    themeColors: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  },
  { additionalProperties: false },
);
const NativeWhiteboardDrawLatexParams = Type.Object(
  {
    expectedLastSeq: ExpectedLastSeq,
    latex: Type.String({ minLength: 1, pattern: '\\S' }),
    x: Type.Number(),
    y: Type.Number(),
    width: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    height: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    color: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
const NativeWhiteboardDrawTableParams = Type.Object(
  {
    expectedLastSeq: ExpectedLastSeq,
    x: Type.Number(),
    y: Type.Number(),
    width: Type.Number({ exclusiveMinimum: 0 }),
    height: Type.Number({ exclusiveMinimum: 0 }),
    data: Type.Array(Type.Array(Type.String(), { minItems: 1 }), { minItems: 1 }),
    outline: Type.Optional(
      Type.Object(
        {
          width: Type.Number({ minimum: 0 }),
          style: Type.Union([
            Type.Literal('solid'),
            Type.Literal('dashed'),
            Type.Literal('dotted'),
          ]),
          color: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    theme: Type.Optional(
      Type.Object({ color: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);
const LineMarker = Type.Union([Type.Literal(''), Type.Literal('arrow')]);
const NativeWhiteboardDrawLineParams = Type.Object(
  {
    expectedLastSeq: ExpectedLastSeq,
    startX: Type.Number(),
    startY: Type.Number(),
    endX: Type.Number(),
    endY: Type.Number(),
    color: Type.Optional(Type.String({ minLength: 1 })),
    width: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    style: Type.Optional(Type.Union([Type.Literal('solid'), Type.Literal('dashed')])),
    points: Type.Optional(Type.Array(LineMarker, { minItems: 2, maxItems: 2 })),
  },
  { additionalProperties: false },
);
const NativeWhiteboardDrawCodeParams = Type.Object(
  {
    expectedLastSeq: ExpectedLastSeq,
    language: Type.String({ minLength: 1, pattern: '\\S' }),
    code: Type.String({ minLength: 1, pattern: '\\S' }),
    x: Type.Number(),
    y: Type.Number(),
    width: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    height: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    fileName: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
const SafeWhiteboardIdentifier = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: '^[^\\x00-\\x1f\\x7f\\u2028\\u2029]+$',
});
// CodeLine.id is a plain string in the persisted DSL contract. Keep target IDs compatible with
// every readable legacy line while retaining strict host-owned IDs for newly written lines.
const ExistingWhiteboardCodeLineId = Type.String();
const NativeWhiteboardDeleteParams = Type.Object(
  {
    expectedLastSeq: ExpectedLastSeq,
    elementId: SafeWhiteboardIdentifier,
  },
  { additionalProperties: false },
);
const NativeWhiteboardClearParams = Type.Object(
  { expectedLastSeq: ExpectedLastSeq },
  { additionalProperties: false },
);
const NativeWhiteboardEditCodeParams = Type.Union(
  [
    Type.Object(
      {
        expectedLastSeq: ExpectedLastSeq,
        elementId: SafeWhiteboardIdentifier,
        operation: Type.Literal('insert_after'),
        lineId: ExistingWhiteboardCodeLineId,
        content: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        expectedLastSeq: ExpectedLastSeq,
        elementId: SafeWhiteboardIdentifier,
        operation: Type.Literal('insert_before'),
        lineId: ExistingWhiteboardCodeLineId,
        content: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        expectedLastSeq: ExpectedLastSeq,
        elementId: SafeWhiteboardIdentifier,
        operation: Type.Literal('delete_lines'),
        lineIds: Type.Array(ExistingWhiteboardCodeLineId, { minItems: 1, uniqueItems: true }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        expectedLastSeq: ExpectedLastSeq,
        elementId: SafeWhiteboardIdentifier,
        operation: Type.Literal('replace_lines'),
        lineIds: Type.Array(ExistingWhiteboardCodeLineId, { minItems: 1, uniqueItems: true }),
        content: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  ],
  { type: 'object' },
);

type EmptyParams = Static<typeof EmptyParams>;
type NativeWhiteboardDrawTextParams = Static<typeof NativeWhiteboardDrawTextParams>;
type NativeWhiteboardDrawShapeParams = Static<typeof NativeWhiteboardDrawShapeParams>;
type NativeWhiteboardDrawChartParams = Static<typeof NativeWhiteboardDrawChartParams>;
type NativeWhiteboardDrawLatexParams = Static<typeof NativeWhiteboardDrawLatexParams>;
type NativeWhiteboardDrawTableParams = Static<typeof NativeWhiteboardDrawTableParams>;
type NativeWhiteboardDrawLineParams = Static<typeof NativeWhiteboardDrawLineParams>;
type NativeWhiteboardDrawCodeParams = Static<typeof NativeWhiteboardDrawCodeParams>;
type NativeWhiteboardDeleteParams = Static<typeof NativeWhiteboardDeleteParams>;
type NativeWhiteboardClearParams = Static<typeof NativeWhiteboardClearParams>;
type NativeWhiteboardEditCodeParams = Static<typeof NativeWhiteboardEditCodeParams>;

const DRAW_TEXT_KEYS = new Set([
  'expectedLastSeq',
  'content',
  'x',
  'y',
  'width',
  'height',
  'fontSize',
  'color',
]);
const DRAW_SHAPE_KEYS = new Set([
  'expectedLastSeq',
  'shape',
  'x',
  'y',
  'width',
  'height',
  'fillColor',
]);
const DRAW_CHART_KEYS = new Set([
  'expectedLastSeq',
  'chartType',
  'x',
  'y',
  'width',
  'height',
  'data',
  'themeColors',
]);
const DRAW_LATEX_KEYS = new Set(['expectedLastSeq', 'latex', 'x', 'y', 'width', 'height', 'color']);
const DRAW_TABLE_KEYS = new Set([
  'expectedLastSeq',
  'x',
  'y',
  'width',
  'height',
  'data',
  'outline',
  'theme',
]);
const DRAW_LINE_KEYS = new Set([
  'expectedLastSeq',
  'startX',
  'startY',
  'endX',
  'endY',
  'color',
  'width',
  'style',
  'points',
]);
const DRAW_CODE_KEYS = new Set([
  'expectedLastSeq',
  'language',
  'code',
  'x',
  'y',
  'width',
  'height',
  'fileName',
]);
const DELETE_KEYS = new Set(['expectedLastSeq', 'elementId']);
const CLEAR_KEYS = new Set(['expectedLastSeq']);
const EDIT_CODE_KEYS = new Set([
  'expectedLastSeq',
  'elementId',
  'operation',
  'lineId',
  'lineIds',
  'content',
]);

const SHAPE_PATHS = {
  rectangle: 'M 0 0 L 1000 0 L 1000 1000 L 0 1000 Z',
  circle: 'M 500 0 A 500 500 0 1 1 499 0 Z',
  triangle: 'M 500 0 L 1000 1000 L 0 1000 Z',
} as const;

const DEFAULT_CHART_THEME = ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'];

export const NATIVE_WHITEBOARD_ACTION_NAMES = [
  'wb_open',
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_chart',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_draw_code',
  'wb_delete',
  'wb_clear',
  'wb_edit_code',
  'wb_close',
] as const;
const NATIVE_WHITEBOARD_ACTION_SET = new Set<string>(NATIVE_WHITEBOARD_ACTION_NAMES);
const NATIVE_WHITEBOARD_MUTATION_ACTION_SET = new Set<string>(
  NATIVE_WHITEBOARD_ACTION_NAMES.filter((action) => action !== 'wb_open' && action !== 'wb_close'),
);

export function hasNativeWhiteboardAction(actions: readonly string[]): boolean {
  return actions.some((action) => NATIVE_WHITEBOARD_ACTION_SET.has(action));
}

function hasNativeWhiteboardMutation(actions: readonly string[]): boolean {
  return actions.some((action) => NATIVE_WHITEBOARD_MUTATION_ACTION_SET.has(action));
}

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

type NativeWhiteboardToolOptions = {
  agent: AgentConfig;
  messageId: string;
  send: SendEvent;
  service: WhiteboardRuntimeService;
  stageId: string;
  learnerKey: string;
  requestStartManualVisibilityRevision: number;
};

type ElementMutationParams = { expectedLastSeq: number | null };
type MutationAffected = Record<string, unknown>;

async function settleWhiteboardMutation(
  opts: NativeWhiteboardToolOptions,
  expectedLastSeq: number | null,
  payload: WhiteboardRuntimePayloadV1,
  affectedFromCommittedState: (
    state: FoldedWhiteboardRuntimeState,
    replayed: boolean,
  ) => MutationAffected | null,
  signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
  const committedResult = async (
    committedSeq: number,
    state: FoldedWhiteboardRuntimeState,
    replayed: boolean,
  ): Promise<AgentToolResult<unknown>> => {
    if (signal?.aborted) throw abortReason(signal);
    const affected = affectedFromCommittedState(state, replayed);
    if (affected === null || state.lastSeq === null) {
      return failedResult(
        'WHITEBOARD_RUNTIME_POST_COMMIT_VERIFICATION_FAILED',
        'Whiteboard commit verification failed; the commit outcome may be uncertain. Read before any further mutation.',
      );
    }
    try {
      await opts.send({
        type: 'whiteboard',
        data: { kind: 'projection', stageId: opts.stageId, lastSeq: state.lastSeq },
      });
    } catch {
      // Projection is best-effort and cannot change durable settlement.
    }
    const result = {
      committedSeq,
      lastSeq: state.lastSeq,
      replayed,
      affected,
    };
    return textResult(JSON.stringify(result), { ...result, dispatchedAction: true });
  };

  try {
    const appended = await opts.service.append({
      stageId: opts.stageId,
      expectedLastSeq,
      payload,
    });
    return committedResult(appended.committedSeq, appended.state, appended.replayed);
  } catch (error) {
    if (isAbort(error, signal)) throw abortReason(signal);
    if (error instanceof RuntimeAppendConflictError) {
      return failedResult(
        'STALE_STATE',
        'Whiteboard state changed. Call wb_read, then copy nextMutation.expectedLastSeq exactly; any JSON number, including 0, must remain a number and must not become null.',
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
    if (error instanceof WhiteboardRuntimeElementNotFoundError) {
      return failedResult('WHITEBOARD_ELEMENT_NOT_FOUND', error.message, {
        elementId: error.elementId,
      });
    }
    if (error instanceof WhiteboardRuntimeElementTypeMismatchError) {
      return failedResult('WHITEBOARD_ELEMENT_TYPE_MISMATCH', error.message, {
        elementId: error.elementId,
        expectedType: error.expectedType,
        actualType: error.actualType,
      });
    }
    if (error instanceof WhiteboardRuntimeCodeLineNotFoundError) {
      return failedResult('WHITEBOARD_CODE_LINE_NOT_FOUND', error.message, {
        elementId: error.elementId,
        lineId: error.lineId,
      });
    }
    if (error instanceof WhiteboardRuntimeCodeLineIdConflictError) {
      return failedResult('WHITEBOARD_CODE_LINE_ID_CONFLICT', error.message, {
        elementId: error.elementId,
        lineId: error.lineId,
      });
    }
    if (error instanceof WhiteboardRuntimeNoChangeError) {
      const result = {
        noOp: true,
        lastSeq: error.state?.lastSeq ?? expectedLastSeq,
        affected: { cleared: false },
      };
      return textResult(JSON.stringify(result), result);
    }
    try {
      const reconciled = await opts.service.reconcileOperation(opts.stageId, payload);
      if (signal?.aborted) throw abortReason(signal);
      if (reconciled.status === 'exact') {
        return committedResult(reconciled.committedSeq, reconciled.state, true);
      }
    } catch (reconciliationError) {
      if (isAbort(reconciliationError, signal)) throw abortReason(signal);
    }
    return failedResult(
      'WHITEBOARD_MUTATION_UNCERTAIN',
      'Whiteboard mutation outcome could not be confirmed. Call wb_read before any further mutation.',
    );
  }
}

function runtimePayload(
  invocationDigest: string,
  operation: WhiteboardRuntimeOperationV1,
): WhiteboardRuntimePayloadV1 {
  return {
    payloadVersion: WHITEBOARD_RUNTIME_PAYLOAD_VERSION,
    operationId: `native-wb-operation:${invocationDigest}`,
    operation,
  };
}

function codeLines(
  content: string,
  invocationDigest: string,
  reusableLineIds: readonly string[] = [],
): CodeLine[] {
  return content.split('\n').map((lineContent, index) => {
    const reusableLineId = reusableLineIds[index];
    const canReuse =
      reusableLineId !== undefined &&
      reusableLineId.length > 0 &&
      reusableLineId.length <= 512 &&
      !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(reusableLineId);
    return {
      id: canReuse ? reusableLineId : `native-wb-code-line:${invocationDigest}:${index}`,
      content: lineContent,
    };
  });
}

function codeEditAffected(elementId: string, edit: WhiteboardCodeLinesEdit): MutationAffected {
  const targetLineIds = 'lineId' in edit ? [edit.lineId] : edit.lineIds;
  const resultLineIds = 'lines' in edit ? edit.lines.map((line) => line.id) : [];
  return {
    elementId,
    operation: edit.kind,
    targetLineIds,
    resultLineIds,
  };
}

function elementMutationTool<TParams extends ElementMutationParams>(
  opts: NativeWhiteboardToolOptions,
  config: {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    prepare: (args: unknown) => TParams;
    createElement: (params: TParams, invocationDigest: string) => PPTElement;
  },
): AgentTool {
  return {
    name: config.name,
    label: config.label,
    description: `${config.description} For a user-visible drawing request, call wb_open before this tool even if Browser visibility is unknown. Drawing remains allowed when visibility is closed, and this mutation tool never changes visibility itself.`,
    parameters: config.parameters,
    executionMode: 'sequential',
    prepareArguments: config.prepare,
    execute: async (toolCallId, rawParams, signal) => {
      if (signal?.aborted) throw abortReason(signal);
      const params = rawParams as TParams;
      const invocationDigest = logicalInvocationDigest(opts.messageId, toolCallId);
      let element: PPTElement;
      try {
        element = config.createElement(params, invocationDigest);
      } catch {
        return failedResult(
          'WHITEBOARD_ELEMENT_BUILD_FAILED',
          'Whiteboard element construction failed; no mutation was accepted.',
        );
      }
      const payload = runtimePayload(invocationDigest, { kind: 'element_added', element });
      return settleWhiteboardMutation(
        opts,
        params.expectedLastSeq,
        payload,
        (state, replayed) => {
          if (replayed) return { element };
          const affected = state.whiteboard?.elements.find(
            (candidate) => candidate.id === element.id && candidate.type === element.type,
          );
          return affected ? { element: affected } : null;
        },
        signal,
      );
    },
  };
}

function isNonEmptyRectangularMatrix(data: readonly (readonly string[])[]): boolean {
  const columns = data[0]?.length ?? 0;
  return columns > 0 && data.every((row) => row.length === columns);
}

export function buildNativeWhiteboardTools(opts: NativeWhiteboardToolOptions): AgentTool[] {
  const allowed = new Set(opts.agent.allowedActions);
  if (!hasNativeWhiteboardAction(opts.agent.allowedActions)) return [];
  const hasMutation = hasNativeWhiteboardMutation(opts.agent.allowedActions);

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
            nextMutation: {
              expectedLastSeq: state.lastSeq,
              expectedLastSeqInstruction:
                state.lastSeq === null
                  ? 'Set expectedLastSeq to JSON null exactly.'
                  : `Set expectedLastSeq to the JSON number ${state.lastSeq} exactly; do not use null.`,
              drawingAllowedWhenVisibilityClosed: true,
            },
            durable: durableReadResult(state),
            presentation: { visibility },
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
        ? 'Request a best-effort UI-only whiteboard open effect. This does not create or mutate durable whiteboard state and never completes a drawing request. If drawing was requested, continue in the same Child with wb_read and the required wb_draw_* tool before confirming.'
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
        name === 'wb_open'
          ? 'Whiteboard open was accepted for best-effort dispatch. This did not draw or mutate any element. If drawing was requested, continue in the same Child with wb_read and the required wb_draw_* tool before confirming.'
          : 'Whiteboard close was accepted for best-effort dispatch.',
        { actionName: name, dispatchedAction: true },
      );
    },
  });

  if (hasMutation || allowed.has('wb_open')) tools.push(effectTool('wb_open'));

  if (allowed.has('wb_draw_text')) {
    tools.push(
      elementMutationTool<NativeWhiteboardDrawTextParams>(opts, {
        name: 'wb_draw_text',
        label: 'Draw whiteboard text',
        description:
          'Append one text element to the authoritative learner whiteboard using nextMutation.expectedLastSeq from the latest wb_read result.',
        parameters: NativeWhiteboardDrawTextParams,
        prepare: (args) =>
          strictArguments<NativeWhiteboardDrawTextParams>(
            NativeWhiteboardDrawTextParams,
            args,
            DRAW_TEXT_KEYS,
          ),
        createElement: (params, invocationDigest): PPTTextElement => ({
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
        }),
      }),
    );
  }

  if (allowed.has('wb_draw_shape')) {
    tools.push(
      elementMutationTool<NativeWhiteboardDrawShapeParams>(opts, {
        name: 'wb_draw_shape',
        label: 'Draw whiteboard shape',
        description:
          'Append one rectangle, circle, or triangle to the authoritative learner whiteboard using nextMutation.expectedLastSeq from the latest wb_read result.',
        parameters: NativeWhiteboardDrawShapeParams,
        prepare: (args) =>
          strictArguments<NativeWhiteboardDrawShapeParams>(
            NativeWhiteboardDrawShapeParams,
            args,
            DRAW_SHAPE_KEYS,
          ),
        createElement: (params, invocationDigest): PPTShapeElement => ({
          id: `native-wb-element:${invocationDigest}`,
          type: 'shape',
          viewBox: [1000, 1000],
          path: SHAPE_PATHS[params.shape],
          left: params.x,
          top: params.y,
          width: params.width,
          height: params.height,
          rotate: 0,
          fill: params.fillColor ?? '#5b9bd5',
          fixedRatio: false,
        }),
      }),
    );
  }

  if (allowed.has('wb_draw_chart')) {
    tools.push(
      elementMutationTool<NativeWhiteboardDrawChartParams>(opts, {
        name: 'wb_draw_chart',
        label: 'Draw whiteboard chart',
        description:
          'Append one chart to the authoritative learner whiteboard using nextMutation.expectedLastSeq from the latest wb_read result.',
        parameters: NativeWhiteboardDrawChartParams,
        prepare: (args) => {
          const params = strictArguments<NativeWhiteboardDrawChartParams>(
            NativeWhiteboardDrawChartParams,
            args,
            DRAW_CHART_KEYS,
          );
          if (params.chartType === 'radar' && params.data.labels.length === 0) {
            throw new Error('Native whiteboard arguments must match the strict schema.');
          }
          return params;
        },
        createElement: (params, invocationDigest): PPTChartElement => ({
          id: `native-wb-element:${invocationDigest}`,
          type: 'chart',
          left: params.x,
          top: params.y,
          width: params.width,
          height: params.height,
          rotate: 0,
          chartType: params.chartType,
          data: params.data,
          themeColors: params.themeColors ?? DEFAULT_CHART_THEME,
        }),
      }),
    );
  }

  if (allowed.has('wb_draw_latex')) {
    tools.push(
      elementMutationTool<NativeWhiteboardDrawLatexParams>(opts, {
        name: 'wb_draw_latex',
        label: 'Draw whiteboard LaTeX',
        description:
          'Append one rendered LaTeX formula to the authoritative learner whiteboard using nextMutation.expectedLastSeq from the latest wb_read result.',
        parameters: NativeWhiteboardDrawLatexParams,
        prepare: (args) =>
          strictArguments<NativeWhiteboardDrawLatexParams>(
            NativeWhiteboardDrawLatexParams,
            args,
            DRAW_LATEX_KEYS,
          ),
        createElement: (params, invocationDigest): PPTLatexElement => ({
          id: `native-wb-element:${invocationDigest}`,
          type: 'latex',
          left: params.x,
          top: params.y,
          width: params.width ?? 400,
          height: params.height ?? 80,
          rotate: 0,
          latex: params.latex,
          html: katex.renderToString(params.latex, {
            throwOnError: false,
            displayMode: true,
            output: 'html',
          }),
          color: params.color ?? '#000000',
          fixedRatio: true,
        }),
      }),
    );
  }

  if (allowed.has('wb_draw_table')) {
    tools.push(
      elementMutationTool<NativeWhiteboardDrawTableParams>(opts, {
        name: 'wb_draw_table',
        label: 'Draw whiteboard table',
        description:
          'Append one non-empty rectangular table to the authoritative learner whiteboard using nextMutation.expectedLastSeq from the latest wb_read result.',
        parameters: NativeWhiteboardDrawTableParams,
        prepare: (args) => {
          const params = strictArguments<NativeWhiteboardDrawTableParams>(
            NativeWhiteboardDrawTableParams,
            args,
            DRAW_TABLE_KEYS,
          );
          if (!isNonEmptyRectangularMatrix(params.data)) {
            throw new Error('Native whiteboard arguments must match the strict schema.');
          }
          return params;
        },
        createElement: (params, invocationDigest): PPTTableElement => {
          const columnCount = params.data[0]!.length;
          return {
            id: `native-wb-element:${invocationDigest}`,
            type: 'table',
            left: params.x,
            top: params.y,
            width: params.width,
            height: params.height,
            rotate: 0,
            colWidths: Array.from({ length: columnCount }, () => 1 / columnCount),
            cellMinHeight: 36,
            data: params.data.map((row, rowIndex) =>
              row.map((cell, columnIndex) => ({
                id: `native-wb-table-cell:${invocationDigest}:${rowIndex}:${columnIndex}`,
                colspan: 1,
                rowspan: 1,
                text: escapeText(cell),
              })),
            ),
            outline: params.outline ?? { width: 2, style: 'solid', color: '#eeece1' },
            ...(params.theme
              ? {
                  theme: {
                    color: params.theme.color,
                    rowHeader: true,
                    rowFooter: false,
                    colHeader: false,
                    colFooter: false,
                  },
                }
              : {}),
          };
        },
      }),
    );
  }

  if (allowed.has('wb_draw_line')) {
    tools.push(
      elementMutationTool<NativeWhiteboardDrawLineParams>(opts, {
        name: 'wb_draw_line',
        label: 'Draw whiteboard line',
        description:
          'Append one line or arrow to the authoritative learner whiteboard using nextMutation.expectedLastSeq from the latest wb_read result.',
        parameters: NativeWhiteboardDrawLineParams,
        prepare: (args) => {
          const params = strictArguments<NativeWhiteboardDrawLineParams>(
            NativeWhiteboardDrawLineParams,
            args,
            DRAW_LINE_KEYS,
          );
          if (params.startX === params.endX && params.startY === params.endY) {
            throw new Error('wb_draw_line requires distinct start and end points');
          }
          return params;
        },
        createElement: (params, invocationDigest): PPTLineElement => {
          const left = Math.min(params.startX, params.endX);
          const top = Math.min(params.startY, params.endY);
          return {
            id: `native-wb-element:${invocationDigest}`,
            type: 'line',
            left,
            top,
            width: params.width ?? 2,
            start: [params.startX - left, params.startY - top],
            end: [params.endX - left, params.endY - top],
            style: params.style ?? 'solid',
            color: params.color ?? '#333333',
            points: params.points ? [params.points[0]!, params.points[1]!] : ['', ''],
          };
        },
      }),
    );
  }

  if (allowed.has('wb_draw_code')) {
    tools.push(
      elementMutationTool<NativeWhiteboardDrawCodeParams>(opts, {
        name: 'wb_draw_code',
        label: 'Draw whiteboard code',
        description:
          'Append one syntax-highlighted code block to the authoritative learner whiteboard using nextMutation.expectedLastSeq from the latest wb_read result.',
        parameters: NativeWhiteboardDrawCodeParams,
        prepare: (args) =>
          strictArguments<NativeWhiteboardDrawCodeParams>(
            NativeWhiteboardDrawCodeParams,
            args,
            DRAW_CODE_KEYS,
          ),
        createElement: (params, invocationDigest): PPTCodeElement => ({
          id: `native-wb-element:${invocationDigest}`,
          type: 'code',
          language: params.language,
          lines: params.code.split('\n').map((content, index) => ({
            id: `native-wb-code-line:${invocationDigest}:${index}`,
            content,
          })),
          ...(params.fileName ? { fileName: params.fileName } : {}),
          showLineNumbers: true,
          fontSize: 14,
          left: params.x,
          top: params.y,
          width: params.width ?? 500,
          height: params.height ?? 300,
          rotate: 0,
        }),
      }),
    );
  }

  if (allowed.has('wb_delete')) {
    tools.push({
      name: 'wb_delete',
      label: 'Delete whiteboard element',
      description:
        'Delete exactly one element selected by elementId from the latest wb_read result. Copy nextMutation.expectedLastSeq exactly. This durable mutation works while the whiteboard is closed and never changes visibility.',
      parameters: NativeWhiteboardDeleteParams,
      executionMode: 'sequential',
      prepareArguments: (args) =>
        strictArguments<NativeWhiteboardDeleteParams>(
          NativeWhiteboardDeleteParams,
          args,
          DELETE_KEYS,
        ),
      execute: async (toolCallId, rawParams, signal) => {
        if (signal?.aborted) throw abortReason(signal);
        const params = rawParams as NativeWhiteboardDeleteParams;
        const invocationDigest = logicalInvocationDigest(opts.messageId, toolCallId);
        return settleWhiteboardMutation(
          opts,
          params.expectedLastSeq,
          runtimePayload(invocationDigest, {
            kind: 'element_deleted',
            elementId: params.elementId,
          }),
          () => ({ elementId: params.elementId }),
          signal,
        );
      },
    });
  }

  if (allowed.has('wb_clear')) {
    tools.push({
      name: 'wb_clear',
      label: 'Clear whiteboard elements',
      description:
        'Remove all elements while preserving the authoritative whiteboard and its metadata. Copy nextMutation.expectedLastSeq exactly. A missing or already-empty board is a successful no-op with no projection, and this tool never changes visibility.',
      parameters: NativeWhiteboardClearParams,
      executionMode: 'sequential',
      prepareArguments: (args) =>
        strictArguments<NativeWhiteboardClearParams>(NativeWhiteboardClearParams, args, CLEAR_KEYS),
      execute: async (toolCallId, rawParams, signal) => {
        if (signal?.aborted) throw abortReason(signal);
        const params = rawParams as NativeWhiteboardClearParams;
        const invocationDigest = logicalInvocationDigest(opts.messageId, toolCallId);
        return settleWhiteboardMutation(
          opts,
          params.expectedLastSeq,
          runtimePayload(invocationDigest, { kind: 'elements_cleared' }),
          () => ({ cleared: true }),
          signal,
        );
      },
    });
  }

  if (allowed.has('wb_edit_code')) {
    tools.push({
      name: 'wb_edit_code',
      label: 'Edit whiteboard code lines',
      description:
        'Insert, delete, or replace lines in one code element using element and line IDs from the latest wb_read result. Copy nextMutation.expectedLastSeq exactly. Content may contain blank lines. This durable mutation works while closed and never changes visibility.',
      parameters: NativeWhiteboardEditCodeParams,
      executionMode: 'sequential',
      prepareArguments: (args) =>
        strictArguments<NativeWhiteboardEditCodeParams>(
          NativeWhiteboardEditCodeParams,
          args,
          EDIT_CODE_KEYS,
        ),
      execute: async (toolCallId, rawParams, signal) => {
        if (signal?.aborted) throw abortReason(signal);
        const params = rawParams as NativeWhiteboardEditCodeParams;
        const invocationDigest = logicalInvocationDigest(opts.messageId, toolCallId);
        let edit: WhiteboardCodeLinesEdit;
        if (params.operation === 'insert_after' || params.operation === 'insert_before') {
          edit = {
            kind: params.operation,
            lineId: params.lineId,
            lines: codeLines(params.content, invocationDigest),
          };
        } else if (params.operation === 'delete_lines') {
          edit = { kind: params.operation, lineIds: params.lineIds };
        } else {
          edit = {
            kind: params.operation,
            lineIds: params.lineIds,
            lines: codeLines(params.content, invocationDigest, params.lineIds),
          };
        }
        return settleWhiteboardMutation(
          opts,
          params.expectedLastSeq,
          runtimePayload(invocationDigest, {
            kind: 'code_lines_edited',
            elementId: params.elementId,
            edit,
          }),
          () => codeEditAffected(params.elementId, edit),
          signal,
        );
      },
    });
  }

  if (hasMutation || allowed.has('wb_close')) tools.push(effectTool('wb_close'));
  return tools;
}
