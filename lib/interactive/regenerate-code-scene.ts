import type { AgentInfo } from '@openmaic/generation';
import { fetchSceneContent } from '@/lib/hooks/use-scene-generator';
import { isSceneEditLocked } from '@/lib/edit/regen-lock';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { useStageStore } from '@/lib/store/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type { InteractiveContent, Scene, ScenePatch, Stage, StageMode } from '@/lib/types/stage';

export type CodeSceneRegenerationResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'not-code'
        | 'forbidden'
        | 'locked'
        | 'missing-outline'
        | 'generation-failed'
        | 'stale';
      message?: string;
    };

interface CodeSceneRegenerationState {
  readonly stage: Stage | null;
  readonly scenes: Scene[];
  readonly outlines: SceneOutline[];
  readonly generationEpoch: number;
  readonly mode: StageMode;
  readonly currentSceneId: string | null;
  readonly isOwner: boolean;
  readonly readOnly: boolean;
  updateScene: (sceneId: string, updates: ScenePatch) => void;
}

export interface CodeSceneRegenerationDeps {
  getState: () => CodeSceneRegenerationState;
  fetchContent: typeof fetchSceneContent;
  listAgents: () => AgentInfo[];
}

const defaultDeps: CodeSceneRegenerationDeps = {
  getState: () => useStageStore.getState(),
  fetchContent: fetchSceneContent,
  listAgents: () => useAgentRegistry.getState().listAgents(),
};

function findSourceOutline(scene: Scene, outlines: SceneOutline[]): SceneOutline | undefined {
  if (scene.outlineId) {
    const exact = outlines.find((outline) => outline.id === scene.outlineId);
    if (exact) return exact;
  }
  return outlines.find((outline) => outline.order === scene.order);
}

function asGeneratedCodeContent(value: unknown): InteractiveContent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const generated = value as Record<string, unknown>;
  if (typeof generated.html !== 'string' || generated.html.trim() === '') return null;
  if (generated.widgetType !== undefined && generated.widgetType !== 'code') return null;

  const widgetConfig = generated.widgetConfig;
  const validWidgetConfig =
    typeof widgetConfig === 'object' &&
    widgetConfig !== null &&
    !Array.isArray(widgetConfig) &&
    (widgetConfig as Record<string, unknown>).type === 'code';

  return {
    type: 'interactive',
    url: '',
    html: generated.html,
    widgetType: 'code',
    ...(validWidgetConfig
      ? { widgetConfig: widgetConfig as NonNullable<InteractiveContent['widgetConfig']> }
      : {}),
  };
}

/**
 * Regenerate only a code widget's interactive content.
 *
 * Narration/actions and the scene id stay untouched. The source outline is
 * resolved by stable outlineId first, with order retained only for legacy
 * classrooms. A stage switch, generation-epoch change, or scene edit drops the late result.
 */
export async function regenerateCodeSceneContent(
  sceneId: string,
  deps: CodeSceneRegenerationDeps = defaultDeps,
): Promise<CodeSceneRegenerationResult> {
  const before = deps.getState();
  const scene = before.scenes.find((candidate) => candidate.id === sceneId);
  if (
    !scene ||
    scene.content.type !== 'interactive' ||
    scene.content.widgetType !== 'code' ||
    !before.stage
  ) {
    return { ok: false, reason: 'not-code' };
  }
  if (!before.isOwner || before.readOnly) return { ok: false, reason: 'forbidden' };
  if (
    isSceneEditLocked({
      sceneId,
      mode: before.mode,
      currentSceneId: before.currentSceneId,
    })
  ) {
    return { ok: false, reason: 'locked' };
  }

  const outline = findSourceOutline(scene, before.outlines);
  if (!outline) return { ok: false, reason: 'missing-outline' };

  const stageId = before.stage.id;
  const generationEpoch = before.generationEpoch;
  const result = await deps.fetchContent({
    outline,
    allOutlines: before.outlines,
    stageId,
    stageInfo: {
      name: before.stage.name,
      description: before.stage.description,
      style: before.stage.style,
    },
    agents: deps.listAgents(),
    languageDirective: before.stage.languageDirective,
  });
  const content = result.success ? asGeneratedCodeContent(result.content) : null;
  if (!content) {
    return {
      ok: false,
      reason: 'generation-failed',
      message: result.error,
    };
  }

  const after = deps.getState();
  if (
    after.stage?.id !== stageId ||
    after.generationEpoch !== generationEpoch ||
    after.scenes.find((candidate) => candidate.id === sceneId) !== scene
  ) {
    return { ok: false, reason: 'stale' };
  }

  after.updateScene(sceneId, { content });
  return { ok: true };
}
