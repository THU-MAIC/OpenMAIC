import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createLogger } from '@/lib/logger';
import type { SceneOutline, UserRequirements } from '@/lib/types/generation';

const callLLMMock = vi.hoisted(() => vi.fn());
const resolveModelMock = vi.hoisted(() => vi.fn());
const VOCATIONAL_FLAG = 'OPENMAIC_ENABLE_VOCATIONAL';
let originalVocationalFlag: string | undefined;

vi.mock('@/lib/ai/llm', () => ({
  callLLM: callLLMMock,
}));

describe('scene content step vocational gate', () => {
  beforeEach(() => {
    originalVocationalFlag = process.env[VOCATIONAL_FLAG];
    delete process.env[VOCATIONAL_FLAG];
    callLLMMock.mockReset();
    resolveModelMock.mockReset();
    resolveModelMock.mockResolvedValue({
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

    const body = await generate(createProceduralSkillOutline(), { taskEngineMode: true });

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

    const body = await generate(createProceduralSkillOutline());

    expect(body.effectiveOutline.widgetType).toBe('diagram');
    expect(body.content.widgetType).toBe('diagram');
  });

  test('flag on with effective taskEngineMode allows procedural-skill content generation', async () => {
    vi.resetModules();
    process.env[VOCATIONAL_FLAG] = '1';
    callLLMMock.mockResolvedValueOnce({
      text: htmlForWidget('procedural-skill'),
    });

    const body = await generate(createProceduralSkillOutline(), { taskEngineMode: true });

    expect(body.effectiveOutline.widgetType).toBe('procedural-skill');
    expect(body.content.widgetType).toBe('procedural-skill');
    expect(body.content.widgetConfig.type).toBe('procedural-skill');
    expect(callLLMMock.mock.calls[0][0].system).toContain('Procedural Skill');
  });
});

/** Generate one scene's content as a run does, with the stubbed model. */
async function generate(outline: SceneOutline, requirements?: Partial<UserRequirements>) {
  const { generateSceneContent } = await import('@/lib/server/generation/steps/scene-content');
  const result = await generateSceneContent(
    {
      outline,
      requirements: requirements as UserRequirements | undefined,
      targetLanguage: '',
      model: await resolveModelMock(),
    },
    { log: createLogger('Scene Content'), resolveVisionImages: async (images) => [...images] },
  );
  // The assertions read the generated content as the JSON it is.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return result as { content: any; effectiveOutline: any };
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
