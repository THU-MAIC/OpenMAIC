import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { isActionType } from '@openmaic/dsl';
import {
  buildCompleteScene,
  generateSceneActions,
  generateSceneContent,
  PBLGenerationError,
  type AICallFn,
  type ImageMapping,
  type PdfImage,
  type SceneGenerationContext,
} from '@openmaic/generation';

import { putSceneBringingCurrent } from './document-writes';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import type { SceneOutline } from '@/lib/types/generation';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import { COURSE_STAGE_ID_DESCRIPTION } from './course-stage';
import type { CourseToolDeps } from './course-tools';
import { runStageMutation } from './mutation-fence';
import { shiftCourseOrders } from './course-edit/tools';
import { createGenerationAiCallFactory, sceneContentStage } from './generation-ai-call';
import { synthesizeSceneNarration } from './scene-tts';
import { toGenerationContent } from './generation-content';
import { checkScenesAgainstSkill } from './skills';
import { isMediaPlaceholder } from '@/lib/store/media-generation';

const MAX_GENERATE_SCENE_MEDIA = 8;
const SUPPORTED_SCENE_TYPES = new Set(['slide', 'quiz', 'interactive', 'pbl']);

const SceneParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  order: Type.Integer({ minimum: 1 }),
  title: Type.String({ minLength: 1 }),
  type: Type.Union([
    Type.Literal('slide'),
    Type.Literal('quiz'),
    Type.Literal('interactive'),
    Type.Literal('pbl'),
  ]),
  brief: Type.String({ minLength: 1 }),
  instruction: Type.Optional(Type.String()),
  materialFacts: Type.Optional(Type.Array(Type.String())),
  media: Type.Optional(
    Type.Array(
      Type.Object({
        src: Type.String({ minLength: 1 }),
        description: Type.String({ minLength: 1 }),
        width: Type.Optional(Type.Number({ minimum: 1 })),
        height: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      { maxItems: 8 },
    ),
  ),
});
const ListParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
});
const ActionsParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  sceneId: Type.Optional(Type.String()),
  order: Type.Optional(Type.Integer({ minimum: 1 })),
  styleDirective: Type.Optional(Type.String()),
  synthesizeAudio: Type.Optional(Type.Boolean()),
});
const DuplicateParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  templateSceneId: Type.Optional(Type.String()),
  templateOrder: Type.Optional(Type.Integer({ minimum: 1 })),
  targetOrder: Type.Integer({ minimum: 1 }),
  title: Type.Optional(Type.String()),
});

type ActionGenerator = typeof generateSceneActions;

export interface GenerationToolDeps extends CourseToolDeps {
  aiCall?: AICallFn;
  generateActions?: ActionGenerator;
}

function sceneIdFor(scenes: readonly Scene[], order: number) {
  const preferred = `scene-p${order}`;
  const taken = new Set(scenes.map((scene) => scene.id));
  if (!taken.has(preferred)) return preferred;
  let suffix = 2;
  while (taken.has(`${preferred}-${suffix}`)) suffix += 1;
  return `${preferred}-${suffix}`;
}

function duplicateId(sessionId: string | undefined, callId: string) {
  const hash = createHash('sha256')
    .update(`${sessionId ?? ''}\0${callId}`)
    .digest('hex')
    .slice(0, 16);
  return `scene-dup-${hash}`;
}

function result(text: string, details: Record<string, unknown>, isError = false) {
  return { content: [{ type: 'text' as const, text }], details, ...(isError ? { isError } : {}) };
}

function outlineFromScene(scene: Scene, snapshot: unknown): SceneOutline {
  const planned = (snapshot as AppDocumentOutline | undefined)?.outlines?.find(
    (entry) => entry.id === scene.outlineId || entry.order === scene.order,
  );
  return {
    ...planned,
    id: scene.outlineId ?? scene.id,
    order: scene.order,
    title: scene.title,
    type: scene.type as SceneOutline['type'],
    description: planned?.description ?? scene.title,
    keyPoints: planned?.keyPoints ?? [],
  };
}

function concreteMediaSrc(src: string): boolean {
  if (src.startsWith('/') && !src.startsWith('//')) return src.length > 1 && !/\s/.test(src);
  if (!/^https?:\/\//i.test(src)) return false;
  try {
    const url = new URL(src);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export interface UnresolvedMediaPlaceholder {
  elementId: string;
  type: 'image' | 'video';
  placeholder: string;
}

/** Find slide media elements that would still render as skeletons. */
export function collectUnresolvedMediaPlaceholders(scene: Scene): UnresolvedMediaPlaceholder[] {
  if (scene.type !== 'slide') return [];
  const placeholders: UnresolvedMediaPlaceholder[] = [];
  for (const element of scene.content.canvas.elements) {
    const candidate = element as unknown as {
      id?: string;
      type?: string;
      src?: string;
      mediaRef?: string;
    };
    if (!candidate.id) continue;
    if (candidate.type === 'image' && candidate.src && isMediaPlaceholder(candidate.src)) {
      placeholders.push({
        elementId: candidate.id,
        type: 'image',
        placeholder: candidate.src,
      });
    }
    if (
      candidate.type === 'video' &&
      (!candidate.src ||
        isMediaPlaceholder(candidate.src) ||
        (candidate.mediaRef ? isMediaPlaceholder(candidate.mediaRef) : false))
    ) {
      placeholders.push({
        elementId: candidate.id,
        type: 'video',
        placeholder:
          (candidate.src && isMediaPlaceholder(candidate.src) ? candidate.src : undefined) ??
          (candidate.mediaRef && isMediaPlaceholder(candidate.mediaRef)
            ? candidate.mediaRef
            : undefined) ??
          candidate.mediaRef ??
          '',
      });
    }
  }
  return placeholders;
}

function actionContext(scenes: readonly Scene[], current: Scene): SceneGenerationContext {
  const ordered = [...scenes].sort((a, b) => a.order - b.order);
  const index = ordered.findIndex((scene) => scene.id === current.id);
  const previous = index > 0 ? ordered[index - 1] : undefined;
  return {
    pageIndex: Math.max(0, index) + 1,
    totalPages: ordered.length,
    allTitles: ordered.map((scene) => scene.title),
    previousSpeeches: (previous?.actions ?? [])
      .filter((action) => action.type === 'speech')
      .map((action) => action.text)
      .filter(Boolean)
      .slice(-3),
  };
}

/** Drop action names unknown to the current DSL before they reach persistence. */
export function filterKnownActions(actions: readonly Action[]): Action[] {
  return actions.filter((action) => isActionType(action.type));
}

export function buildGenerationTools(deps: GenerationToolDeps): AgentTool<never, never>[] {
  const routed = createGenerationAiCallFactory({ abortSignal: deps.abortSignal });
  const aiCallFor = (stage: Parameters<typeof routed>[0]) => deps.aiCall ?? routed(stage);
  const actionGenerator = deps.generateActions ?? generateSceneActions;

  const generateScene: AgentTool<typeof SceneParams> = {
    name: 'generate_scene',
    label: 'Generate page',
    description:
      'Generate and durably persist one page from an explicit title, type, and brief. Reusing an order replaces that page.',
    parameters: SceneParams,
    async execute(_callId, params, signal) {
      if (!Number.isInteger(params.order) || params.order < 1) {
        return result(
          'generate_scene needs a 1-based integer page order.',
          {
            error: 'invalid-order',
          },
          true,
        );
      }
      const doc = await deps.store.loadDocument(params.stageId);
      if (!doc) return result('No course document yet. Call create_stage first.', {}, true);
      const existing = doc.scenes.find((scene) => scene.order === params.order);
      const title = params.title.trim();
      const brief = params.brief.trim();
      if (!title || !brief) {
        return result(
          'generate_scene needs a non-empty title and brief.',
          {
            error: 'missing-title-or-brief',
          },
          true,
        );
      }
      if (existing && !SUPPORTED_SCENE_TYPES.has(existing.type)) {
        return result(
          `Page ${params.order} has unsupported type "${existing.type}" and was left unchanged.`,
          { blocked: 'unsupported-type', sceneId: existing.id, type: existing.type },
          true,
        );
      }
      if (existing?.type === 'pbl' && params.type !== 'pbl') {
        return result(
          'The existing page is a PBL project. Delete it first or regenerate it as pbl; changing its type here would destroy the project.',
          { blocked: 'pbl-type-change', sceneId: existing.id, type: existing.type },
          true,
        );
      }
      if (params.instruction && params.type === 'pbl') {
        return result(
          'generate_scene cannot apply an instruction to a PBL page because the planner would drop it. Use patch_stage for a fine edit or regenerate without instruction.',
          { blocked: 'pbl-instruction-not-supported', sceneId: existing?.id },
          true,
        );
      }
      const requestedMedia = params.media ?? [];
      if (requestedMedia.length > MAX_GENERATE_SCENE_MEDIA) {
        return result(
          `generate_scene accepts at most ${MAX_GENERATE_SCENE_MEDIA} media items.`,
          { error: 'too-many-media', maxItems: MAX_GENERATE_SCENE_MEDIA },
          true,
        );
      }
      const outline: SceneOutline = {
        id: existing?.outlineId ?? `p${params.order}`,
        order: params.order,
        title,
        type: params.type,
        description: brief,
        keyPoints: params.materialFacts ?? [],
        ...(params.type === 'pbl'
          ? {
              pblConfig: {
                projectTopic: params.title.trim(),
                projectDescription: params.brief.trim(),
                targetSkills: params.materialFacts ?? [],
              },
            }
          : {}),
      };
      const baseline =
        params.instruction && existing?.type === 'slide'
          ? {
              elements: existing.content.canvas.elements,
              background: existing.content.canvas.background,
            }
          : undefined;
      const assignedImages: PdfImage[] = [];
      const imageMapping: ImageMapping = {};
      for (const [index, media] of (params.media ?? []).entries()) {
        const src = media.src.trim();
        const description = media.description.trim();
        if (!description) {
          return result(
            'Every media item needs a non-empty description.',
            {
              error: 'invalid-media-description',
              index,
            },
            true,
          );
        }
        if (isMediaPlaceholder(src) || !concreteMediaSrc(src)) {
          return result(
            'Every media item needs a concrete HTTP(S) URL or same-origin path, not a placeholder or data URL.',
            {
              error: isMediaPlaceholder(src) ? 'media-placeholder-src' : 'invalid-media-src',
              index,
            },
            true,
          );
        }
        const id = `img_${index + 1}`;
        assignedImages.push({
          id,
          src,
          description,
          pageNumber: index + 1,
          sourceDocumentName: 'page media input',
          ...(media.width ? { width: media.width } : {}),
          ...(media.height ? { height: media.height } : {}),
        });
        imageMapping[id] = src;
      }
      const agents = doc.stage.generatedAgentConfigs;
      let content: Awaited<ReturnType<typeof generateSceneContent>>;
      try {
        content = await generateSceneContent(outline, aiCallFor(sceneContentStage(params.type)), {
          agents,
          languageDirective: doc.stage.languageDirective ?? '',
          allowProceduralSkill: true,
          ...(assignedImages.length ? { assignedImages, imageMapping } : {}),
          ...(params.instruction ? { editDirective: params.instruction } : {}),
          ...(baseline ? { baselineContent: baseline } : {}),
        });
      } catch (error) {
        if (error instanceof PBLGenerationError) {
          return result(
            `PBL generation failed and nothing was written. ${error.message}`,
            {
              error: 'pbl-planner-failed',
              order: params.order,
              title,
              sceneId: existing?.id,
              ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
              cause: error.message,
            },
            true,
          );
        }
        throw error;
      }
      if (signal?.aborted) throw new Error('aborted');
      if (!content) return result('Page content generation failed; nothing was written.', {}, true);
      const actions = filterKnownActions(
        await actionGenerator(outline, content, aiCallFor('scene-actions'), {
          agents,
          languageDirective: doc.stage.languageDirective ?? '',
        }),
      );
      const built = buildCompleteScene(outline, content, actions, params.stageId, {
        sceneId: existing?.id ?? sceneIdFor(doc.scenes, params.order),
      });
      if (!built) return result('Page assembly failed; nothing was written.', {}, true);
      const scene = built as Scene;
      await runStageMutation(signal, () =>
        putSceneBringingCurrent(deps.store, params.stageId, scene),
      );
      const skill = deps.getActiveSkill?.() ?? null;
      const afterWrite = await deps.store.loadDocument(params.stageId);
      const skillViolations =
        skill && afterWrite ? checkScenesAgainstSkill(afterWrite.scenes, skill.constraints) : [];
      const persisted = afterWrite?.scenes.find((item) => item.id === scene.id) ?? scene;
      const mediaPlaceholders = collectUnresolvedMediaPlaceholders(persisted);
      deps.onCheckpoint({
        tool: 'generate_scene',
        stageId: params.stageId,
        sceneId: scene.id,
        order: scene.order,
        title: scene.title,
        sceneType: scene.type,
        skill: skill?.id,
        ...(skillViolations.length ? { skillViolations } : {}),
        detail: `page ${scene.order} persisted`,
      });
      return result(
        `Page ${scene.order} "${scene.title}" persisted.${
          skillViolations.length
            ? ` SKILL CONSTRAINT CHECK against "${skill?.id}": ${skillViolations.join('; ')}.`
            : ''
        }${
          mediaPlaceholders.length
            ? ` ${mediaPlaceholders.length} media placeholder(s) still render as skeletons.`
            : ''
        }`,
        {
          sceneId: scene.id,
          order: scene.order,
          type: scene.type,
          actionCount: actions.length,
          skill: skill?.id,
          ...(skillViolations.length ? { skillViolations } : {}),
          ...(mediaPlaceholders.length ? { mediaPlaceholders } : {}),
        },
      );
    },
  };

  const listScenes: AgentTool<typeof ListParams> = {
    name: 'list_scenes',
    label: 'List pages',
    description: 'List the pages currently persisted in a stage.',
    parameters: ListParams,
    async execute(_callId, params) {
      const doc = await deps.store.loadDocument(params.stageId);
      const pages = [...(doc?.scenes ?? [])]
        .sort((a, b) => a.order - b.order)
        .map(({ id, order, title, type }) => ({ id, order, title, type }));
      return result(`Persisted pages: ${pages.length}.`, { pageCount: pages.length, pages });
    },
  };

  const generateActionsTool: AgentTool<typeof ActionsParams> = {
    name: 'generate_actions',
    label: 'Generate page actions',
    description:
      'Regenerate playback actions for one persisted page, optionally backfilling narration audio.',
    parameters: ActionsParams,
    async execute(_callId, params, signal) {
      const doc = await deps.store.loadDocument(params.stageId);
      const scene = params.sceneId
        ? doc?.scenes.find((item) => item.id === params.sceneId)
        : doc?.scenes.find((item) => item.order === params.order);
      if (!doc || !scene) return result('Page not found. Call list_scenes.', {}, true);
      const outline = outlineFromScene(scene, doc.outline);
      const actions = filterKnownActions(
        await actionGenerator(
          outline,
          toGenerationContent(scene.content),
          aiCallFor('scene-actions'),
          {
            ctx: actionContext(doc.scenes, scene),
            agents: doc.stage.generatedAgentConfigs,
            languageDirective: doc.stage.languageDirective ?? '',
            userProfile: params.styleDirective,
          },
        ),
      );
      if (!actions.length)
        return result('No known actions were generated; the page was unchanged.', {}, true);
      const next = { ...scene, actions } as Scene;
      await runStageMutation(signal, () =>
        putSceneBringingCurrent(deps.store, params.stageId, next),
      );
      deps.onCheckpoint({
        tool: 'generate_actions',
        stageId: params.stageId,
        sceneId: scene.id,
        order: scene.order,
        detail: `${actions.length} actions persisted`,
      });
      let audio;
      if (params.synthesizeAudio !== false) {
        audio = await (deps.synthesizeTts ?? synthesizeSceneNarration)({
          scene: next,
          force: false,
          roster: doc.stage.generatedAgentConfigs,
          signal,
        });
        if (audio.changed) {
          await runStageMutation(signal, () =>
            putSceneBringingCurrent(deps.store, params.stageId, next),
          );
          deps.onCheckpoint({
            tool: 'generate_actions',
            stageId: params.stageId,
            sceneId: scene.id,
            order: scene.order,
            detail: 'narration audio persisted',
          });
        }
      }
      return result(`Persisted ${actions.length} known actions for "${scene.title}".`, {
        sceneId: scene.id,
        actions,
        ...(audio ? { audio } : {}),
      });
    },
  };

  const duplicateScene: AgentTool<typeof DuplicateParams> = {
    name: 'duplicate_scene',
    label: 'Duplicate page',
    description:
      'Copy an existing page to a new position without actions. Replaying the same tool call is idempotent.',
    parameters: DuplicateParams,
    async execute(callId, params, signal) {
      const doc = await deps.store.loadDocument(params.stageId);
      if (!doc) return result('No course document yet. Call create_stage first.', {}, true);
      const scenes = [...doc.scenes].sort((a, b) => a.order - b.order);
      const id = duplicateId(deps.sessionId, callId);
      const replay = scenes.find((scene) => scene.id === id);
      if (replay)
        return result('This page was already duplicated. Nothing changed.', {
          sceneId: id,
          order: replay.order,
          replay: true,
        });
      const template = params.templateSceneId
        ? scenes.find((scene) => scene.id === params.templateSceneId)
        : scenes.find((scene) => scene.order === params.templateOrder);
      if (!template) return result('Template page not found.', {}, true);
      const at = Math.min(params.targetOrder, scenes.length + 1);
      const shifted = shiftCourseOrders(
        scenes,
        doc.outline as AppDocumentOutline | undefined,
        at,
        1,
      );
      const now = Date.now();
      const created = {
        ...structuredClone(template),
        id,
        outlineId: id,
        stageId: params.stageId,
        order: at,
        title: params.title?.trim() || template.title,
        actions: [],
        createdAt: now,
        updatedAt: now,
      } as Scene;
      await runStageMutation(signal, () =>
        deps.store.saveDocument({
          ...doc,
          scenes: [...shifted.scenes, created].sort((a, b) => a.order - b.order),
          outline: shifted.outline,
        }),
      );
      deps.onCheckpoint({
        tool: 'duplicate_scene',
        stageId: params.stageId,
        sceneId: id,
        order: at,
        detail: `duplicated ${template.id}`,
      });
      return result(`Duplicated "${template.title}" at order ${at}.`, { sceneId: id, order: at });
    },
  };

  return [generateScene, listScenes, generateActionsTool, duplicateScene] as unknown as AgentTool<
    never,
    never
  >[];
}

export const GENERATION_TOOL_NAMES = [
  'generate_scene',
  'list_scenes',
  'generate_actions',
  'duplicate_scene',
] as const;
