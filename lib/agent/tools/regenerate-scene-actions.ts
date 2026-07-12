/**
 * `regenerate_scene_actions` agent tool
 *
 * Re-generates a scene's playback `actions` to match its (edited) content by
 * reusing the same server-side pipeline as `app/api/generate/scene-actions/route.ts`.
 *
 * The tool's `execute` runs inside the agent loop and has no access to the
 * request's resolved model, so the LLM call capability is injected via a
 * factory (`makeRegenerateSceneActionsTool`) — the route will supply `deps.aiCall`
 * built from the already-resolved model.
 *
 * Scene/stage context (outline, allOutlines, content, stageId) is injected via
 * `deps.getSceneContext` — sourced from the client's `useStageStore` and sent in
 * the POST body — so the model never needs to fabricate these large structures.
 * The model only needs to supply the `sceneId` (or rely on the active scene).
 *
 * The tool returns the regenerated actions in `details`; a later client task
 * reads `tool_execution_end` and applies the actions to the scene in the store.
 */

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  generateSceneActions,
  type SceneGenerationContext,
  type AgentInfo,
} from '@/lib/generation/generation-pipeline';
import type { Action } from '@/lib/types/action';
import type {
  SceneOutline,
  GeneratedSlideContent,
  GeneratedQuizContent,
  GeneratedInteractiveContent,
  GeneratedPBLContent,
} from '@/lib/types/generation';
import type { SceneContent } from '@/lib/types/stage';
import type { LlmStage } from '@/lib/server/model-routes';

// ── Scene context shape (client-sourced, injected via deps) ──────────────────

export interface SceneContext {
  /** The SceneOutline for the target scene. */
  outline: SceneOutline;
  /** All scene outlines in the stage, in order (for cross-scene context). */
  allOutlines: SceneOutline[];
  /** The current scene content. */
  content: SceneContent;
  /** The stage id that owns this scene. */
  stageId: string;
  /** Optional agent info for multi-agent stages. */
  agents?: AgentInfo[];
  /** Optional language directive forwarded to the generator. */
  languageDirective?: string;
  /**
   * Runtime errors the interactive iframe reported for this scene (captured by
   * the error shim, see lib/utils/iframe.ts). Surfaced to the model by
   * read_scene_content so it can diagnose a blank/broken page from the real
   * error instead of guessing.
   */
  runtimeErrors?: string[];
}

// ── Deps injection interface ─────────────────────────────────────────────────

export interface RegenerateActionsDeps {
  /**
   * Server-side LLM text call, resolving the model PER GENERATION STAGE.
   *
   * Each tool is a self-contained generation black box: it names the stage it is
   * generating for (e.g. `scene-content:interactive`, `scene-content:slide`,
   * `scene-actions`) and the route resolves that stage's model via MODEL_ROUTES
   * — independent of the `maic-agent` model driving the agent conversation. The
   * agent only decides WHICH tool to call; the tool owns its model.
   *
   * `signal` is the tool's abort signal (from `execute`): when the user cancels
   * the turn, the in-flight generation call is aborted so it stops promptly
   * instead of running to completion in the background.
   */
  aiCall: (
    stage: LlmStage,
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
  ) => Promise<string>;

  /**
   * Returns the trusted scene/stage context for a given scene id.
   * This is populated from the client POST body (useStageStore state) so the
   * model never has to fabricate outlines or content.
   */
  getSceneContext: (sceneId: string) => SceneContext | undefined;
}

// ── Content shape conversion ─────────────────────────────────────────────────
//
// The client sends `scene.content` (runtime `SceneContent` DSL) but
// `generateSceneActions` expects the generation-time types:
//   GeneratedSlideContent    { elements, background?, remark? }
//   GeneratedQuizContent     { questions }
//   GeneratedInteractiveContent { html, ... }
//   GeneratedPBLContent      { projectConfig }
//
// The ONLY mismatch is `SlideContent` (runtime) vs `GeneratedSlideContent`:
//   SlideContent  = { type: 'slide', canvas: Slide }  — elements at canvas.elements
//   GeneratedSlide = { elements, background?, remark? } — elements at top level
//
// `generateSceneActions` checks `'elements' in content` for the slide branch.
// If we pass SlideContent directly, that check is FALSE → falls through → returns [].
//
// For quiz/interactive/pbl the runtime shapes already have the discriminant field
// at the top level ('questions', 'html', 'projectConfig'), so they pass through as-is.

function toGenerationContent(
  content: SceneContent,
):
  | GeneratedSlideContent
  | GeneratedQuizContent
  | GeneratedInteractiveContent
  | GeneratedPBLContent {
  if (content.type === 'slide') {
    // Convert SlideContent → GeneratedSlideContent
    return {
      elements: content.canvas.elements ?? [],
      background: content.canvas.background,
      // remark is not stored in the runtime canvas; omit it
    } satisfies GeneratedSlideContent;
  }
  // quiz, interactive, pbl runtime shapes already satisfy the generation type
  return content as GeneratedQuizContent | GeneratedInteractiveContent | GeneratedPBLContent;
}

// ── Typebox parameter schema ─────────────────────────────────────────────────
// Minimal: the model only needs to identify WHICH scene to regenerate.
// All heavy context (outline, allOutlines, content, stageId) comes from deps.

export const RegenerateSceneActionsParams = Type.Object({
  sceneId: Type.String({
    description:
      'The id of the scene whose actions should be regenerated. ' +
      'Use the id of the current scene shown in the system prompt.',
  }),
  previousSpeeches: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Speech texts from the previous scene for cross-scene coherence.',
    }),
  ),
  userProfile: Type.Optional(
    Type.String({ description: 'Free-text user profile for personalised narration.' }),
  ),
});

export type RegenerateSceneActionsParams = Static<typeof RegenerateSceneActionsParams>;

// ── Details shape returned to the client ────────────────────────────────────

export interface RegenerateSceneActionsDetails {
  sceneId: string;
  actions: Action[];
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function makeRegenerateSceneActionsTool(
  deps: RegenerateActionsDeps,
): AgentTool<typeof RegenerateSceneActionsParams, RegenerateSceneActionsDetails> {
  return {
    name: 'regenerate_scene_actions',
    label: 'Regenerate scene actions',
    description:
      'Re-generates the narration/playback actions for a scene to match its (edited) content. ' +
      'Use this after the scene content has been modified (e.g. slide elements changed, quiz questions updated) ' +
      'so that the actions stay in sync with what is actually on screen. ' +
      'Only supply the sceneId — the scene data is loaded automatically.',
    parameters: RegenerateSceneActionsParams,

    execute: async (_toolCallId, params, signal) => {
      const { sceneId, previousSpeeches, userProfile } = params;

      // ── Resolve trusted scene context from deps (not from model args) ──
      const ctxData = deps.getSceneContext(sceneId);
      if (!ctxData) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: scene context not found for sceneId ${JSON.stringify(String(sceneId).slice(0, 200))}. Cannot regenerate actions.`,
            },
          ],
          details: { sceneId, actions: [] },
          isError: true,
        };
      }

      const { outline, allOutlines, content, stageId, agents, languageDirective } = ctxData;

      // Suppress unused variable — stageId is part of the context contract and
      // may be needed by future tool logic (e.g. quota checks, audit logging).
      void stageId;

      // ── Build cross-scene context (mirrors route.ts logic) ─────────────
      const allTitles: string[] = allOutlines.map((o) => o.title);
      const pageIndex = allOutlines.findIndex((o) => o.id === outline.id);
      const ctx: SceneGenerationContext = {
        pageIndex: (pageIndex >= 0 ? pageIndex : 0) + 1,
        totalPages: allOutlines.length,
        allTitles,
        previousSpeeches: previousSpeeches ?? [],
      };

      // Wrap deps.aiCall to match AICallFn (adds optional images param). Actions
      // generation resolves the `scene-actions` stage model — the same route the
      // course-generation actions path uses — not the agent conversation model.
      const aiCallFn = (
        systemPrompt: string,
        userPrompt: string,
        _images?: Array<{ id: string; src: string }>,
      ): Promise<string> => deps.aiCall('scene-actions', systemPrompt, userPrompt, signal);

      // ── Generate actions ───────────────────────────────────────────────
      // Convert the runtime SceneContent shape to the generation-time shape that
      // generateSceneActions expects.  The critical case is SlideContent:
      //   runtime:    { type: 'slide', canvas: Slide }   → elements at canvas.elements
      //   generation: { elements, background?, remark? } → elements at top level
      // Without this conversion the 'elements' in content check is FALSE and the
      // function returns [] immediately.
      const generationContent = toGenerationContent(content);

      const actions = await generateSceneActions(outline, generationContent, aiCallFn, {
        ctx,
        agents,
        userProfile,
        languageDirective,
      });

      if (actions.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                `Warning: action generation produced no actions for scene "${outline.title}". ` +
                `The scene content may be empty or in an unexpected format. ` +
                `The existing actions have NOT been changed.`,
            },
          ],
          details: { sceneId, actions: [] },
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Regenerated ${actions.length} actions for the scene.`,
          },
        ],
        details: { sceneId, actions },
      };
    },
  };
}
