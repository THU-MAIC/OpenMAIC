import { describe, expect, it, vi } from 'vitest';
import {
  regenerateCodeSceneContent,
  type CodeSceneRegenerationDeps,
} from '@/lib/interactive/regenerate-code-scene';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene, ScenePatch, Stage, StageMode } from '@/lib/types/stage';

const stage: Stage = {
  id: 'stage-1',
  name: 'MLE course',
  description: 'Practice maximum-likelihood estimation',
  languageDirective: 'Write learner-facing text in Korean.',
  createdAt: 1,
  updatedAt: 1,
};

const outline: SceneOutline = {
  id: 'outline-code',
  type: 'interactive',
  title: 'Normal MLE coding',
  description: 'Implement the normal-distribution MLE.',
  keyPoints: ['log likelihood', 'mean', 'variance'],
  order: 3,
  widgetType: 'code',
  widgetOutline: { language: 'python' },
};

const codeScene: Scene = {
  id: 'scene-code',
  stageId: stage.id,
  outlineId: outline.id,
  type: 'interactive',
  title: outline.title,
  order: outline.order,
  actions: [{ id: 'speech-1', type: 'speech', text: 'Keep this narration.' }],
  content: {
    type: 'interactive',
    widgetType: 'code',
    html: '<html><body>old code</body></html>',
  },
};

function harness(overrides: Partial<CodeSceneRegenerationDeps> = {}) {
  type HarnessState = {
    stage: Stage | null;
    scenes: Scene[];
    outlines: SceneOutline[];
    generationEpoch: number;
    mode: StageMode;
    currentSceneId: string | null;
    isOwner: boolean;
    readOnly: boolean;
    updateScene: (sceneId: string, patch: ScenePatch) => void;
  };
  let state: HarnessState = {
    stage,
    scenes: [codeScene],
    outlines: [outline],
    generationEpoch: 4,
    mode: 'playback',
    currentSceneId: codeScene.id,
    isOwner: true,
    readOnly: false,
    updateScene: vi.fn(),
  };
  const fetchContent = vi.fn().mockResolvedValue({
    success: true,
    content: {
      html: '<html><body>new code</body></html>',
      widgetType: 'code',
    },
  });
  const deps = {
    getState: () => state,
    fetchContent,
    listAgents: () => [],
    ...overrides,
  } as unknown as CodeSceneRegenerationDeps;
  return {
    deps,
    fetchContent,
    updateScene: state.updateScene,
    setState: (next: typeof state) => {
      state = next;
    },
    getState: () => state,
  };
}

describe('regenerateCodeSceneContent', () => {
  it('regenerates only interactive code content from the persisted outline', async () => {
    const h = harness();

    await expect(regenerateCodeSceneContent(codeScene.id, h.deps)).resolves.toEqual({ ok: true });

    expect(h.fetchContent).toHaveBeenCalledWith(
      expect.objectContaining({
        outline,
        allOutlines: [outline],
        stageId: stage.id,
        languageDirective: stage.languageDirective,
      }),
    );
    expect(h.updateScene).toHaveBeenCalledWith(codeScene.id, {
      content: {
        type: 'interactive',
        url: '',
        widgetType: 'code',
        html: '<html><body>new code</body></html>',
      },
    });
  });

  it('drops a late response after the classroom generation epoch changes', async () => {
    const h = harness();
    h.fetchContent.mockImplementation(async () => {
      h.setState({ ...h.getState(), generationEpoch: 5 });
      return {
        success: true,
        content: { html: '<html><body>stale</body></html>', widgetType: 'code' },
      };
    });

    await expect(regenerateCodeSceneContent(codeScene.id, h.deps)).resolves.toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(h.updateScene).not.toHaveBeenCalled();
  });

  it('refuses to overwrite the current scene while it is edit-locked', async () => {
    const h = harness();
    h.setState({ ...h.getState(), mode: 'edit' });

    await expect(regenerateCodeSceneContent(codeScene.id, h.deps)).resolves.toEqual({
      ok: false,
      reason: 'locked',
    });
    expect(h.fetchContent).not.toHaveBeenCalled();
  });

  it('refuses regeneration for a read-only classroom even when called outside the UI', async () => {
    const h = harness();
    h.setState({ ...h.getState(), readOnly: true });

    await expect(regenerateCodeSceneContent(codeScene.id, h.deps)).resolves.toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(h.fetchContent).not.toHaveBeenCalled();
  });
});
