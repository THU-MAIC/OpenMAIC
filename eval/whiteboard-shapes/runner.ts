/** Live Native shape-tool eval; see README.md for configuration and limits. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { PPTShapeElement } from '@openmaic/dsl';
import { BrowserRuntimeStore } from '@openmaic/storage';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { runNativeChild } from '@/lib/agent/runtime/run-native-child';
import { buildNativeChildPrompt, buildNativeChildTurnPrompt } from '@/lib/chat/pi/prompts';
import { buildNativeWhiteboardTools } from '@/lib/chat/pi/tools/native-whiteboard';
import { settleWhiteboardVisibility } from '@/lib/chat/pi/whiteboard-visibility';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import type { StatelessChatRequest } from '@/lib/types/chat';
import { createWhiteboardRuntimeService } from '@/lib/whiteboard/runtime/store';
import { resolveModel } from '@/lib/server/resolve-model';
import {
  areBasicShapes,
  assessComposition,
  hasVisibleFill,
  isCurveScenarioShape,
  isPentagon,
  isRightTriangle,
  squareOnHypotenuse,
  type TriangleVertices,
} from './geometry-checks';
import { compositionScenario } from './composition-scenarios';

interface Scenario {
  id: string;
  request: string;
  check: (shapes: PPTShapeElement[]) => boolean;
  injectError?: boolean;
  variant?: number;
  vertices?: TriangleVertices;
}

interface RunOptions {
  thinking: 'enabled' | 'disabled';
  timeoutMs: number;
  maxProviderTransports: number;
}

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
const cases: Scenario[] = [
  {
    id: 'pythagoras',
    request:
      'Draw exactly two shapes: a filled 3–4–5 right triangle with vertices A=(100,100), B=(340,100), C=(100,280), then an outward square of side 300 on its hypotenuse BC. Use a custom triangle path and a rotated rectangle for the square. Keep both inside the board.',
    check: (s: PPTShapeElement[]) =>
      s.length === 2 &&
      s.every(hasVisibleFill) &&
      s.some((v) => isRightTriangle(v)) &&
      s.some(squareOnHypotenuse),
  },
  {
    id: 'polygon',
    request:
      'Draw one filled irregular pentagon using a custom SVG path with 5 vertices. Place it in x=100,y=100,width=240,height=180. No other elements.',
    check: (s: PPTShapeElement[]) => s.length === 1 && hasVisibleFill(s[0]) && isPentagon(s[0]),
  },
  {
    id: 'curve',
    request:
      'Draw one open cubic Bezier curve, transparent fill, dark 2px stroke, with an unrotated box at x=100,y=300,width=240,height=80 and rotation 12.5 degrees around its center. Keep the path within that unrotated box. No other elements.',
    check: (s: PPTShapeElement[]) => s.length === 1 && isCurveScenarioShape(s[0]),
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
    check: (s: PPTShapeElement[]) =>
      s.length === 1 && hasVisibleFill(s[0]) && isRightTriangle(s[0]),
  },
];

async function runCase(modelString: string, scenario: Scenario, options: RunOptions) {
  const started = Date.now();
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
  const systemPrompt = buildNativeChildPrompt(
    body,
    teacher,
    [],
    tools.map((t) => t.name),
  );
  const native = await runNativeChild({
    systemPrompt,
    prompt: buildNativeChildTurnPrompt(scenario.request, teacher.role),
    streamFn: createCallLlmStreamFn({
      languageModel: resolved.model,
      source: 'pi-chat-native-child',
      thinkingConfig: { mode: options.thinking, enabled: options.thinking === 'enabled' },
      maxOutputTokens: 4096,
    }),
    tools,
    allowedToolNames: new Set(tools.map((t) => t.name)),
    timeoutMs: options.timeoutMs,
    maxProviderTransports: options.maxProviderTransports,
  });
  const elements = (await service.read('shape-eval')).whiteboard?.elements ?? [];
  const shapes = elements.filter((s): s is PPTShapeElement => s.type === 'shape');
  const failures = calls.filter((c) => c.error || (c.result as { isError?: boolean })?.isError);
  const geometryPassed = elements.length === shapes.length && scenario.check(shapes);
  return {
    model: modelString,
    scenario: scenario.id,
    variant: scenario.variant,
    vertices: scenario.vertices,
    request: scenario.request,
    systemPrompt,
    options,
    elapsedMs: Date.now() - started,
    passed: native.status === 'completed' && geometryPassed,
    geometryPassed,
    assessment: scenario.vertices ? assessComposition(shapes, scenario.vertices) : undefined,
    native,
    injected,
    failedCalls: failures.length,
    corrected: failures.length > 0 && geometryPassed,
    calls,
    shapes,
  };
}

function positiveInteger(value: string, option: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${option} must be a positive integer`);
  return n;
}

async function main() {
  const { values } = parseArgs({
    options: {
      models: { type: 'string' },
      output: { type: 'string', default: 'eval/whiteboard-shapes/results' },
      cases: { type: 'string', default: 'all' },
      repetitions: { type: 'string', default: '1' },
      thinking: { type: 'string', default: 'enabled' },
      'timeout-ms': { type: 'string', default: '60000' },
      'max-provider-transports': { type: 'string', default: '5' },
    },
  });
  const models = (values.models || process.env.EVAL_SHAPE_MODELS || '').split(',').filter(Boolean);
  if (!models.length)
    throw new Error('Pass --models provider:model,provider:model or set EVAL_SHAPE_MODELS');
  if (values.thinking !== 'enabled' && values.thinking !== 'disabled')
    throw new Error('--thinking must be enabled or disabled');
  const options: RunOptions = {
    thinking: values.thinking,
    timeoutMs: positiveInteger(values['timeout-ms']!, '--timeout-ms'),
    maxProviderTransports: positiveInteger(
      values['max-provider-transports']!,
      '--max-provider-transports',
    ),
  };
  const repetitions = positiveInteger(values.repetitions!, '--repetitions');
  const selected =
    values.cases === 'all' ? [...cases.map((c) => c.id), 'composition'] : values.cases!.split(',');
  if (selected.some((id) => id !== 'composition' && !cases.some((c) => c.id === id)))
    throw new Error(`Unknown case in --cases ${values.cases}`);
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
  const results = [];
  mkdirSync(values.output!, { recursive: true });
  for (const model of models)
    for (let repetition = 0; repetition < repetitions; repetition++)
      for (const id of selected) {
        const composition = compositionScenario(repetition);
        const scenario =
          id === 'composition'
            ? {
                id,
                ...composition,
                check: (shapes: PPTShapeElement[]) =>
                  assessComposition(shapes, composition.vertices).passed,
              }
            : cases.find((c) => c.id === id)!;
        const result = await runCase(model, scenario, options);
        const trial = { ...result, repetition };
        results.push(trial);
        console.log(
          JSON.stringify({
            model,
            scenario: scenario.id,
            repetition,
            variant: scenario.variant,
            passed: result.passed,
            geometryPassed: result.geometryPassed,
            assessment: result.assessment,
            status: result.native.status,
            stopReason: result.native.stopReason,
            providerTransports: result.native.providerTransportCount,
            failedCalls: result.failedCalls,
            corrected: result.corrected,
            elapsedMs: result.elapsedMs,
          }),
        );
        writeFileSync(
          `${values.output}/${model.replace(/[^a-z0-9-]/gi, '_')}-${id}-${repetition}.json`,
          JSON.stringify(trial, null, 2),
        );
        writeFileSync(
          `${values.output}/report.json`,
          JSON.stringify(
            { date: new Date().toISOString(), options, models, selected, repetitions, results },
            null,
            2,
          ),
        );
        if (result.native.status === 'failed' && result.calls.length === 0)
          throw new Error(`Provider failed before any tool call: ${result.native.stopReason}`);
      }
  if (results.some((r) => !r.passed)) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
