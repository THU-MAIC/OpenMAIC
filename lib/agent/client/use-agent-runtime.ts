'use client';

/**
 * MAIC Agent v0 — client runtime.
 *
 * Drives an assistant-ui ExternalStore from the server's pi `AgentEvent` SSE
 * stream. A run produces multiple assistant turns (tool-call turn, wrap-up
 * turn); we keep each turn's ordered content as it streams (`turnsRef`) and
 * flatten chronologically via `mergeAssistantParts`, so tool cards and text
 * render in the order they actually happened. The assistant message carries a
 * streaming `status` (running → complete/error) for proper streaming UI.
 *
 * When a `regenerate_scene_actions` tool result arrives, its `details` payload
 * is applied to the editor's Dexie-backed stage store (guarded against empty
 * actions). Scene/stage context is read from `useStageStore` at send-time and
 * POSTed so the tool never relies on model-fabricated data.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { useStageStore } from '@/lib/store/stage';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import type { SceneContextMap } from '@/app/api/agent/edit/route';
import { mergeAssistantParts, type PiPart } from './merge-assistant-parts';
import { planRegenerateApply, type RegenerateDetails } from './apply-regenerate';
import { applyScenePatchInSync } from './apply-slide-content';
import { useRegenSnapshots } from './regen-snapshots';
import { useAgentThreadStore } from './agent-thread-store';
import { serializeThread, deserializeThread } from './serialize-thread';
export type { AssistantPart, PiPart } from './merge-assistant-parts';
import { toPiParts, type PiAssistantContent } from './to-pi-parts';
import { useThinkingTimers } from './thinking-timers';
import { useSceneRuntimeErrors } from '@/lib/store/scene-runtime-errors';

export interface UseAgentRuntimeOptions {
  scene?: { id: string; title: string };
}

/** A prior conversation turn sent to the server so the agent has memory. */
interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

function extractText(message: AppendMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Plain text of a thread message's content (tool-call parts have no text). */
function messageText(content: ThreadMessageLike['content']): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Project the rendered thread into text-only turns for server-side memory. */
function toHistory(messages: ThreadMessageLike[]): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (const m of messages) {
    const text = messageText(m.content);
    if (!text) continue;
    out.push({ role: m.role === 'user' ? 'user' : 'assistant', text });
  }
  return out;
}

export function useAgentRuntime(opts: UseAgentRuntimeOptions) {
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  // Mirror the latest committed messages so `onNew` (which is not re-created on
  // every message change) can read the prior conversation to send as history.
  const messagesRef = useRef<ThreadMessageLike[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Lightweight per-course persistence: one thread per stage, restored on mount
  // and when the course changes, so a refresh no longer drops the conversation.
  const stageId = useStageStore((s) => s.stage?.id);
  const loadedStageRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!stageId || loadedStageRef.current === stageId) return;
    const firstResolve = loadedStageRef.current === undefined;
    loadedStageRef.current = stageId;
    // First resolve while a conversation is already underway (user sent before
    // the stage id was known): keep the live thread, don't clobber it with the
    // saved (likely empty) one. A genuine course SWITCH still loads its thread.
    if (firstResolve && messagesRef.current.length > 0) return;
    const saved = useAgentThreadStore.getState().load(stageId)?.messages;
    setMessages(deserializeThread(saved));
    // Re-seed reasoning durations (the live timer store is in-memory, lost on
    // refresh) so restored panels show "已思考 N s" instead of a blank label.
    if (Array.isArray(saved)) {
      for (const m of saved) {
        if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
        let ord = 0;
        for (const p of m.content) {
          if (p.type === 'reasoning') {
            if (typeof p.durationMs === 'number')
              useThinkingTimers.getState().seed(`${m.id}:${ord}`, p.durationMs);
            ord++;
          }
        }
      }
    }
  }, [stageId]);

  // Persist the thread whenever it settles (after a turn completes, not mid-run),
  // keyed by the current course. An effect — NOT an inline read after
  // setMessages — because a state updater does not run synchronously, so reading
  // "final" messages right after setMessages would serialize a stale/empty list.
  useEffect(() => {
    if (isRunning || messages.length === 0) return;
    const sid = useStageStore.getState().stage?.id;
    if (sid) {
      // Supply each reasoning block's final duration (keyed messageId:ordinal) so
      // "已思考 N s" survives a refresh.
      const timers = useThinkingTimers.getState().timers;
      const getDuration = (messageId: string | undefined, ordinal: number): number | undefined => {
        const tmr = timers[`${messageId}:${ordinal}`];
        return tmr && tmr.endedAt != null ? tmr.endedAt - tmr.startedAt : undefined;
      };
      useAgentThreadStore
        .getState()
        .save(sid, { messages: serializeThread(messages, getDuration), updatedAt: Date.now() });
    }
  }, [messages, isRunning]);

  // Per-run accumulated state: chronological turns + tool results.
  const turnsRef = useRef<PiPart[][]>([]);
  const toolResultsRef = useRef<Map<string, { result: unknown; isError: boolean }>>(new Map());
  const errorRef = useRef<string>('');
  const phaseRef = useRef<'running' | 'complete' | 'error' | 'cancelled'>('complete');
  // Aborts the in-flight run; closing the fetch body cancels the server stream
  // (the route's ReadableStream.cancel() calls agent.abort()).
  const abortRef = useRef<AbortController | null>(null);

  const clearThread = useCallback(() => {
    // Discard any in-flight run first — otherwise its late SSE events still pass
    // isCurrent() and could rewrite the cleared thread or apply tool patches to
    // the slide after the user reset.
    abortRef.current?.abort();
    abortRef.current = null;
    phaseRef.current = 'complete';
    setIsRunning(false);
    setMessages([]);
    useRegenSnapshots.getState().clearAll();
    useThinkingTimers.getState().clear();
    const sid = useStageStore.getState().stage?.id;
    if (sid) useAgentThreadStore.getState().clear(sid);
  }, []);

  const buildAssistant = useCallback((id: string): ThreadMessageLike => {
    const parts = mergeAssistantParts({
      turns: turnsRef.current,
      toolResults: toolResultsRef.current,
      error: errorRef.current,
    });
    const status: ThreadMessageLike['status'] =
      phaseRef.current === 'running'
        ? { type: 'running' }
        : phaseRef.current === 'error'
          ? { type: 'incomplete', reason: 'error' }
          : phaseRef.current === 'cancelled'
            ? { type: 'incomplete', reason: 'cancelled' }
            : { type: 'complete', reason: 'stop' };
    return { role: 'assistant', id, content: parts as ThreadMessageLike['content'], status };
  }, []);

  const handleEvent = useCallback((event: AgentEvent, refresh: () => void, assistantId: string) => {
    switch (event.type) {
      case 'message_start': {
        const msg = (event as { message?: { role?: string } }).message;
        if (msg?.role === 'assistant') {
          turnsRef.current.push([]); // a new assistant turn begins
          refresh();
        }
        break;
      }
      case 'message_update':
      case 'message_end': {
        const msg = (
          event as {
            message?: { role?: string; content?: PiAssistantContent[]; errorMessage?: string };
          }
        ).message;
        if (msg?.role !== 'assistant') break;
        if (msg.errorMessage) errorRef.current = msg.errorMessage;
        if (Array.isArray(msg.content)) {
          if (turnsRef.current.length === 0) turnsRef.current.push([]);
          // Replace the CURRENT turn's content wholesale (pi re-emits the full
          // accumulated turn on each update) — order within the turn is kept.
          turnsRef.current[turnsRef.current.length - 1] = toPiParts(msg.content);
        }
        // Per-block reasoning timing for the thinking panels' durations. Compute
        // over the SAME merged view the UI renders so block ordinals align: each
        // reasoning block ends (freezes) once a later part follows it; the last
        // one stays open and ticks live until something follows or the run ends.
        const merged = mergeAssistantParts({
          turns: turnsRef.current,
          toolResults: toolResultsRef.current,
          error: errorRef.current,
        });
        const nowTs = Date.now();
        let ord = 0;
        for (let i = 0; i < merged.length; i++) {
          if (merged[i].type === 'reasoning') {
            useThinkingTimers
              .getState()
              .observe(`${assistantId}:${ord}`, { end: i < merged.length - 1, now: nowTs });
            ord++;
          }
        }
        refresh();
        break;
      }
      case 'tool_execution_end': {
        const e = event as {
          toolCallId: string;
          toolName?: string;
          result?: { details?: unknown };
          isError?: boolean;
        };
        toolResultsRef.current.set(e.toolCallId, { result: e.result, isError: !!e.isError });
        const details = (e.result?.details ?? {}) as RegenerateDetails;
        // Decide what to apply: regenerate_scene applies content (+actions) and
        // snapshots the pre-state for restore; regenerate_scene_actions applies
        // actions only. Empty actions are never applied (would wipe narration).
        const scene = details.sceneId
          ? useStageStore.getState().getSceneById(details.sceneId)
          : null;
        const { snapshot, patch } = planRegenerateApply(details, scene, e.toolName);
        // Capture the applied patch as the snapshot's `redo` so an undo can be
        // resumed (the Restore button toggles undo ↔ resume).
        if (snapshot)
          useRegenSnapshots
            .getState()
            .setSnapshot(e.toolCallId, patch ? { ...snapshot, redo: patch } : snapshot);
        if (patch && details.sceneId) {
          // Apply to the stage store and keep the OPEN slide edit session in
          // lockstep — else the canvas keeps rendering its stale history.present
          // and the next edit clobbers the regen.
          applyScenePatchInSync(details.sceneId, patch);
        }
        refresh();
        break;
      }
      default:
        break;
    }
  }, []);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const userText = extractText(message);
      if (!userText) return;

      // Prior conversation (text turns) captured BEFORE this turn's messages are
      // appended — sent to the server so the agent has multi-turn memory.
      const history = toHistory(messagesRef.current);

      const turnId = `t-${Date.now()}`;
      const assistantId = `a-${turnId}`;
      turnsRef.current = [];
      toolResultsRef.current = new Map();
      errorRef.current = '';
      phaseRef.current = 'running';
      const abort = new AbortController();
      abortRef.current = abort;

      const userMsg: ThreadMessageLike = {
        role: 'user',
        id: `u-${turnId}`,
        content: [{ type: 'text', text: userText }],
      };
      setMessages((prev) => [...prev, userMsg, buildAssistant(assistantId)]);
      setIsRunning(true);

      // This run is "current" only while it still owns abortRef. Once the user
      // stops and starts another run, a newer onNew takes abortRef — late SSE
      // events from this (superseded) run must not rewrite the new message.
      const isCurrent = () => abortRef.current === abort;

      const refresh = () => {
        if (!isCurrent()) return;
        setMessages((prev) => {
          const next = prev.slice();
          next[next.length - 1] = buildAssistant(assistantId);
          return next;
        });
      };

      try {
        // Trusted scene context from the client store — the route injects it
        // into the tool deps so the model never fabricates outline/content.
        const storeState = useStageStore.getState();
        const { scenes, outlines, stage } = storeState;
        const sceneContextMap: SceneContextMap = {};
        for (const scene of scenes) {
          const outline = outlines.find((o) => o.order === scene.order) ?? {
            id: scene.id,
            type: scene.type,
            title: scene.title,
            description: '',
            keyPoints: [],
            order: scene.order,
          };
          sceneContextMap[scene.id] = {
            outline,
            allOutlines:
              outlines.length > 0
                ? outlines
                : scenes.map((s) => ({
                    id: s.id,
                    type: s.type,
                    title: s.title,
                    description: '',
                    keyPoints: [],
                    order: s.order,
                  })),
            content: scene.content,
            stageId: scene.stageId,
            languageDirective: stage?.languageDirective,
            // Runtime errors the interactive iframe reported, so read_scene_content
            // can show the agent why a page is blank instead of it guessing.
            runtimeErrors: useSceneRuntimeErrors.getState().errors[scene.id],
          };
        }

        // Use the same active frontend model config as course generation
        // (sent via x-model/* headers). Without these the server falls back to
        // a server-side provider, so the agent would 500 when no server key is
        // configured even though generation works with the user's own config.
        const cfg = getCurrentModelConfig();
        const res = await fetch('/api/agent/edit', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-model': cfg.modelString || '',
            'x-api-key': cfg.apiKey || '',
            'x-base-url': cfg.baseUrl || '',
            'x-provider-type': cfg.providerType || '',
          },
          body: JSON.stringify({
            message: userText,
            scene: opts.scene,
            history,
            sceneContextMap,
            // The route reads per-request thinking config from the body (not
            // headers), same as generation — forward it so the agent honors the
            // user's active thinking budget/level too.
            ...(cfg.thinkingConfig ? { thinkingConfig: cfg.thinkingConfig } : {}),
          }),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`agent request failed: ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const line = chunk.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            const json = line.slice(5).trim();
            if (!json || json === '{}') continue;
            let event: AgentEvent;
            try {
              event = JSON.parse(json) as AgentEvent;
            } catch {
              continue;
            }
            // Skip late events from a superseded run (don't apply stale tool
            // results to the stage or rewrite the new run's message).
            if (isCurrent()) handleEvent(event, refresh, assistantId);
          }
        }
      } catch (err) {
        // User-initiated stop — keep whatever streamed, don't surface an error.
        if (abort.signal.aborted) {
          // Only finalize if this run still owns the state (a newer run may have
          // taken over). Mark any tool call that never produced a result as
          // stopped, so its card shows a clear "stopped" state instead of a
          // misleading green check, and flag the message as cancelled.
          if (abortRef.current === abort) {
            for (const turn of turnsRef.current) {
              for (const p of turn) {
                if (p.type === 'toolCall' && !toolResultsRef.current.has(p.id)) {
                  toolResultsRef.current.set(p.id, { result: { __stopped: true }, isError: true });
                }
              }
            }
            phaseRef.current = 'cancelled';
          }
        } else {
          errorRef.current = `⚠️ ${err instanceof Error ? err.message : String(err)}`;
          phaseRef.current = 'error';
        }
      } finally {
        // If the user stopped this run and immediately started a new one, a
        // newer onNew has already taken over abortRef and the message list.
        // This (superseded) run must NOT reset isRunning or rewrite the last
        // message, or it would clobber the new run.
        const superseded = abortRef.current !== abort;
        if (!superseded) {
          abortRef.current = null;
          if (phaseRef.current === 'running') phaseRef.current = 'complete';
          // Close any reasoning block still open (e.g. the run ended with the
          // last block as its final phase) so its duration is final.
          useThinkingTimers.getState().endAll(`${assistantId}:`, Date.now());
          setIsRunning(false);
          setMessages((prev) => {
            const next = prev.slice();
            next[next.length - 1] = buildAssistant(assistantId);
            return next;
          });
          // The persistence save runs via the [messages, isRunning] effect once
          // this update commits and isRunning flips false — see above.
        }
      }
    },
    [buildAssistant, handleEvent, opts.scene],
  );

  // Stop the current response: abort the fetch (cancels the server stream) and
  // drop the running flag immediately for a snappy UI; onNew's finally then
  // finalizes the assistant message with whatever had already streamed.
  const onCancel = useCallback(async () => {
    abortRef.current?.abort();
    setIsRunning(false);
  }, []);

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning,
    onNew,
    onCancel,
    convertMessage: (m) => m,
  });

  return { runtime, clearThread, hasMessages: messages.length > 0 };
}
