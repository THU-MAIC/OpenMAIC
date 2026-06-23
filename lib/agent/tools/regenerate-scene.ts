/**
 * `regenerate_scene` agent tool
 *
 * Regenerates a whole SLIDE — its content (elements/layout/text) AND its
 * playback actions (narration/cues) — to match a natural-language instruction.
 * Mirrors `generateSingleScene`'s two steps directly:
 *   generateSceneContent (EDIT MODE) → generateSceneActions
 * (NOT `generateFullScenes`, which writes into a StageStore).
 *
 * Trust boundary (carries the v0 rule): the model supplies only `sceneId` +
 * `instruction`. The slide's current content/outline come from the trusted
 * client-injected `SceneContext` (`getSceneContext`) and are fed as the edit
 * baseline — the model never authors content.
 *
 * slide-only this release: non-slide scenes get a typed refusal and nothing is
 * generated.
 *
 * Returns `{ sceneId, content, actions }` in `details`; the client reads
 * `tool_execution_end`, snapshots the pre-state, and applies content+actions.
 */

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { generateSceneContent, generateSceneActions } from '@/lib/generation/scene-generator';
import type { SceneGenerationContext } from '@/lib/generation/generation-pipeline';
import type { Action } from '@/lib/types/action';
import type { GeneratedSlideContent, PdfImage, ImageMapping } from '@/lib/types/generation';
import type { SceneContent } from '@/lib/types/stage';
import type { RegenerateActionsDeps, SceneContext } from './regenerate-scene-actions';

// ── Runtime SlideContent → generation GeneratedSlideContent (edit baseline) ──
// The client sends runtime `SceneContent` ({ type:'slide', canvas: Slide }); the
// generator's edit baseline wants the generation shape ({ elements, background }).
function slideBaseline(content: SceneContent): GeneratedSlideContent | undefined {
  if (content.type !== 'slide') return undefined;
  return {
    elements: content.canvas.elements ?? [],
    background: content.canvas.background,
  } satisfies GeneratedSlideContent;
}

// ── Existing media → generator RESOURCES (assignedImages + imageMapping) ──────
// Root-cause fix: instead of trying to PRESERVE existing images across the
// round-trip (impossible — `generateSlideContent` re-mints every element id), we
// FEED existing images to the generator as resources, the same channel
// course-generation uses. Each real image src is registered as `img_N` in
// `imageMapping` and described (NOT base64) in `assignedImages`; the baseline
// handed to the prompt carries the small id-ref instead of the payload. The
// model references images by id; `resolveImageIds` (scene-generator) resolves
// `img_N` back to the real src. No base64 in the prompt, no reliance on echo.

/** True when a src is a real image payload (data: URL or http(s) URL). */
function isRealImageSrc(src: unknown): src is string {
  if (typeof src !== 'string') return false;
  return src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://');
}

/**
 * Walk the baseline's image elements and lift their real srcs into resources:
 * - register each real src as `img_N` in `imageMapping`,
 * - describe it (by id, not base64) in `assignedImages`,
 * - rewrite the baseline element's `src` to the small `img_N` id-ref.
 * Already-id-ref image elements are mapped through if we know the src (we don't,
 * so they're left as-is — `resolveImageIds` will drop unmapped ones, matching
 * existing behavior). Non-image elements (incl. video/audio) are untouched.
 * Pure: returns a new baseline + resources, does not mutate inputs.
 */
export function buildImageResources(baseline: GeneratedSlideContent): {
  baseline: GeneratedSlideContent;
  assignedImages: PdfImage[];
  imageMapping: ImageMapping;
} {
  const assignedImages: PdfImage[] = [];
  const imageMapping: ImageMapping = {};
  let n = 0;

  const elements = baseline.elements.map((el) => {
    if (!el || el.type !== 'image') return el;
    const src = (el as { src?: unknown }).src;
    if (isRealImageSrc(src)) {
      const imgId = `img_${++n}`;
      imageMapping[imgId] = src;
      assignedImages.push({
        id: imgId,
        src,
        pageNumber: 0,
        width: (el as { width?: number }).width,
        height: (el as { height?: number }).height,
        description: 'Existing slide image',
      });
      return { ...el, src: imgId };
    }
    // Already an id-ref (or otherwise non-real src): keep as-is.
    return el;
  });

  return {
    baseline: { ...baseline, elements },
    assignedImages,
    imageMapping,
  };
}

/**
 * True when a slide-level background is a real image background (DSL
 * `SlideBackground` with `type === 'image'` and a real `image.src`). Used to
 * narrow-refuse image-background slides: the pipeline can't resolve background
 * image ids through the resource channel (only element images flow there).
 */
function isImageBackground(background: GeneratedSlideContent['background']): boolean {
  return background?.type === 'image' && isRealImageSrc(background.image?.src);
}

// ── Params (trust boundary: only id + instruction; content comes from deps) ──

export const RegenerateSceneParams = Type.Object({
  sceneId: Type.String({
    description:
      'The id of the slide to regenerate. Use the id of the current scene shown in the system prompt.',
  }),
  instruction: Type.Optional(
    Type.String({
      description:
        "The user's instruction for how to change the slide, in natural language " +
        '(e.g. "condense to 3 bullet points", "add a real-world example", "make the title punchier"). ' +
        'Do NOT include slide content here — the current slide is loaded automatically as the baseline.',
    }),
  ),
});

export type RegenerateSceneParams = Static<typeof RegenerateSceneParams>;

// ── Details returned to the client ───────────────────────────────────────────

export interface RegenerateSceneDetails {
  sceneId: string;
  content: GeneratedSlideContent | null;
  actions: Action[];
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function makeRegenerateSceneTool(
  deps: RegenerateActionsDeps,
): AgentTool<typeof RegenerateSceneParams, RegenerateSceneDetails> {
  return {
    name: 'regenerate_scene',
    label: 'Regenerate slide',
    description:
      'Regenerates a whole slide — its content AND its narration — to match the user instruction. ' +
      'Only works on slide scenes. Supply the sceneId and a natural-language instruction; ' +
      'the current slide is loaded automatically as the editing baseline.',
    parameters: RegenerateSceneParams,

    execute: async (_toolCallId, params, signal) => {
      const { sceneId, instruction } = params;

      const ctxData: SceneContext | undefined = deps.getSceneContext(sceneId);
      if (!ctxData) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: scene context not found for sceneId ${JSON.stringify(String(sceneId).slice(0, 200))}. Cannot regenerate the slide.`,
            },
          ],
          details: { sceneId, content: null, actions: [] },
          isError: true,
        };
      }

      const { outline, allOutlines, content, stageId, agents, languageDirective } = ctxData;
      void stageId;

      // slide-only this release — refuse non-slide outlines AND any scene whose
      // injected content isn't a slide (guards against scene-type desync between
      // the outline and the actual content payload).
      if (outline.type !== 'slide' || content.type !== 'slide') {
        return {
          content: [
            {
              type: 'text',
              text:
                `Cannot regenerate this scene: regenerating the whole scene is only supported ` +
                `for slides yet (this scene is not a slide). Suggest the user edits it on the canvas.`,
            },
          ],
          details: { sceneId, content: null, actions: [] },
          isError: true,
        };
      }

      // Narrow refusal (this release): whole-slide regeneration can't preserve a
      // video element or a slide-level image background through the resource
      // channel (only element images flow as resources, and background image ids
      // can't be resolved), so refuse rather than silently dropping them. Element
      // images are fine. (Audio is never a canvas element — narration audio lives
      // in the actions/speech layer — so there's nothing to gate there.)
      const slideElements = content.canvas.elements ?? [];
      const hasVideoElement = slideElements.some((el) => el?.type === 'video');
      const hasImageBackground = isImageBackground(content.canvas.background);
      if (hasVideoElement || hasImageBackground) {
        return {
          content: [
            {
              type: 'text',
              text:
                'This slide contains a video or an image background; whole-slide ' +
                "regeneration isn't supported for those yet — please edit it on the canvas.",
            },
          ],
          details: { sceneId, content: null, actions: [] },
          isError: true,
        };
      }

      // Self-contained black box: slide content resolves the `scene-content:slide`
      // stage model and actions resolve `scene-actions` — the same routes the
      // course-generation path uses — independent of the agent conversation model.
      const contentAiCall = (
        systemPrompt: string,
        userPrompt: string,
        _images?: Array<{ id: string; src: string }>,
      ): Promise<string> => deps.aiCall('scene-content:slide', systemPrompt, userPrompt, signal);
      const actionsAiCall = (
        systemPrompt: string,
        userPrompt: string,
        _images?: Array<{ id: string; src: string }>,
      ): Promise<string> => deps.aiCall('scene-actions', systemPrompt, userPrompt, signal);

      // ── Step 1: regenerate slide content in EDIT MODE ──────────────────────
      // Lift existing images into the generator's resource channel: the baseline
      // handed to the prompt carries small `img_N` id-refs (no base64), and
      // assignedImages/imageMapping let `resolveImageIds` rehydrate the real srcs.
      const slideBase = slideBaseline(content)!;
      const {
        baseline: editBaseline,
        assignedImages,
        imageMapping,
      } = buildImageResources(slideBase);

      const newContent = await generateSceneContent(outline, contentAiCall, {
        agents,
        languageDirective,
        editDirective: instruction,
        baselineContent: editBaseline,
        assignedImages,
        imageMapping,
      });

      if (!newContent || !('elements' in newContent)) {
        return {
          content: [
            {
              type: 'text',
              text:
                `Warning: slide content generation failed for "${outline.title}". ` +
                `The slide has NOT been changed.`,
            },
          ],
          details: { sceneId, content: null, actions: [] },
          isError: true,
        };
      }

      // The generator returns solid/gradient backgrounds; image-background slides
      // were refused above, so the returned background is kept as-is.

      // ── Step 2: regenerate actions to match the new content ────────────────
      const allTitles = allOutlines.map((o) => o.title);
      const pageIndex = allOutlines.findIndex((o) => o.id === outline.id);
      const ctx: SceneGenerationContext = {
        pageIndex: (pageIndex >= 0 ? pageIndex : 0) + 1,
        totalPages: allOutlines.length,
        allTitles,
        previousSpeeches: [],
      };

      const actions = await generateSceneActions(outline, newContent, actionsAiCall, {
        ctx,
        agents,
        languageDirective,
      });

      const text =
        actions.length > 0
          ? `Regenerated the slide content (${newContent.elements.length} elements) and ${actions.length} actions.`
          : `Regenerated the slide content (${newContent.elements.length} elements), but narration regeneration produced no actions — the existing narration is unchanged and may not match the new content.`;

      return {
        content: [{ type: 'text', text }],
        details: { sceneId, content: newContent, actions },
      };
    },
  };
}
