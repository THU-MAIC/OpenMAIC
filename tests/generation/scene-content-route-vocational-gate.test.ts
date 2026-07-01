import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { SceneOutline } from '@/lib/types/generation';

const callLLMMock = vi.hoisted(() => vi.fn());
const resolveModelFromRequestMock = vi.hoisted(() => vi.fn());
const VOCATIONAL_FLAG = 'OPENMAIC_ENABLE_VOCATIONAL';
let originalVocationalFlag: string | undefined;

vi.mock('@/lib/ai/llm', () => ({
  callLLM: callLLMMock,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: resolveModelFromRequestMock,
}));

describe('scene-content vocational gate', () => {
  beforeEach(() => {
    originalVocationalFlag = process.env[VOCATIONAL_FLAG];
    delete process.env[VOCATIONAL_FLAG];
    callLLMMock.mockReset();
    resolveModelFromRequestMock.mockReset();
    resolveModelFromRequestMock.mockResolvedValue({
      model: { provider: 'test.chat', modelId: 'test-model' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'test:test-model',
      thinkingConfig: undefined,
    });
  });

  afterEach(() => {
    if (originalVocationalFlag === undefined) {
      delete process.env[VOCATIONAL_FLAG];
    } else {
      process.env[VOCATIONAL_FLAG] = originalVocationalFlag;
    }
  });

  test('flag off direct/replayed procedural-skill outline is downgraded before content generation', async () => {
    vi.resetModules();
    process.env[VOCATIONAL_FLAG] = 'false';
    callLLMMock.mockResolvedValueOnce({
      text: htmlForWidget('diagram'),
    });

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(
      mockRequest(createProceduralSkillOutline(), { taskEngineMode: true }),
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.effectiveOutline.widgetType).toBe('diagram');
    expect(body.effectiveOutline.widgetOutline.task).toBeUndefined();
    expect(body.content.widgetType).toBe('diagram');
    expect(body.content.widgetConfig.type).toBe('diagram');
    expect(callLLMMock).toHaveBeenCalledTimes(1);
    expect(callLLMMock.mock.calls[0][0].system).not.toContain('Procedural Skill');
  });

  test('flag off without requirements defaults to safe false for persisted procedural-skill outlines', async () => {
    vi.resetModules();
    callLLMMock.mockResolvedValueOnce({
      text: htmlForWidget('diagram'),
    });

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(mockRequest(createProceduralSkillOutline()));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.effectiveOutline.widgetType).toBe('diagram');
    expect(body.content.widgetType).toBe('diagram');
  });

  test('flag on with effective taskEngineMode allows procedural-skill content generation', async () => {
    vi.resetModules();
    process.env[VOCATIONAL_FLAG] = '1';
    callLLMMock.mockResolvedValueOnce({
      text: htmlForWidget('procedural-skill'),
    });

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(
      mockRequest(createProceduralSkillOutline(), { taskEngineMode: true }),
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.effectiveOutline.widgetType).toBe('procedural-skill');
    expect(body.content.widgetType).toBe('procedural-skill');
    expect(body.content.widgetConfig.type).toBe('procedural-skill');
    expect(callLLMMock.mock.calls[0][0].system).toContain('Procedural Skill');
  });
});

function mockRequest(outline: SceneOutline, requirements?: { taskEngineMode?: boolean }) {
  return {
    json: async () => ({
      outline,
      allOutlines: [outline],
      stageId: 'stage-1',
      stageInfo: { name: 'Test Stage' },
      requirements,
    }),
  } as unknown as Parameters<typeof import('@/app/api/generate/scene-content/route').POST>[0];
}

function createProceduralSkillOutline(): SceneOutline {
  return {
    id: 'scene-procedural-skill',
    type: 'interactive',
    title: 'Device Calibration Practice',
    description: 'Practice a generic calibration procedure with step feedback.',
    keyPoints: ['Follow steps in order', 'Check each success criterion'],
    order: 1,
    widgetType: 'procedural-skill',
    widgetOutline: {
      concept: 'calibration procedure',
      procedureType: 'operation',
      task: 'Calibrate a training device',
      tools: ['multimeter', 'checklist'],
      steps: ['Inspect the device', 'Connect the tool', 'Confirm the reading'],
      successCriteria: ['No visible damage', 'Reading is within range'],
      errorConsequences: ['Unsafe readings require stopping and rechecking'],
    },
  };
}

function htmlForWidget(type: string): string {
  return `<!DOCTYPE html>
<html>
  <body>
    <script type="application/json" id="widget-config">
      {"type": "${type}"}
    </script>
    <main>${type} widget</main>
  </body>
</html>`;
}
