import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/lib/logger';
import type { SceneOutline } from '@/lib/types/generation';
import { legacyPBLSceneFixture } from '@/tests/fixtures/pbl-v1-scene';

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  applyOutlineFallbacks: vi.fn(),
  generateSceneContent: vi.fn(),
  generateSceneActions: vi.fn(),
  buildCompleteScene: vi.fn(),
  buildVisionUserContent: vi.fn(),
  resolveVocationalActive: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
}));

vi.mock('@/lib/config/feature-flags', () => ({
  resolveVocationalActive: mocks.resolveVocationalActive,
}));

vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
  applyOutlineFallbacks: mocks.applyOutlineFallbacks,
  generateSceneContent: mocks.generateSceneContent,
  generateSceneActions: mocks.generateSceneActions,
  buildCompleteScene: mocks.buildCompleteScene,
  buildVisionUserContent: mocks.buildVisionUserContent,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: 'Retry Boundary',
  description: 'Keep retries controlled by the outer scene retry helper.',
  keyPoints: ['no retry multiplication'],
  order: 1,
} as SceneOutline;

const pblOutline = {
  id: 'outline-pbl-1',
  type: 'pbl',
  title: legacyPBLSceneFixture.title,
  description: 'Continue a stored legacy PBL project.',
  keyPoints: ['garden measurements'],
  order: 1,
  pblConfig: {
    projectTopic: legacyPBLSceneFixture.title,
    projectDescription: 'Continue a stored legacy PBL project.',
    targetSkills: ['data analysis'],
    issueCount: 2,
  },
} as SceneOutline;

describe('scene step retry boundary', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.applyOutlineFallbacks.mockImplementation((value) => value);
    mocks.callLLM.mockResolvedValue({ text: 'ok' });
    mocks.resolveVocationalActive.mockReturnValue(false);
  });

  it('disables AI SDK retries for scene-content model calls', async () => {
    vi.resetModules();
    mocks.generateSceneContent.mockImplementation(async (_outline, aiCall) => {
      await aiCall('system', 'user');
      return { elements: [], remark: 'ok' };
    });

    await generateContent();

    expect(mocks.callLLM.mock.calls[0][0].maxRetries).toBe(0);
  });

  it('disables AI SDK retries for scene-actions model calls', async () => {
    vi.resetModules();
    mocks.generateSceneActions.mockImplementation(async (_outline, _content, aiCall) => {
      await aiCall('system', 'user');
      return [];
    });
    mocks.buildCompleteScene.mockReturnValue({
      id: 'scene-1',
      type: 'slide',
      title: outline.title,
      order: outline.order,
      content: { elements: [], remark: 'ok' },
      actions: [],
    });

    await generateActions({ content: { elements: [], remark: 'ok' } });

    expect(mocks.callLLM.mock.calls[0][0].maxRetries).toBe(0);
  });

  it('normalizes stored legacy PBL content before generating actions and building the scene', async () => {
    vi.resetModules();
    mocks.generateSceneActions.mockImplementation(async (_outline, content, aiCall) => {
      await aiCall('system', 'user');
      return 'projectV2' in content
        ? [{ id: 'action-1', type: 'speech', title: 'Welcome', text: 'Let us continue.' }]
        : [];
    });
    mocks.buildCompleteScene.mockImplementation((_outline, content, actions, stageId) => {
      if (!('projectV2' in content)) return null;
      return {
        id: 'scene-pbl-1',
        stageId,
        type: 'pbl',
        title: pblOutline.title,
        order: pblOutline.order,
        content: { type: 'pbl', projectV2: content.projectV2 },
        actions,
      };
    });

    const body = await generateActions({
      outline: pblOutline,
      allOutlines: [pblOutline],
      content: structuredClone(legacyPBLSceneFixture.content),
    });

    expect(body.scene.actions).toHaveLength(1);
    expect(mocks.generateSceneActions.mock.calls[0][1]).toMatchObject({
      type: 'pbl',
      projectV2: { title: legacyPBLSceneFixture.title },
    });
    expect(mocks.buildCompleteScene.mock.calls[0][1]).toBe(
      mocks.generateSceneActions.mock.calls[0][1],
    );
  });

  it('builds damaged hybrid PBL content from the upgraded legacy project', async () => {
    vi.resetModules();
    mocks.generateSceneActions.mockResolvedValue([
      { id: 'action-1', type: 'speech', title: 'Welcome', text: 'Let us continue.' },
    ]);
    mocks.buildCompleteScene.mockImplementation((_outline, content, actions, stageId) => {
      if (!('projectV2' in content)) return null;
      return {
        id: 'scene-pbl-1',
        stageId,
        type: 'pbl',
        title: pblOutline.title,
        order: pblOutline.order,
        content: { type: 'pbl', projectV2: content.projectV2 },
        actions,
      };
    });
    const damagedHybrid = structuredClone(legacyPBLSceneFixture.content);
    Reflect.set(damagedHybrid, 'projectV2', { title: 'broken' });

    const body = await generateActions({
      outline: pblOutline,
      allOutlines: [pblOutline],
      content: damagedHybrid,
    });

    expect((body.scene.content as { projectV2?: unknown }).projectV2).toMatchObject({
      title: 'Community Garden Data Project',
      milestones: [{ title: 'Inspect the measurements' }, { title: 'Recommend a watering plan' }],
    });
    expect((body.scene.content as { projectV2?: unknown }).projectV2).not.toEqual({
      title: 'broken',
    });
    expect(mocks.buildCompleteScene.mock.calls[0][1]).toBe(
      mocks.generateSceneActions.mock.calls[0][1],
    );
  });

  it('keeps a title-only legacy shell on the empty-content refusal', async () => {
    vi.resetModules();
    mocks.generateSceneActions.mockResolvedValue([]);
    mocks.buildCompleteScene.mockImplementation((_outline, content) =>
      'projectV2' in content ? { content } : null,
    );
    const legacyContent = structuredClone(legacyPBLSceneFixture.content);
    if (legacyContent.type !== 'pbl' || !legacyContent.projectConfig) {
      throw new Error('expected legacy PBL content');
    }
    const projectConfig = legacyContent.projectConfig;
    projectConfig.agents = [];
    projectConfig.issueboard.issues = [];
    projectConfig.issueboard.current_issue_id = null;
    projectConfig.chat.messages = [];
    projectConfig.selectedRole = null;

    await expect(
      generateActions({
        outline: pblOutline,
        allOutlines: [pblOutline],
        content: { type: 'pbl', projectConfig },
      }),
    ).rejects.toMatchObject({
      name: 'StepRefusal',
      message: 'Failed to build scene: Community Garden Data Project',
    });
    expect(mocks.generateSceneActions.mock.calls[0][1]).toEqual({ type: 'pbl', projectConfig });
  });
});

const model = {
  model: { id: 'language-model' },
  modelInfo: { outputWindow: 4096, capabilities: {} },
  modelString: 'test:model',
  thinkingConfig: undefined,
} as never;

/** Generate the outline's content as a run does. */
async function generateContent() {
  const { generateSceneContent } = await import('@/lib/server/generation/steps/scene-content');
  return generateSceneContent(
    { outline, targetLanguage: '', model },
    { log: createLogger('Scene Content'), resolveVisionImages: async (images) => [...images] },
  );
}

/** Generate a scene's actions as a run does. */
async function generateActions(input: {
  content: unknown;
  outline?: SceneOutline;
  allOutlines?: SceneOutline[];
}) {
  const { generateSceneActions } = await import('@/lib/server/generation/steps/scene-actions');
  return generateSceneActions(
    {
      outline: input.outline ?? outline,
      allOutlines: input.allOutlines ?? [outline],
      content: input.content as never,
      stageId: 'stage-1',
      model,
    },
    { log: createLogger('Scene Actions') },
  );
}
