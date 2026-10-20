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
import { areBasicShapes, isPentagon, isRightTriangle, squareOnHypotenuse } from './geometry-checks';

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
    check: (s: PPTShapeElement[]) => s.length === 1 && isPentagon(s[0]),
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
    check: areBasicShapes,
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
