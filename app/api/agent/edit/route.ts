/**
 * MAIC Agent — SSE transport endpoint.
 *
 * Hosts a server-side pi Agent and streams its `AgentEvent`s to the editor
 * sidebar as Server-Sent Events. The whole feature is gated behind the master
 * editor flag.
 */
import type { NextRequest } from 'next/server';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { isMaicEditorEnabled } from '@/lib/config/feature-flags';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import type { LlmStage } from '@/lib/server/model-routes';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { buildAgent, buildSystemPrompt } from '@/lib/agent/runtime/build-agent';
import { buildToolset } from '@/lib/agent/tools/registry';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import type { SceneContext } from '@/lib/agent/tools/regenerate-scene-actions';

const log = createLogger('MAIC Agent');

// A single `regenerate_scene` tool call runs slide content generation *and*
// action generation inside this SSE turn, matching the dedicated scene-content
// route's budget (300s) — not the 60s a plain chat turn needs. Cap to 300 so
// slow models / media-heavy slides aren't terminated mid-stream.
export const maxDuration = 300;

/**
 * Scene/stage context map sent by the client.
 * Keyed by scene id; the client reads `useStageStore` to build this so the
 * server never has to access a (non-existent) server-side scene store.
 */
export type SceneContextMap = Record<string, SceneContext>;

interface AgentEditBody {
  message: string;
  scene?: { id: string; title: string };
  /**
   * Prior conversation turns (text only) sent by the client so the agent has
   * multi-turn memory — without this each request is stateless and the agent
   * cannot recall earlier exchanges.
   */
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  /**
   * Trusted scene/stage context for every scene the agent may act on.
   * The client includes the active scene (and all sibling scenes) so the
   * `regenerate_scene_actions` tool can resolve outline + content without
   * relying on model-fabricated arguments.
   */
  sceneContextMap?: SceneContextMap;
  /**
   * Current canvas selection (element ids) for selection-aware `edit_elements`.
   * Client-sourced from `useCanvasStore.activeElementIdList`.
   */
  selection?: string[];
}

/** Max prior turns carried into context (keeps the prompt bounded). */
const MAX_HISTORY_TURNS = 24;

/** Convert the client's text-only history into pi `AgentMessage`s. */
function toHistoryMessages(history: AgentEditBody['history']): AgentMessage[] {
  if (!Array.isArray(history)) return [];
  const turns = history
    .filter(
      (m): m is { role: 'user' | 'assistant'; text: string } =>
        !!m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.text === 'string' &&
        m.text.trim().length > 0,
    )
    .slice(-MAX_HISTORY_TURNS);
  // Don't let the seeded transcript end on a user turn: agent.prompt() appends
  // the new user message, and two consecutive user messages degrade on some
  // providers. (Trailing user turns are dropped tool-call-only replies, etc.)
  while (turns.length > 0 && turns[turns.length - 1].role === 'user') turns.pop();
  return turns.map((m) =>
    m.role === 'user'
      ? ({ role: 'user', content: m.text } as AgentMessage)
      : ({ role: 'assistant', content: [{ type: 'text', text: m.text }] } as AgentMessage),
  );
}

export async function POST(req: NextRequest) {
  if (!isMaicEditorEnabled()) {
    return new Response('Not found', { status: 404 });
  }

  const body = (await req.json()) as AgentEditBody & Record<string, unknown>;
  const message = (body.message ?? '').toString().trim();
  if (!message) {
    return new Response('message is required', { status: 400 });
  }

  // Resolve via the 'maic-agent' stage so operators can route the editor agent
  // to a dedicated model via MODEL_ROUTES (per-stage config). When unrouted it
  // falls back to the client's active frontend model config (x-model headers +
  // thinkingConfig body), then DEFAULT_MODEL — see resolveModel.
  const { model, modelInfo, thinkingConfig, modelString } = await resolveModelFromRequest(
    req,
    body,
    'maic-agent',
  );

  // Per-stage model resolution for the generation tools. Each tool is a
  // self-contained black box that names the generation stage it produces (e.g.
  // `scene-content:interactive`, `scene-content:slide`, `scene-actions`); we
  // resolve that stage's model via MODEL_ROUTES (cached per stage for this turn),
  // independent of the `maic-agent` conversation model that drives streamFn below.
  // Unrouted stages fall back to the client's active frontend model, so default
  // behaviour is unchanged unless an operator routes a stage explicitly.
  const stageCache = new Map<LlmStage, Awaited<ReturnType<typeof resolveModelFromRequest>>>();
  const aiCall = async (
    stage: LlmStage,
    system: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    let resolved = stageCache.get(stage);
    if (!resolved) {
      resolved = await resolveModelFromRequest(req, body, stage);
      stageCache.set(stage, resolved);
    }
    const r = await callLLM(
      {
        model: resolved.model,
        system,
        prompt,
        maxOutputTokens: resolved.modelInfo?.outputWindow,
        // Abort the in-flight generation when the user cancels the turn — pi
        // passes each tool an AbortSignal, which the tools thread through here.
        abortSignal: signal,
      },
      'maic-agent-regen',
      undefined,
      resolved.thinkingConfig,
    );
    return r.text;
  };

  const sceneContextMap: SceneContextMap = body.sceneContextMap ?? {};
  const selectionIds: readonly string[] = Array.isArray(body.selection)
    ? body.selection.filter((id): id is string => typeof id === 'string')
    : [];
  const tools = buildToolset({
    aiCall,
    getSceneContext: (sceneId) => sceneContextMap[sceneId],
    activeSceneId: body.scene?.id,
    getSelection: () => selectionIds,
  });

  const abortController = new AbortController();
  const streamFn = createCallLlmStreamFn({
    languageModel: model,
    maxOutputTokens: modelInfo?.outputWindow,
    thinkingConfig,
    source: 'maic-agent',
    abortSignal: abortController.signal,
  });

  const agent = buildAgent({
    streamFn,
    systemPrompt: buildSystemPrompt(body.scene),
    tools,
    history: toHistoryMessages(body.history),
  });
  log.info(`agent edit turn [model=${modelString}] scene=${body.scene?.id ?? 'none'}`);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: AgentEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* controller closed */
        }
      };
      const unsubscribe = agent.subscribe((event) => {
        send(event);
      });
      try {
        await agent.prompt(message);
        await agent.waitForIdle();
      } catch (err) {
        log.error(`agent run failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        unsubscribe();
        try {
          controller.enqueue(encoder.encode('event: close\ndata: {}\n\n'));
        } catch {
          /* ignore */
        }
        controller.close();
      }
    },
    cancel() {
      agent.abort();
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
