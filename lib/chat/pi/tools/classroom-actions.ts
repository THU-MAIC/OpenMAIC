import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import { nanoid } from 'nanoid';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { getEffectiveActions } from '@/lib/orchestration/tool-schemas';
import type { WhiteboardActionRecord } from '@/lib/orchestration/types';
import type { StatelessChatRequest } from '@/lib/types/chat';
import type { SendEvent } from '../types';

const SpotlightParams = Type.Object({
  elementId: Type.String(),
  dimOpacity: Type.Optional(Type.Number()),
});
type SpotlightParams = Static<typeof SpotlightParams>;

const LaserParams = Type.Object({
  elementId: Type.String(),
  color: Type.Optional(Type.String()),
});
type LaserParams = Static<typeof LaserParams>;

const PlayVideoParams = Type.Object({
  elementId: Type.String(),
});
type PlayVideoParams = Static<typeof PlayVideoParams>;

const EmptyParams = Type.Object({});
type EmptyParams = Static<typeof EmptyParams>;

const WbDeleteParams = Type.Object({
  elementId: Type.String(),
});
type WbDeleteParams = Static<typeof WbDeleteParams>;

const WbDrawTextParams = Type.Object({
  content: Type.String(),
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
  fontSize: Type.Optional(Type.Number()),
  color: Type.Optional(Type.String()),
  elementId: Type.Optional(Type.String()),
});
type WbDrawTextParams = Static<typeof WbDrawTextParams>;

const WbDrawShapeParams = Type.Object({
  shape: Type.Union([Type.Literal('rectangle'), Type.Literal('circle'), Type.Literal('triangle')]),
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
  fillColor: Type.Optional(Type.String()),
  elementId: Type.Optional(Type.String()),
});
type WbDrawShapeParams = Static<typeof WbDrawShapeParams>;

const WbDrawChartParams = Type.Object({
  chartType: Type.Union([
    Type.Literal('bar'),
    Type.Literal('column'),
    Type.Literal('line'),
    Type.Literal('pie'),
    Type.Literal('ring'),
    Type.Literal('area'),
    Type.Literal('radar'),
    Type.Literal('scatter'),
  ]),
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
  data: Type.Object({
    labels: Type.Array(Type.String()),
    legends: Type.Array(Type.String()),
    series: Type.Array(Type.Array(Type.Number())),
  }),
  themeColors: Type.Optional(Type.Array(Type.String())),
  elementId: Type.Optional(Type.String()),
});
type WbDrawChartParams = Static<typeof WbDrawChartParams>;

const WbDrawLatexParams = Type.Object({
  latex: Type.String(),
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
  color: Type.Optional(Type.String()),
  elementId: Type.Optional(Type.String()),
});
type WbDrawLatexParams = Static<typeof WbDrawLatexParams>;

const WbDrawTableParams = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
  data: Type.Array(Type.Array(Type.String(), { minItems: 1 }), { minItems: 1 }),
  outline: Type.Optional(
    Type.Object({
      width: Type.Number(),
      style: Type.String(),
      color: Type.String(),
    }),
  ),
  theme: Type.Optional(
    Type.Object({
      color: Type.String(),
    }),
  ),
  elementId: Type.Optional(Type.String()),
});
type WbDrawTableParams = Static<typeof WbDrawTableParams>;

const WbDrawLineParams = Type.Object({
  startX: Type.Number(),
  startY: Type.Number(),
  endX: Type.Number(),
  endY: Type.Number(),
  color: Type.Optional(Type.String()),
  width: Type.Optional(Type.Number()),
  style: Type.Optional(Type.Union([Type.Literal('solid'), Type.Literal('dashed')])),
  points: Type.Optional(
    Type.Union([
      Type.Tuple([Type.Literal(''), Type.Literal('arrow')]),
      Type.Tuple([Type.Literal('arrow'), Type.Literal('')]),
      Type.Tuple([Type.Literal('arrow'), Type.Literal('arrow')]),
      Type.Tuple([Type.Literal(''), Type.Literal('')]),
    ]),
  ),
  elementId: Type.Optional(Type.String()),
});
type WbDrawLineParams = Static<typeof WbDrawLineParams>;

const WbDrawCodeParams = Type.Object({
  language: Type.String(),
  code: Type.String(),
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
  fileName: Type.Optional(Type.String()),
  elementId: Type.Optional(Type.String()),
});
type WbDrawCodeParams = Static<typeof WbDrawCodeParams>;

const WbEditCodeParams = Type.Union([
  Type.Object({
    elementId: Type.String(),
    operation: Type.Literal('insert_after'),
    lineId: Type.String(),
    content: Type.String(),
  }),
  Type.Object({
    elementId: Type.String(),
    operation: Type.Literal('insert_before'),
    lineId: Type.String(),
    content: Type.String(),
  }),
  Type.Object({
    elementId: Type.String(),
    operation: Type.Literal('delete_lines'),
    lineIds: Type.Array(Type.String(), { minItems: 1 }),
  }),
  Type.Object({
    elementId: Type.String(),
    operation: Type.Literal('replace_lines'),
    lineIds: Type.Array(Type.String(), { minItems: 1 }),
    content: Type.String(),
  }),
]);
type WbEditCodeParams = Static<typeof WbEditCodeParams>;

function getInitialWhiteboardElementCount(body: StatelessChatRequest): number {
  const whiteboards = body.storeState.stage?.whiteboard;
  const latestWhiteboard = Array.isArray(whiteboards) ? whiteboards[whiteboards.length - 1] : null;
  const elements = latestWhiteboard?.elements;
  return Array.isArray(elements) ? elements.length : 0;
}

function getInitialWhiteboardElementIds(body: StatelessChatRequest): Set<string> {
  const whiteboards = body.storeState.stage?.whiteboard;
  const latestWhiteboard = Array.isArray(whiteboards) ? whiteboards[whiteboards.length - 1] : null;
  const elements = latestWhiteboard?.elements;
  if (!Array.isArray(elements)) return new Set();

  return new Set(
    elements
      .map((element) =>
        element && typeof element === 'object' && 'id' in element
          ? String((element as { id?: unknown }).id ?? '')
          : '',
      )
      .filter(Boolean),
  );
}

function getInitialWhiteboardCodeLineIds(body: StatelessChatRequest): Map<string, Set<string>> {
  const whiteboards = body.storeState.stage?.whiteboard;
  const latestWhiteboard = Array.isArray(whiteboards) ? whiteboards[whiteboards.length - 1] : null;
  const elements = latestWhiteboard?.elements;
  if (!Array.isArray(elements)) return new Map();

  const result = new Map<string, Set<string>>();
  for (const element of elements) {
    if (!element || typeof element !== 'object') continue;
    const candidate = element as { id?: unknown; type?: unknown; lines?: unknown };
    if (candidate.type !== 'code' || typeof candidate.id !== 'string') continue;
    if (!Array.isArray(candidate.lines)) continue;
    const lineIds = candidate.lines
      .map((line) =>
        line && typeof line === 'object' && 'id' in line
          ? String((line as { id?: unknown }).id ?? '')
          : '',
      )
      .filter(Boolean);
    result.set(candidate.id, new Set(lineIds));
  }
  return result;
}

function isWhiteboardDrawAction(name: string): boolean {
  return name.startsWith('wb_draw_');
}

function isNonEmptyRectangularStringMatrix(value: unknown): value is string[][] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const columnCount = Array.isArray(value[0]) ? value[0].length : 0;
  return (
    columnCount > 0 &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === columnCount &&
        row.every((cell) => typeof cell === 'string'),
    )
  );
}

export interface PiWhiteboardRuntimeState {
  open: boolean;
  visibleElementCount: number;
  knownElementIds: Set<string>;
  codeLineIdsByElementId: Map<string, Set<string>>;
}

export function createPiWhiteboardRuntimeState(
  body: StatelessChatRequest,
): PiWhiteboardRuntimeState {
  return {
    open: Boolean(body.storeState.whiteboardOpen),
    visibleElementCount: getInitialWhiteboardElementCount(body),
    knownElementIds: getInitialWhiteboardElementIds(body),
    codeLineIdsByElementId: getInitialWhiteboardCodeLineIds(body),
  };
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

export function buildChildActionTools(opts: {
  body: StatelessChatRequest;
  agent: AgentConfig;
  messageId: string;
  send: SendEvent;
  onActionDone: (record?: WhiteboardActionRecord) => void;
  maxActionsPerAgent: number;
  enableWhiteboardTools: boolean;
  turnKind?: 'normal' | 'wrap_up';
  whiteboardState?: PiWhiteboardRuntimeState;
}): AgentTool[] {
  const currentScene = opts.body.storeState.currentSceneId
    ? opts.body.storeState.scenes.find((scene) => scene.id === opts.body.storeState.currentSceneId)
    : undefined;
  const slideOnlyPiActions = currentScene?.type === 'slide' ? ['play_video'] : [];
  const allowWhiteboardMutations = opts.enableWhiteboardTools && opts.turnKind !== 'wrap_up';
  const piActionAllowlist = allowWhiteboardMutations
    ? [
        'spotlight',
        'laser',
        ...slideOnlyPiActions,
        'wb_open',
        'wb_close',
        'wb_draw_text',
        'wb_draw_shape',
        'wb_draw_chart',
        'wb_draw_latex',
        'wb_draw_table',
        'wb_draw_line',
        'wb_draw_code',
        'wb_edit_code',
        'wb_clear',
        'wb_delete',
      ]
    : ['spotlight', 'laser', ...slideOnlyPiActions];
  const effectiveActions = new Set(
    getEffectiveActions(opts.agent.allowedActions, currentScene?.type).filter((name) =>
      piActionAllowlist.includes(name),
    ),
  );
  let emittedActionCount = 0;
  const whiteboardState = opts.whiteboardState ?? createPiWhiteboardRuntimeState(opts.body);

  const makeActionTool = <
    TParams extends
      | typeof SpotlightParams
      | typeof LaserParams
      | typeof PlayVideoParams
      | typeof EmptyParams
      | typeof WbDeleteParams
      | typeof WbDrawTextParams
      | typeof WbDrawShapeParams
      | typeof WbDrawChartParams
      | typeof WbDrawLatexParams
      | typeof WbDrawTableParams
      | typeof WbDrawLineParams
      | typeof WbDrawCodeParams
      | typeof WbEditCodeParams,
  >(
    name: string,
    label: string,
    description: string,
    parameters: TParams,
  ): AgentTool<TParams> => ({
    name,
    label,
    description,
    parameters,
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      if (name === 'wb_open' && whiteboardState.open) {
        return {
          content: [
            {
              type: 'text',
              text: 'Action wb_open skipped because the whiteboard is already open.',
            },
          ],
          details: { skipped: true, reason: 'whiteboard_already_open', actionName: name },
        };
      }

      if (
        (name === 'wb_clear' || name === 'wb_delete') &&
        whiteboardState.visibleElementCount === 0
      ) {
        return {
          content: [
            {
              type: 'text',
              text: `Action ${name} skipped because the whiteboard has no visible elements.`,
            },
          ],
          details: { skipped: true, reason: 'whiteboard_empty', actionName: name },
        };
      }

      if (emittedActionCount >= opts.maxActionsPerAgent) {
        return {
          content: [
            {
              type: 'text',
              text: `Action ${name} skipped because this agent turn already used the allowed action budget.`,
            },
          ],
          details: { skipped: true, reason: 'action_budget', actionName: name },
        };
      }

      if (name === 'play_video') {
        const elementId = (params as PlayVideoParams).elementId;
        const slideElement = findCurrentSlideElement(opts.body, elementId);
        if (!slideElement) {
          return {
            content: [
              {
                type: 'text',
                text: `Action play_video skipped because slide element "${elementId}" was not found.`,
              },
            ],
            details: {
              skipped: true,
              reason: 'slide_element_not_found',
              actionName: name,
              elementId,
            },
          };
        }
        if (slideElement.type !== 'video') {
          return {
            content: [
              {
                type: 'text',
                text: `Action play_video skipped because slide element "${elementId}" is not a video.`,
              },
            ],
            details: {
              skipped: true,
              reason: 'slide_element_not_video',
              actionName: name,
              elementId,
              elementType: slideElement.type,
            },
          };
        }
      }

      const actionParams = params as Record<string, unknown>;

      if (isWhiteboardDrawAction(name) && !actionParams.elementId) {
        actionParams.elementId = nanoid();
      }

      if (name === 'wb_draw_table' && !isNonEmptyRectangularStringMatrix(actionParams.data)) {
        return {
          content: [
            {
              type: 'text',
              text: 'Action wb_draw_table skipped because data must be a non-empty rectangular string matrix.',
            },
          ],
          details: {
            skipped: true,
            reason: 'whiteboard_invalid_table',
            actionName: name,
          },
        };
      }

      if (isWhiteboardDrawAction(name)) {
        const elementId = actionParams.elementId;
        if (
          typeof elementId === 'string' &&
          elementId &&
          whiteboardState.knownElementIds.has(elementId)
        ) {
          return {
            content: [
              {
                type: 'text',
                text: `Action ${name} skipped because whiteboard element id "${elementId}" already exists.`,
              },
            ],
            details: {
              skipped: true,
              reason: 'whiteboard_element_id_conflict',
              actionName: name,
              elementId,
            },
          };
        }
      }

      if (name === 'wb_delete') {
        const elementId = String(actionParams.elementId ?? '');
        if (!whiteboardState.knownElementIds.has(elementId)) {
          return {
            content: [
              {
                type: 'text',
                text: `Action wb_delete skipped because whiteboard element "${elementId}" was not found.`,
              },
            ],
            details: {
              skipped: true,
              reason: 'whiteboard_element_not_found',
              actionName: name,
              elementId,
            },
          };
        }
      }

      if (name === 'wb_edit_code') {
        const elementId = String(actionParams.elementId ?? '');
        const knownLineIds = whiteboardState.codeLineIdsByElementId.get(elementId);
        if (!knownLineIds) {
          return {
            content: [
              {
                type: 'text',
                text: `Action wb_edit_code skipped because code element "${elementId}" was not found.`,
              },
            ],
            details: {
              skipped: true,
              reason: 'whiteboard_code_element_not_found',
              actionName: name,
              elementId,
            },
          };
        }

        const operation = actionParams.operation;
        const targetLineIds =
          operation === 'insert_after' || operation === 'insert_before'
            ? [String(actionParams.lineId ?? '')]
            : Array.isArray(actionParams.lineIds)
              ? actionParams.lineIds.map(String)
              : [];
        const missingLineId = targetLineIds.find((lineId) => !knownLineIds.has(lineId));
        if (missingLineId) {
          return {
            content: [
              {
                type: 'text',
                text: `Action wb_edit_code skipped because line "${missingLineId}" was not found in code element "${elementId}".`,
              },
            ],
            details: {
              skipped: true,
              reason: 'whiteboard_code_line_not_found',
              actionName: name,
              elementId,
              lineId: missingLineId,
            },
          };
        }
      }

      if (name === 'wb_draw_code') {
        actionParams.lineIds = String(actionParams.code ?? '')
          .split('\n')
          .map((_line, index) => `L${index + 1}`);
      }
      if (name === 'wb_edit_code') {
        const operation = actionParams.operation;
        if (
          operation === 'insert_after' ||
          operation === 'insert_before' ||
          operation === 'replace_lines'
        ) {
          const contentLineCount = String(actionParams.content ?? '').split('\n').length;
          const replacedLineIds =
            operation === 'replace_lines' && Array.isArray(actionParams.lineIds)
              ? actionParams.lineIds.map(String)
              : [];
          actionParams.newLineIds = Array.from(
            { length: contentLineCount },
            (_unused, index) => replacedLineIds[index] ?? nanoid(),
          );
        }
      }

      const actionId = nanoid();
      emittedActionCount += 1;
      await opts.send({
        type: 'action',
        data: {
          actionId,
          actionName: name,
          params: actionParams,
          agentId: opts.agent.id,
          messageId: opts.messageId,
        },
      });
      if (name === 'wb_open') whiteboardState.open = true;
      if (name === 'wb_close') whiteboardState.open = false;
      if (name === 'wb_clear') {
        whiteboardState.open = true;
        whiteboardState.visibleElementCount = 0;
        whiteboardState.knownElementIds.clear();
        whiteboardState.codeLineIdsByElementId.clear();
      }
      if (isWhiteboardDrawAction(name)) {
        whiteboardState.open = true;
        whiteboardState.visibleElementCount += 1;
        const elementId = actionParams.elementId;
        if (typeof elementId === 'string' && elementId) {
          whiteboardState.knownElementIds.add(elementId);
          if (name === 'wb_draw_code') {
            whiteboardState.codeLineIdsByElementId.set(
              elementId,
              new Set((actionParams.lineIds as string[]) ?? []),
            );
          }
        }
      }
      if (name === 'wb_delete') {
        whiteboardState.open = true;
        const elementId = String(actionParams.elementId);
        whiteboardState.knownElementIds.delete(elementId);
        whiteboardState.visibleElementCount = Math.max(whiteboardState.visibleElementCount - 1, 0);
        whiteboardState.codeLineIdsByElementId.delete(elementId);
      }
      if (name === 'wb_edit_code') {
        const elementId = String(actionParams.elementId);
        const lineIds = whiteboardState.codeLineIdsByElementId.get(elementId);
        const operation = actionParams.operation;
        if (lineIds && (operation === 'delete_lines' || operation === 'replace_lines')) {
          const targetLineIds = (actionParams.lineIds as string[]) ?? [];
          targetLineIds.forEach((lineId) => lineIds.delete(lineId));
          if (operation === 'replace_lines') {
            ((actionParams.newLineIds as string[]) ?? []).forEach((lineId) => lineIds.add(lineId));
          }
        } else if (lineIds && (operation === 'insert_after' || operation === 'insert_before')) {
          ((actionParams.newLineIds as string[]) ?? []).forEach((lineId) => lineIds.add(lineId));
        }
      }
      opts.onActionDone(
        name.startsWith('wb_')
          ? {
              actionName: name as WhiteboardActionRecord['actionName'],
              agentId: opts.agent.id,
              agentName: opts.agent.name,
              params: actionParams,
            }
          : undefined,
      );
      return {
        content: [{ type: 'text', text: `Action ${name} was sent to the client.` }],
        details: { actionId, actionName: name, params },
      };
    },
  });

  const tools: AgentTool[] = [];
  if (effectiveActions.has('spotlight')) {
    tools.push(
      makeActionTool(
        'spotlight',
        'Spotlight slide element',
        'Focus attention on one slide element by elementId.',
        SpotlightParams,
      ),
    );
  }
  if (effectiveActions.has('laser')) {
    tools.push(
      makeActionTool(
        'laser',
        'Laser pointer',
        'Point at one slide element by elementId.',
        LaserParams,
      ),
    );
  }
  if (effectiveActions.has('play_video')) {
    tools.push(
      makeActionTool(
        'play_video',
        'Play slide video',
        'Start playback of a video element on the current slide by elementId.',
        PlayVideoParams,
      ),
    );
  }
  if (effectiveActions.has('wb_open')) {
    tools.push(
      makeActionTool('wb_open', 'Open whiteboard', 'Open the classroom whiteboard.', EmptyParams),
    );
  }
  if (effectiveActions.has('wb_draw_text')) {
    tools.push(
      makeActionTool(
        'wb_draw_text',
        'Draw whiteboard text',
        'Draw concise text, equations, or key steps on the whiteboard.',
        WbDrawTextParams,
      ),
    );
  }
  if (effectiveActions.has('wb_draw_shape')) {
    tools.push(
      makeActionTool(
        'wb_draw_shape',
        'Draw whiteboard shape',
        'Draw a rectangle, circle, or triangle on the whiteboard.',
        WbDrawShapeParams,
      ),
    );
  }
  if (effectiveActions.has('wb_draw_chart')) {
    tools.push(
      makeActionTool(
        'wb_draw_chart',
        'Draw whiteboard chart',
        'Draw a chart on the whiteboard for data or comparisons.',
        WbDrawChartParams,
      ),
    );
  }
  if (effectiveActions.has('wb_draw_latex')) {
    tools.push(
      makeActionTool(
        'wb_draw_latex',
        'Draw whiteboard LaTeX',
        'Draw a LaTeX formula on the whiteboard.',
        WbDrawLatexParams,
      ),
    );
  }
  if (effectiveActions.has('wb_draw_table')) {
    tools.push(
      makeActionTool(
        'wb_draw_table',
        'Draw whiteboard table',
        'Draw a table on the whiteboard for structured data.',
        WbDrawTableParams,
      ),
    );
  }
  if (effectiveActions.has('wb_draw_line')) {
    tools.push(
      makeActionTool(
        'wb_draw_line',
        'Draw whiteboard line',
        'Draw a line or arrow on the whiteboard.',
        WbDrawLineParams,
      ),
    );
  }
  if (effectiveActions.has('wb_draw_code')) {
    tools.push(
      makeActionTool(
        'wb_draw_code',
        'Draw whiteboard code',
        'Draw a syntax-highlighted code block on the whiteboard.',
        WbDrawCodeParams,
      ),
    );
  }
  if (effectiveActions.has('wb_edit_code')) {
    tools.push(
      makeActionTool(
        'wb_edit_code',
        'Edit whiteboard code',
        'Edit an existing code block on the whiteboard.',
        WbEditCodeParams,
      ),
    );
  }
  if (effectiveActions.has('wb_clear')) {
    tools.push(
      makeActionTool(
        'wb_clear',
        'Clear whiteboard',
        'Clear all elements from the classroom whiteboard.',
        EmptyParams,
      ),
    );
  }
  if (effectiveActions.has('wb_delete')) {
    tools.push(
      makeActionTool(
        'wb_delete',
        'Delete whiteboard element',
        'Delete one whiteboard element by elementId.',
        WbDeleteParams,
      ),
    );
  }
  if (effectiveActions.has('wb_close')) {
    tools.push(
      makeActionTool(
        'wb_close',
        'Close whiteboard',
        'Close the whiteboard and return to the slide.',
        EmptyParams,
      ),
    );
  }

  return tools;
}
