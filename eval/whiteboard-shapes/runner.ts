/** Live Native shape-tool eval; see README.md for configuration and limits. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { PPTShapeElement } from '@openmaic/dsl';
import { BrowserRuntimeStore } from '@openmaic/storage';
import { buildAgent } from '@/lib/agent/runtime/build-agent';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { buildNativeChildPrompt } from '@/lib/chat/pi/prompts';
import { buildNativeWhiteboardTools } from '@/lib/chat/pi/tools/native-whiteboard';
import { settleWhiteboardVisibility } from '@/lib/chat/pi/whiteboard-visibility';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import type { StatelessChatRequest } from '@/lib/types/chat';
import { createWhiteboardRuntimeService } from '@/lib/whiteboard/runtime/store';
import { resolveModel } from '@/lib/server/resolve-model';
import { validateSvgPath } from '@openmaic/geometry';
import { SVGPathData } from 'svg-pathdata';

const teacher: AgentConfig = {
  id: 'shape-eval',
  name: 'Geometry teacher',
  role: 'teacher',
  persona: 'Draw mathematically accurate diagrams.',
  avatar: '',
  color: '#3366ff',
  allowedActions: ['wb_draw_shape'],
  priority: 10,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  isDefault: true,
};
const body: StatelessChatRequest = {
  apiKey: '',
  messages: [],
  storeState: {
    stage: null,
    scenes: [],
    currentSceneId: null,
    mode: 'playback',
    whiteboardOpen: false,
  },
  config: { agentIds: [teacher.id] },
};
function polygonVertices(s: PPTShapeElement): number[][] {
  const result = validateSvgPath(s.path);
  if (!result.ok) return [];
  const commands = new SVGPathData(result.commands).toAbs().normalizeHVZ().commands;
  if (
    commands.some(
      (c) =>
        c.type !== SVGPathData.MOVE_TO &&
        c.type !== SVGPathData.LINE_TO &&
        c.type !== SVGPathData.CLOSE_PATH,
    )
  )
    return [];
  return commands.flatMap((c) =>
    'x' in c && 'y' in c
      ? [[s.left + (c.x * s.width) / s.viewBox[0], s.top + (c.y * s.height) / s.viewBox[1]]]
      : [],
  );
}
function isRightTriangle(s: PPTShapeElement): boolean {
  const vertices = polygonVertices(s);
  return (
    /[zZ]/.test(s.path) &&
    vertices.length >= 3 &&
    [
      [100, 100],
      [340, 100],
      [100, 280],
    ].every(([x, y]) => vertices.some(([vx, vy]) => Math.hypot(vx - x, vy - y) < 1))
  );
}
function squareOnHypotenuse(s: PPTShapeElement): boolean {
  if (Math.abs(s.width - 300) > 1 || Math.abs(s.height - 300) > 1) return false;
  const theta = (s.rotate * Math.PI) / 180;
  const cx = s.left + s.width / 2,
    cy = s.top + s.height / 2;
  if (Math.hypot(cx - 310, cy - 310) > 1) return false;
  const vertices = [
    [-150, -150],
    [150, -150],
    [150, 150],
    [-150, 150],
  ].map(([x, y]) => [
    cx + x * Math.cos(theta) - y * Math.sin(theta),
    cy + x * Math.sin(theta) + y * Math.cos(theta),
  ]);
  return [
    [340, 100],
    [100, 280],
  ].every(([x, y]) => vertices.some(([vx, vy]) => Math.hypot(vx - x, vy - y) < 1));
}
function isCircle(s: PPTShapeElement, cx: number, cy: number, radius: number): boolean {
  const result = validateSvgPath(s.path);
  if (!result.ok) return false;
  try {
    const commands = new SVGPathData(result.commands)
      .toAbs()
      .normalizeHVZ()
      .normalizeST()
      .qtToC()
      .aToC()
      .scale(s.width / s.viewBox[0], s.height / s.viewBox[1])
      .translate(s.left, s.top).commands;
    const points: number[][] = [];
    let x = 0,
      y = 0,
      moves = 0;
    for (const c of commands) {
      if (c.type === SVGPathData.MOVE_TO) {
        points.push([c.x, c.y]);
        moves++;
      } else if (c.type === SVGPathData.LINE_TO || c.type === SVGPathData.CURVE_TO) {
        for (let i = 1; i <= 32; i++) {
          const t = i / 32,
            u = 1 - t;
          points.push(
            c.type === SVGPathData.LINE_TO
              ? [x + t * (c.x - x), y + t * (c.y - y)]
              : [
                  u ** 3 * x + 3 * u ** 2 * t * c.x1 + 3 * u * t ** 2 * c.x2 + t ** 3 * c.x,
                  u ** 3 * y + 3 * u ** 2 * t * c.y1 + 3 * u * t ** 2 * c.y2 + t ** 3 * c.y,
                ],
          );
        }
      } else return false;
      x = c.x;
      y = c.y;
    }
    if (moves !== 1 || points.length < 33) return false;
    const first = points[0],
      last = points[points.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1) return false;
    const area =
      Math.abs(
        points.reduce((sum, p, i) => {
          const next = points[(i + 1) % points.length];
          return sum + p[0] * next[1] - next[0] * p[1];
        }, 0),
      ) / 2;
    return (
      Math.abs(area / (Math.PI * radius ** 2) - 1) < 0.02 &&
      points.every(([px, py]) => Math.abs(Math.hypot(px - cx, py - cy) - radius) < 1)
    );
  } catch {
    return false;
  }
}
const cases = [
  {
    id: 'pythagoras',
    request:
      'Draw exactly two shapes: a filled 3–4–5 right triangle with vertices A=(100,100), B=(340,100), C=(100,280), then an outward square of side 300 on its hypotenuse BC. Use a custom triangle path and a rotated rectangle for the square. Keep both inside the board.',
    check: (s: PPTShapeElement[]) =>
      s.length === 2 && s.some((v) => isRightTriangle(v)) && s.some(squareOnHypotenuse),
  },
  {
    id: 'polygon',
    request:
      'Draw one filled irregular pentagon using a custom SVG path with 5 vertices. Place it in x=100,y=100,width=240,height=180. No other elements.',
    check: (s: PPTShapeElement[]) =>
      s.length === 1 && /[zZ]/.test(s[0].path) && polygonVertices(s[0]).length >= 5,
  },
  {
    id: 'curve',
    request:
      'Draw one open cubic Bezier curve, transparent fill, dark 2px stroke, rotated 12.5 degrees, within x=100,y=300,width=240,height=80. No other elements.',
    check: (s: PPTShapeElement[]) =>
      s.length === 1 &&
      /[Cc]/.test(s[0].path) &&
      s[0].fill === 'transparent' &&
      s[0].outline?.width === 2 &&
      s[0].rotate === 12.5,
  },
  {
    id: 'basic-paths',
    request:
      'Draw exactly three filled shapes in a row using SVG paths: rectangle, complete circle, and top-centered isosceles triangle. Use x=80,340,600; y=100; width=height=120. No rotation or extra elements.',
    check: (shapes: PPTShapeElement[]) => {
      if (shapes.length !== 3 || shapes.some((s) => s.rotate !== 0 || s.fill === 'transparent'))
        return false;
      return [80, 340, 600].every((x, i) => {
        const s = shapes.find(
          (v) => v.left === x && v.top === 100 && v.width === 120 && v.height === 120,
        );
        if (!s) return false;
        if (i === 1) return isCircle(s, x + 60, 160, 60);
        const expected =
          i === 0
            ? [
                [x, 100],
                [x + 120, 100],
                [x + 120, 220],
                [x, 220],
              ]
            : [
                [x + 60, 100],
                [x + 120, 220],
                [x, 220],
              ];
        const actual = polygonVertices(s);
        const area =
          Math.abs(
            actual.reduce((sum, p, index) => {
              const next = actual[(index + 1) % actual.length];
              return sum + p[0] * next[1] - next[0] * p[1];
            }, 0),
          ) / 2;
        const expectedArea = i === 0 ? 120 * 120 : (120 * 120) / 2;
        return (
          /[zZ]/.test(s.path) &&
          Math.abs(area / expectedArea - 1) < 0.02 &&
          actual.length >= expected.length &&
          actual.every(([px, py]) =>
            expected.some(([ex, ey]) => Math.hypot(px - ex, py - ey) < 1),
          ) &&
          expected.every(([ex, ey]) => actual.some(([px, py]) => Math.hypot(px - ex, py - ey) < 1))
        );
      });
    },
  },
  {
    id: 'correction',
    request:
      'Draw a single filled custom 3–4–5 triangle at x=100,y=100,width=240,height=180. If the drawing tool returns a path error, fix the input and retry.',
    injectError: true,
    check: (s: PPTShapeElement[]) => s.length === 1 && isRightTriangle(s[0]),
  },
];

async function runCase(modelString: string, scenario: (typeof cases)[number]) {
  const resolved = await resolveModel({ modelString });
  const store = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  const service = createWhiteboardRuntimeService({
    store,
    resolveLearnerKey: () => 'eval',
    withMaintenanceLock: (work) => work(),
  });
  const calls: Array<{ name: string; args: unknown; result?: unknown; error?: string }> = [];
  let injected = false;
  const tools = buildNativeWhiteboardTools({
    agent: teacher,
    messageId: `${modelString}:${scenario.id}`,
    service,
    stageId: 'shape-eval',
    learnerKey: 'eval',
    requestStartManualVisibilityRevision: 0,
    send: async (event) => {
      if (event.type === 'whiteboard' && event.data.kind === 'visibility_query')
        settleWhiteboardVisibility({
          queryId: event.data.queryId,
          stageId: 'shape-eval',
          learnerKey: 'eval',
          visibility: 'open',
        });
    },
  }).map((tool) => ({
    ...tool,
    prepareArguments: (args: unknown) => {
      try {
        return tool.prepareArguments ? tool.prepareArguments(args) : args;
      } catch (error) {
        calls.push({
          name: tool.name,
          args,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    execute: async (id: string, args: unknown, signal?: AbortSignal) => {
      const input =
        scenario.injectError && !injected && tool.name === 'wb_draw_shape'
          ? ((injected = true), { ...(args as Record<string, unknown>), path: 'M0 0 Z1 1' })
          : args;
      const result = await tool.execute(id, input, signal);
      calls.push({ name: tool.name, args: input, result });
      return result;
    },
  }));
  const agent = buildAgent({
    systemPrompt: buildNativeChildPrompt(
      body,
      teacher,
      [],
      tools.map((t) => t.name),
    ),
    streamFn: createCallLlmStreamFn({
      languageModel: resolved.model,
      thinkingConfig: { mode: 'disabled', enabled: false },
      maxOutputTokens: 4096,
    }),
    tools,
    allowedToolNames: new Set(tools.map((t) => t.name)),
    afterToolCall: () => (calls.length >= 24 ? { terminate: true } : undefined),
  });
  const timer = setTimeout(() => agent.abort(), 120_000);
  let error: string | undefined;
  try {
    await agent.prompt(scenario.request);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  const shapes =
    (await service.read('shape-eval')).whiteboard?.elements.filter(
      (s): s is PPTShapeElement => s.type === 'shape',
    ) ?? [];
  const failures = calls.filter((c) => c.error || (c.result as { isError?: boolean })?.isError);
  const terminalError = agent.state.messages.findLast(
    (m) => m.role === 'assistant' && m.stopReason === 'error',
  );
  if (terminalError?.role === 'assistant') error ??= terminalError.errorMessage;
  return {
    model: modelString,
    scenario: scenario.id,
    passed: !error && scenario.check(shapes),
    injected,
    error,
    failedCalls: failures.length,
    corrected: failures.length > 0 && scenario.check(shapes),
    calls,
    shapes,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      models: { type: 'string' },
      output: { type: 'string', default: 'eval/whiteboard-shapes/results' },
    },
  });
  const models = (values.models || process.env.EVAL_SHAPE_MODELS || '').split(',').filter(Boolean);
  if (!models.length)
    throw new Error('Pass --models provider:model,provider:model or set EVAL_SHAPE_MODELS');
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
  const results = [];
  for (const model of models)
    for (const scenario of cases) {
      const result = await runCase(model, scenario);
      results.push(result);
      console.log(
        JSON.stringify({
          model,
          scenario: scenario.id,
          passed: result.passed,
          failedCalls: result.failedCalls,
          corrected: result.corrected,
          error: result.error,
        }),
      );
      mkdirSync(values.output!, { recursive: true });
      writeFileSync(
        `${values.output}/report.json`,
        JSON.stringify({ date: new Date().toISOString(), results }, null, 2),
      );
    }
  if (results.some((r) => !r.passed)) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
