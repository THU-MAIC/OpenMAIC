import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import { resolveSceneOutline } from '@/lib/agent/client/resolve-scene-outline';
import { buildStateContext } from '@/lib/orchestration/summarizers/state-context';
import type { StatelessChatRequest } from '@/lib/types/chat';

const ReadSceneParams = Type.Object({
  sceneId: Type.String({
    minLength: 1,
    description: 'Exact sceneId from the course outline in the Director system prompt.',
  }),
});

type ReadSceneParams = Static<typeof ReadSceneParams>;

export interface ReadSceneDetails {
  status: 'ok' | 'not_found' | 'too_large';
  sceneId: string;
  title?: string;
  sceneType?: string;
  order?: number;
  revision?: string;
  source: 'request_start_snapshot';
  truncated: false;
}

export interface DirectorSceneEvidencePacket {
  content: string;
  details: ReadSceneDetails & { status: 'ok' };
}

export type DirectorSceneEvidenceMetadata = Pick<
  ReadSceneDetails,
  'sceneId' | 'title' | 'sceneType' | 'order' | 'revision' | 'source'
>;

const MAX_SCENE_EVIDENCE_CHARS = 24_000;

function buildSceneEvidence(body: StatelessChatRequest, sceneId: string): string | null {
  const scene = body.storeState.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) return null;

  const outline = resolveSceneOutline(scene, body.storeState.outlines ?? []);
  const stageWithoutWhiteboard = body.storeState.stage
    ? { ...body.storeState.stage, whiteboard: [] }
    : null;
  const sceneContext = buildStateContext({
    ...body.storeState,
    stage: stageWithoutWhiteboard,
    scenes: [scene],
    currentSceneId: scene.id,
    outlines: [outline],
    quizResults:
      body.storeState.quizResults?.sceneId === scene.id ? body.storeState.quizResults : undefined,
  });
  const outlineContext = [
    `Outline description: ${outline.description || '(none)'}`,
    `Outline key points: ${outline.keyPoints?.join('; ') || '(none)'}`,
  ].join('\n');
  const featureBoundary =
    scene.type === 'interactive' || scene.type === 'pbl'
      ? `\nContent boundary: ${scene.type} payload is not exposed by read_scene v1; only its visible outline and scene metadata are available.`
      : '';

  return `${outlineContext}\n${sceneContext}${featureBoundary}`;
}

export function buildReadSceneTool(opts: {
  body: StatelessChatRequest;
  onEvidence?: (evidence: DirectorSceneEvidencePacket) => void;
}): AgentTool<typeof ReadSceneParams, ReadSceneDetails> {
  return {
    name: 'read_scene',
    label: 'Read course scene',
    description:
      'Read one course scene by its exact sceneId before delegating a scene-dependent task. ' +
      'Returns visible scene evidence and quiz-safe context from the request-start course snapshot. ' +
      'Use the course outline to select the id; do not guess ids.',
    parameters: ReadSceneParams,
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const scene = opts.body.storeState.scenes.find(
        (candidate) => candidate.id === params.sceneId,
      );
      if (!scene) {
        return {
          content: [
            {
              type: 'text',
              text: `Scene ${JSON.stringify(params.sceneId)} was not found in the request-start course snapshot. Select an exact sceneId from the outline.`,
            },
          ],
          details: {
            status: 'not_found',
            sceneId: params.sceneId,
            source: 'request_start_snapshot',
            truncated: false,
          },
          isError: true,
        };
      }

      const evidence = buildSceneEvidence(opts.body, scene.id) ?? '';
      const revision = String(
        scene.updatedAt ?? opts.body.storeState.stage?.updatedAt ?? 'request-start',
      );
      const details: ReadSceneDetails = {
        status: evidence.length > MAX_SCENE_EVIDENCE_CHARS ? 'too_large' : 'ok',
        sceneId: scene.id,
        title: scene.title,
        sceneType: scene.type,
        order: scene.order,
        revision,
        source: 'request_start_snapshot',
        truncated: false,
      };

      if (evidence.length > MAX_SCENE_EVIDENCE_CHARS) {
        return {
          content: [
            {
              type: 'text',
              text: `Scene ${JSON.stringify(scene.id)} is too large for read_scene v1 (${evidence.length} characters). The result was not silently truncated.`,
            },
          ],
          details,
          isError: true,
        };
      }

      const content = [
        `Scene evidence (sceneId=${scene.id}, revision=${revision}, source=request_start_snapshot):`,
        evidence,
      ].join('\n');
      opts.onEvidence?.({
        content,
        details: { ...details, status: 'ok' },
      });

      return {
        content: [
          {
            type: 'text',
            text: content,
          },
        ],
        details,
      };
    },
  };
}
