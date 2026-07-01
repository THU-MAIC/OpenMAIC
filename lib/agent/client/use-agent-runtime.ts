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
import { resolveSceneOutline } from './resolve-scene-outline';
import { planRegenerateApply, type RegenerateDetails } from './apply-regenerate';
import { applyScenePatchInSync } from './apply-slide-content';
import { useRegenSnapshots } from './regen-snapshots';
import {
  createSession,
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  migrateLegacyThread,
  rememberActiveSession,
  recallActiveSession,
} from './agent-thread-store';
import { deriveSessionTitle, type AgentEditSessionRecord } from './agent-edit-session-types';
import { serializeThread, deserializeThread, type SerializedMessage } from './serialize-thread';
export type { AssistantPart, PiPart } from './merge-assistant-parts';
import { toPiParts, type PiAssistantContent } from './to-pi-parts';
import { useThinkingTimers } from './thinking-timers';
import { useSceneRuntimeErrors } from '@/lib/store/scene-runtime-errors';

export interface UseAgentRuntimeOptions {
  scene?: { id: string; title: string };
  isSendDisabled?: boolean;
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

/**
 * Re-seed reasoning durations into the (in-memory, lost-on-refresh) timer store
 * from a restored session so panels show "已思考 N s" instead of a blank label.
 */
function reseedReasoningTimers(saved: SerializedMessage[] | undefined): void {
  if (!Array.isArray(saved)) return;
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

export function useAgentRuntime(opts: UseAgentRuntimeOptions) {
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  // Mirror the latest committed messages so `onNew` (which is not re-created on
  // every message change) can read the prior conversation to send as history.
  const messagesRef = useRef<ThreadMessageLike[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Multi-session persistence per stage (history list, IndexedDB-backed). The
  // active session is tracked in memory; on mount/course-switch we load the most
  // recent session (or start a fresh one) so a refresh no longer drops the chat.
  const stageId = useStageStore((s) => s.stage?.id);
  // The stage this effect last STARTED loading for (set synchronously). Used both
  // to dedup re-runs for the same stage and to detect a switch. We deliberately
  // do NOT gate on a "load committed" ref: the async pass bails via a stage-match
  // check, so under React StrictMode the first (uncancelled) pass hydrates while
  // the second is deduped, and a quick switch-away-and-back still reloads.
  const startedStageRef = useRef<string | undefined>(undefined);
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const [sessions, setSessions] = useState<AgentEditSessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);

  const refreshSessions = useCallback(async () => {
    const sid = useStageStore.getState().stage?.id;
    if (!sid) return;
    const list = await listSessions(sid);
    // The stage may have switched during the await — don't overwrite the new
    // panel's history with the previous stage's rows.
    if (useStageStore.getState().stage?.id !== sid) return;
    setSessions(list);
  }, []);

  useEffect(() => {
    if (!stageId || startedStageRef.current === stageId) return;
    // Switch = this effect previously started for a DIFFERENT stage, so any live
    // thread on screen belongs to that old stage and must be dropped — even if its
    // load never committed (e.g. a quick A→B→A before B settled).
    const isSwitch = startedStageRef.current !== undefined;
    startedStageRef.current = stageId;
    if (isSwitch) {
      // Drop the previous stage's thread synchronously BEFORE the async load, so
      // the old conversation can't be POSTed as history or archived under the new
      // stage, and the popover can't act on a foreign-stage session.
      abortRef.current?.abort();
      abortRef.current = null;
      phaseRef.current = 'complete';
      setIsRunning(false);
      messagesRef.current = [];
      setMessages([]);
      activeSessionIdRef.current = undefined;
      setActiveSessionId(undefined);
      setSessions([]);
      useRegenSnapshots.getState().clearAll();
      useThinkingTimers.getState().clear();
    }
    void (async () => {
      // One-time import of the old single-thread localStorage entry.
      await migrateLegacyThread(stageId);
      const list = await listSessions(stageId);
      // The user may have switched stages during the awaits — only commit if this
      // stage is still current (replaces a cancelled-flag, which left StrictMode
      // unable to hydrate).
      if (useStageStore.getState().stage?.id !== stageId) return;
      setSessions(list);
      // A conversation is already underway for THIS stage — either the user sent
      // before the stage id resolved (first resolve), or they started typing
      // during this async load window (after the synchronous switch-clear). Adopt
      // it as a new active session instead of clobbering the in-flight thread with
      // a stored one.
      if (messagesRef.current.length > 0) {
        // Reuse an id the settle-save effect may already have created/saved during
        // this load window; only mint a new one if none exists. Otherwise we'd
        // remember an unsaved id and strand the actually-saved conversation.
        const sid = activeSessionIdRef.current ?? createSession(stageId).id;
        activeSessionIdRef.current = sid;
        setActiveSessionId(sid);
        rememberActiveSession(stageId, sid);
        return;
      }
      // Prefer the session the user last had open (survives refresh), including a
      // freshly-created empty one after "new conversation" that has no row yet.
      const remembered = recallActiveSession(stageId);
      const rememberedRec = remembered ? list.find((s) => s.id === remembered) : undefined;
      if (rememberedRec) {
        activeSessionIdRef.current = rememberedRec.id;
        setActiveSessionId(rememberedRec.id);
        setMessages(deserializeThread(rememberedRec.messages));
        reseedReasoningTimers(rememberedRec.messages);
      } else if (remembered) {
        // Remembered an empty/unsaved (or pruned) session → keep the clean slate.
        activeSessionIdRef.current = remembered;
        setActiveSessionId(remembered);
        setMessages([]);
      } else {
        const recent = list[0];
        if (recent) {
          activeSessionIdRef.current = recent.id;
          setActiveSessionId(recent.id);
          setMessages(deserializeThread(recent.messages));
          reseedReasoningTimers(recent.messages);
        } else {
          const s = createSession(stageId);
          activeSessionIdRef.current = s.id;
          setActiveSessionId(s.id);
          setMessages([]);
        }
      }
    })();
  }, [stageId]);

  // Persist the thread whenever it settles (after a turn completes, not mid-run),
  // keyed by the current course. An effect — NOT an inline read after
  // setMessages — because a state updater does not run synchronously, so reading
  // "final" messages right after setMessages would serialize a stale/empty list.
  useEffect(() => {
    if (isRunning || messages.length === 0) return;
    const sid = useStageStore.getState().stage?.id;
    if (!sid) return;
    let sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      const s = createSession(sid);
      sessionId = s.id;
      activeSessionIdRef.current = s.id;
      setActiveSessionId(s.id);
    }
    rememberActiveSession(sid, sessionId);
    // Supply each reasoning block's final duration (keyed messageId:ordinal) so
    // "已思考 N s" survives a refresh.
    const timers = useThinkingTimers.getState().timers;
    const getDuration = (messageId: string | undefined, ordinal: number): number | undefined => {
      const tmr = timers[`${messageId}:${ordinal}`];
      return tmr && tmr.endedAt != null ? tmr.endedAt - tmr.startedAt : undefined;
    };
    const serialized = serializeThread(messages, getDuration);
    const now = Date.now();
    // saveSession preserves the persisted createdAt for an existing row, so a
    // fresh `now` here is only used when this session is first written.
    void saveSession({
      id: sessionId,
      stageId: sid,
      // Empty title → UI renders the localized "untitled" label.
      title: deriveSessionTitle(serialized, ''),
      messages: serialized,
      createdAt: now,
      updatedAt: now,
    }).then(() => refreshSessions());
  }, [messages, isRunning, refreshSessions]);

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
    messagesRef.current = [];
    setMessages([]);
    useRegenSnapshots.getState().clearAll();
    useThinkingTimers.getState().clear();
    const sid = useStageStore.getState().stage?.id;
    if (sid) {
      // Archive-then-new: the prior session stays in Dexie; just start a fresh,
      // empty active session (persisted lazily once it has messages). Remember it
      // so a refresh keeps the clean slate instead of reloading the old chat.
      const s = createSession(sid);
      activeSessionIdRef.current = s.id;
      setActiveSessionId(s.id);
      rememberActiveSession(sid, s.id);
    }
  }, []);

  // Switch the panel to a stored session from the history list.
  const switchSession = useCallback(
    async (id: string) => {
      // Clicking the already-active session is a no-op: don't abort an in-flight
      // run and reload the last-persisted row, which would drop the current
      // prompt / a just-finished turn whose save hasn't settled yet.
      if (id === activeSessionIdRef.current) return;
      // Load and VALIDATE the target before doing anything destructive. A stale
      // row (deleted/pruned in another tab, or foreign-stage and left open across
      // a switch) must just refresh the list — without aborting the current run.
      const rec = await loadSession(id);
      if (!rec || rec.stageId !== useStageStore.getState().stage?.id) {
        await refreshSessions();
        return;
      }
      // Target is valid — now abort the current run and switch to it.
      abortRef.current?.abort();
      abortRef.current = null;
      phaseRef.current = 'complete';
      setIsRunning(false);
      useRegenSnapshots.getState().clearAll();
      useThinkingTimers.getState().clear();
      activeSessionIdRef.current = rec.id;
      setActiveSessionId(rec.id);
      rememberActiveSession(rec.stageId, rec.id);
      const restored = deserializeThread(rec.messages);
      // Keep messagesRef in sync synchronously: onNew reads it to build the next
      // request's history, and it otherwise lags setMessages by a render — a prompt
      // sent right after switching would carry the OLD conversation as context.
      messagesRef.current = restored;
      setMessages(restored);
      reseedReasoningTimers(rec.messages);
    },
    [refreshSessions],
  );

  // Delete a session; if it was active, reset to a fresh empty session.
  const deleteSessionAndRefresh = useCallback(
    async (id: string) => {
      // Guard the same way as switchSession: a stale popover row from before a
      // stage switch must not delete a different stage's conversation.
      const rec = await loadSession(id);
      if (!rec || rec.stageId !== useStageStore.getState().stage?.id) {
        await refreshSessions();
        return;
      }
      await deleteSession(id);
      await refreshSessions();
      if (activeSessionIdRef.current === id) clearThread();
    },
    [refreshSessions, clearThread],
  );

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
        // The full outline list in CURRENT scene order — each scene resolved by
        // its stable `outlineId` (reorder/insert/delete rebalances `order`, and
        // inserted/duplicated scenes have no persisted outline). The persisted
        // `outlines` array is the original generation plan, so handing it over
        // raw would give regenerate-scene/-actions a stale page index / order /
        // title list. See resolveSceneOutline.
        const allOutlines = scenes.map((s) => resolveSceneOutline(s, outlines));
        const sceneContextMap: SceneContextMap = {};
        for (const scene of scenes) {
          const outline = resolveSceneOutline(scene, outlines);
          sceneContextMap[scene.id] = {
            outline,
            allOutlines,
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
    isSendDisabled: opts.isSendDisabled,
    onNew,
    onCancel,
    convertMessage: (m) => m,
  });

  return {
    runtime,
    clearThread,
    hasMessages: messages.length > 0,
    isRunning,
    sessions,
    activeSessionId,
    switchSession,
    deleteSessionAndRefresh,
    refreshSessions,
  };
}
