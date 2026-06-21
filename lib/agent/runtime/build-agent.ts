/**
 * MAIC Agent — agent runtime construction.
 *
 * Stands up a pi `Agent` with:
 * - injected StreamFn (-> OpenMAIC connector),
 * - request-scoped tools supplied by the route,
 * - a `beforeToolCall` allowlist gate (v0 capability restriction = tool allowlist,
 *   NOT a hardcoded workflow). Adding capability later = widening this set.
 * - a `afterToolCall` quota hook (v0 stub: unlimited).
 */
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { makeAllowlistGate } from './allowlist';
import { makeQuotaHook } from './quota';
import { V0_ALLOWLIST } from '../tools/registry';

// pi needs *a* model object on state; the injected StreamFn ignores it and uses
// OpenMAIC's resolved model, so this is a metadata stub (high contextWindow so
// the harness never tries to compact).
const STUB_MODEL = {
  id: 'maic-connector',
  name: 'maic-connector',
  api: 'unknown',
  provider: 'unknown',
  baseUrl: '',
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 8192,
} as unknown as Model<Api>;

export interface BuildAgentOptions {
  streamFn: StreamFn;
  systemPrompt: string;
  tools: AgentTool<never, never>[];
  /** Prior conversation turns to seed the agent with, so it has multi-turn memory. */
  history?: AgentMessage[];
}

export function buildAgent(opts: BuildAgentOptions): Agent {
  return new Agent({
    streamFn: opts.streamFn,
    toolExecution: 'sequential',
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: STUB_MODEL,
      tools: opts.tools,
      // Seed prior turns so `agent.prompt(newMessage)` runs with the full
      // conversation in context — without this the agent is stateless per turn.
      ...(opts.history && opts.history.length > 0 ? { messages: opts.history } : {}),
    },
    beforeToolCall: makeAllowlistGate(V0_ALLOWLIST),
    afterToolCall: makeQuotaHook({ remaining: () => Number.MAX_SAFE_INTEGER }),
  });
}

export function buildSystemPrompt(scene?: { id: string; title: string }): string {
  const sceneLine = scene
    ? `The current slide is id="${scene.id}" with title "${scene.title}".`
    : 'There is no active slide.';
  return [
    'You are the MAIC Editor assistant, embedded in the slide editor sidebar.',
    sceneLine,
    // Capability boundary — keep this tight. The agent has exactly THREE tools
    // (read_scene_content, regenerate_scene, regenerate_scene_actions). Without
    // firm limits the model cheerfully claims it can add slides or edit quizzes,
    // which it cannot.
    'Before answering questions about the slide or regenerating it, call `read_scene_content` (with only the sceneId) to see what is actually on the slide.',
    "Your editing capabilities are: (1) regenerate the WHOLE slide — its content (text/layout/images) and its narration together — to match the user's instruction, by calling `regenerate_scene` with the sceneId and a natural-language instruction; (2) regenerate ONLY the spoken narration and playback actions (讲解旁白/动作) by calling `regenerate_scene_actions` with the sceneId. For both, outline and content are resolved automatically — supply only the sceneId (and, for regenerate_scene, the instruction); never fabricate slide content.",
    'Whole-slide regeneration (`regenerate_scene`) works for SLIDE scenes only. For quiz, interactive, PBL or whiteboard scenes you cannot regenerate the content — say so honestly and suggest the user edits those on the canvas.',
    'You CANNOT add, delete, reorder or duplicate slides; you cannot insert quizzes; you cannot modify the whiteboard; you cannot directly hand-edit slide text/elements (the user does that on the canvas). When asked for any of these, do NOT claim you can — briefly say you cannot do that yet and point them to the canvas.',
    // Wholesale caveat retained: regeneration rebuilds the scene, so specific
    // existing elements/cues cannot be guaranteed to survive unchanged.
    'Regeneration rebuilds the slide and/or its actions wholesale, so it cannot guarantee that specific existing elements, spotlight/laser cues, their count, or their bindings survive unchanged. If the user asks to regenerate under such a "keep X exactly" constraint, do NOT call the tool: explain that regeneration rebuilds the scene and cannot guarantee that, and suggest they adjust those parts directly on the canvas / timeline instead.',
    "Keep replies to one or two sentences. Reply in the user's language.",
  ].join(' ');
}
