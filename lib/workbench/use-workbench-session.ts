'use client';

/**
 * The two live wires of the workbench.
 *
 * `useWorkbenchStream` owns the SSE attach; `useStageFreshnessSync` keeps the
 * course the canvas is displaying fresh via manifest diff + narrow scene
 * re-fetch (Mono #1960 Part 2).
 *
 * They are separate on purpose: the *chat* is a pure fold over the event log
 * and never queries anything, while the *course* is read through the app's real
 * DocumentStore. The events say "page 3 landed"; they do not carry the page.
 * Anything else would put the slide DSL in the event log and give the browser
 * two disagreeing copies of the course.
 *
 * Ported from the spike's `use-workbench-session.ts`, pointed at the PR1
 * control plane (`/api/agent/sessions/:id/events`, same-origin).
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
// The upstream host names this export `HOST_AGENT_LIFECYCLE`; the reference
// calls it `LIFECYCLE`. The values are the same durable event names.
import { HOST_AGENT_LIFECYCLE as LIFECYCLE } from '@/lib/agent-runtime/lifecycle';
import { getDocumentStore } from '@/lib/document-store/store';
import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { useStageStore } from '@/lib/store/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';
import {
  appendCompactedReplayEvent,
  compactReplayEvents,
  useWorkbenchStore,
  type WorkbenchEvent,
} from '@/lib/workbench/session-store';
import {
  diffStageManifest,
  fetchScenesByIds,
  fetchStageManifest,
  mergeFetchedScenes,
  type StageManifest,
} from '@/lib/workbench/stage-freshness';
import { applyGenerateTtsResultToScenes } from '@/lib/workbench/tts-stage-sync';

/**
 * pi's own `AgentEvent` types, which the runner appends verbatim.
 *
 * Hand-listed because they come from the agent library, not from us. The
 * runner's OWN events are not listed here — see `WORKBENCH_EVENT_TYPES`.
 */
const PI_EVENT_TYPES = [
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'turn_start',
  'turn_end',
  'agent_start',
  'agent_end',
] as const;

/**
 * Every named SSE frame the browser subscribes to.
 *
 * A native `EventSource` routes `event: user_question` ONLY to a listener
 * registered for that exact name — an unlisted type is dropped before any of
 * our code runs, with no error, in every environment. That is not a
 * hypothetical: the first `ask_user` question card shipped completely invisible
 * because the runner emitted `user_question`, the fold handled it, and this
 * list — then a hand-written copy of the lifecycle names — did not mention it.
 *
 * So the lifecycle half is now DERIVED from `LIFECYCLE` instead of retyped:
 * adding an event to that table is sufficient for the browser to receive it.
 * `tests/workbench/session-events-subscription.test.ts` pins the relationship.
 */
/**
 * Legacy lifecycle names still present in historical session logs. A native
 * `EventSource` routes a named frame ONLY to a listener registered for that
 * exact name, so a replayed `course_link` frame from a pre-rename transcript
 * would be dropped before the fold could see it unless this list still
 * subscribes to it. The reducer accepts both names with identical semantics.
 */
export const LEGACY_WORKBENCH_EVENT_TYPES: readonly string[] = [
  'course_link',
  // v1 lifecycle (pre open-domain): `switch_stage` moved the session's active
  // stage. The emitter is gone; historical logs still carry the frames and the
  // reducer replays them with their original stage-identity semantics.
  'active_stage_changed',
];

export const WORKBENCH_EVENT_TYPES: readonly string[] = [
  ...Object.values(LIFECYCLE),
  ...LEGACY_WORKBENCH_EVENT_TYPES,
  ...PI_EVENT_TYPES,
];

/**
 * Attach to a session's durable event stream.
 *
 * Resumes at the store's `lastEventId`, so:
 *  - first attach (0) replays the whole log and rebuilds the UI from scratch;
 *  - re-attach after the chat tree was unmounted asks only for the gap;
 *  - a native EventSource reconnect carries `Last-Event-ID` and hits the same
 *    server path.
 */
export function useWorkbenchStream(sessionId: string | null): void {
  const applyEvent = useWorkbenchStore((s) => s.applyEvent);
  const applyEvents = useWorkbenchStore((s) => s.applyEvents);
  const setAttached = useWorkbenchStore((s) => s.setAttached);
  const finishReplayState = useWorkbenchStore((s) => s.finishReplay);
  const setError = useWorkbenchStore((s) => s.setError);

  useEffect(() => {
    if (!sessionId) return;
    // The header title wants the prompt before the runner emits session_start
    // (a queued session can sit there a while), and a `?session=` deep link
    // arrives without the session's own stage — one meta fetch covers both.
    fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((meta) => {
        // A switch to another session must not let this late response write
        // the wrong prompt over it.
        if (useWorkbenchStore.getState().sessionId !== sessionId) return;
        if (meta && typeof meta.prompt === 'string') {
          const status =
            meta.status === 'queued' ||
            meta.status === 'running' ||
            meta.status === 'succeeded' ||
            meta.status === 'failed' ||
            meta.status === 'cancelled'
              ? meta.status
              : undefined;
          useWorkbenchStore.getState().setSessionBootstrap({
            prompt: meta.prompt,
            // Always seeded, including as null: a session with no override must
            // clear whatever the previously attached one had.
            title: typeof meta.title === 'string' && meta.title ? meta.title : null,
            ...(status ? { status } : {}),
            ...(typeof meta.stageId === 'string' && meta.stageId ? { stageId: meta.stageId } : {}),
          });
        }
      })
      .catch(() => {});
    // Read the resume point imperatively: subscribing to `lastEventId` would
    // re-run this effect on every event and reconnect in a loop.
    const from = useWorkbenchStore.getState().lastEventId;
    const source = new EventSource(
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/events?lastEventId=${from}`,
    );

    let connected = false;
    let caughtUp = false;
    let active = true;
    const backlog: WorkbenchEvent[] = [];
    const isCurrent = () => active && useWorkbenchStore.getState().sessionId === sessionId;
    const markAttached = () => {
      if (connected || !isCurrent()) return;
      connected = true;
      setAttached(true);
      setError(null);
    };
    const onAny = (e: MessageEvent) => {
      if (!isCurrent()) return;
      let parsed: WorkbenchEvent;
      try {
        parsed = JSON.parse(e.data) as WorkbenchEvent;
      } catch {
        return;
      }
      if (!caughtUp) {
        appendCompactedReplayEvent(backlog, parsed);
        return;
      }
      applyEvent(parsed);
      markAttached();

      // A checkpoint schedules the normal whole-document course sync. TTS
      // additionally folds its authoritative action array at tool completion,
      // so an already-mounted PlaybackEngine cannot retain the pre-TTS scene
      // while the success card is visible. Guard both identities: the user may
      // have switched either the conversation or the course since this
      // EventSource was attached.
      if (parsed.type === 'tool_execution_end') {
        const workbench = useWorkbenchStore.getState();
        const stage = useStageStore.getState();
        if (
          workbench.sessionId === sessionId &&
          workbench.stageId &&
          stage.stage?.id === workbench.stageId
        ) {
          const scenes = applyGenerateTtsResultToScenes(stage.scenes, parsed);
          if (scenes !== stage.scenes) useStageStore.setState({ scenes: [...scenes] });
        }
      }
    };

    // "You are caught up", as a real event: a client attaching in the middle of
    // a five-minute tool call would otherwise sit on "replaying" until the next
    // frame, and a re-attach to a finished session at its last event id would
    // receive nothing at all.
    const finishReplay = () => {
      if (caughtUp) return;
      caughtUp = true;
      if (!isCurrent()) {
        backlog.length = 0;
        return;
      }
      applyEvents(compactReplayEvents(backlog));
      backlog.length = 0;
      // Record which stage links were historical in the same state transition
      // that exposes the fold. Opening a chat must not replay its old classroom
      // navigation into the independent right pane.
      finishReplayState();
    };
    const onCaughtUp = () => {
      if (!isCurrent()) return;
      finishReplay();
      markAttached();
    };
    source.addEventListener('caught_up', onCaughtUp);
    const replayWatchdog = window.setTimeout(finishReplay, 20_000);

    for (const type of WORKBENCH_EVENT_TYPES) source.addEventListener(type, onAny as EventListener);
    source.onerror = () => {
      if (!isCurrent()) return;
      // During native auto-reconnect the server snapshot is more current than
      // this frozen fold. The next received frame marks it attached again.
      connected = false;
      setAttached(false);
      // EventSource retries on its own; only surface a hard failure.
      if (source.readyState === EventSource.CLOSED) {
        finishReplay();
        setError('event stream closed');
      }
    };

    return () => {
      active = false;
      caughtUp = true;
      backlog.length = 0;
      window.clearTimeout(replayWatchdog);
      for (const type of WORKBENCH_EVENT_TYPES)
        source.removeEventListener(type, onAny as EventListener);
      source.removeEventListener('caught_up', onCaughtUp);
      source.close();
      if (useWorkbenchStore.getState().sessionId === sessionId) setAttached(false);
    };
  }, [sessionId, applyEvent, applyEvents, setAttached, finishReplayState, setError]);
}

/**
 * The canvas's narrow freshness sync (Mono #1960 Part 2).
 *
 * Replaces the old whole-document course sync: instead of "revision changed →
 * re-read the entire document", the canvas now keeps the manifest it rendered
 * with (`{stageRev, per-scene rev}`) and, on a trigger, re-pulls the manifest,
 * diffs it, and re-fetches ONLY the scenes whose rev changed (via
 * `GET /api/stages/:id/scenes?ids=`). One page commit moves one ~14.5kB scene
 * instead of the whole ~100kB document.
 *
 * TRIGGERS — every freshness path the spec requires:
 *   - a `stage_freshness` frame from the dedicated SSE stream
 *     (`GET /api/stages/:id/freshness`, itself woken by the 0071 DB triggers);
 *   - tab focus (`visibilitychange`);
 *   - an EventSource re-open after a drop (frames lost during the gap);
 *   - a low-frequency fallback timer (period + jitter) — the correctness
 *     backstop when the stream is dead or a signal was dropped; and
 *   - a user-triggered manual reload of a protected scene (LWW #6).
 *
 * The stream is a PURE optimization: if it never connects, the fallback still
 * converges, just on the fallback clock. This is the "push for latency, pull for correctness"
 * principle the session list already follows.
 *
 * BASELINE (why the first pass is special): the sync diffs against "the
 * manifest it rendered with", and revs live only server-side. The manifest is
 * therefore fetched BEFORE any full read, so the recorded baseline is never
 * NEWER than the content it describes (a newer-than-content baseline would
 * hide writes that landed in between — the reverse order is harmless: such a
 * scene shows up as changed on the next diff and is re-fetched once).
 *
 * Two first-pass shapes:
 *   - `bootstrapDocument` lets a host explicitly delegate its initial document
 *     read to this sync. This is a generic cold-start capability and is not
 *     driven by chat/session status.
 *   - otherwise the classroom load owns the store: the sync never does a full
 *     read. If the store is already warm it records a ZEROED baseline so the
 *     next pass verifies the true scene revs exactly once; if still cold it
 *     records the real manifest (safe — the classroom load's content lands
 *     after, so any write between the two is caught by the next diff).
 *
 * FAILURE CONTRACT (the old `if (!doc) continue;` fix): an unreadable
 * manifest or document is now EXPLICIT — it throws into a bounded retry
 * budget, is logged, and the fallback clock keeps ticking underneath. It is
 * never silently swallowed, so a course that does not exist yet cannot park
 * the canvas on an empty state forever.
 *
 * STABLE REFERENCE (feature 3 of 3): incremental applies never rebuild the
 * `scenes` array wholesale — `mergeFetchedScenes` returns the SAME array when
 * nothing changed, so a deck the agent did not touch does not re-render every
 * consumer that memoizes on `scenes`.
 *
 * EDIT-STATE PROTECTION (REMOVED, #1961 decision change 2026-08-23): the read path no
 * longer freezes the page being edited — an agent refresh replaces it
 * outright. The user's typed data is guarded on the WRITE side instead: a
 * save veto retains the pending dirt and retries once the baseline converges
 * (see `lib/store/stage.ts`), so a false veto can no longer silently eat
 * keystrokes.
 *
 * FAILURE CONTRACT (cr D3-F1 hardening): a pass whose batch fetch returns
 * NOTHING for a non-empty request aborts WITHOUT advancing the rendered
 * manifest or the write baseline — "could not fetch" must never be recorded
 * as "already up to date" (that is how a zeroed baseline polluted the write
 * baseline and permanently vetoed every save on >200-scene courses).
 */
const STAGE_SYNC_FALLBACK_MS = 30_000;
/** Jitter band around the fallback period, so a fleet of tabs desyncs. */
const STAGE_SYNC_FALLBACK_JITTER = 0.2;
const STAGE_SYNC_RETRY_DELAY_MS = 3_000;
const STAGE_SYNC_MAX_RETRIES = 5;

export function useStageFreshnessSync(
  stageId: string | null,
  opts: { bootstrapDocument?: boolean } = {},
): void {
  const { bootstrapDocument = false } = opts;
  const generation = useRef(0);
  const activeStage = useRef<string | null>(null);
  /**
   * Tokens of the passes currently in flight, per stage generation (cr D3-F4).
   * A single `inFlight` slot was the bug: it let one course's in-flight pass
   * block another course's mount sync, and a stale pass's late `finally`
   * could clobber the new course's retry clock. Tracking per token means a
   * NEW stage's sync starts immediately while the old stage's pass is still
   * awaiting — each pass is fenced by its own `isCurrent()` anyway, so they
   * cannot write into each other's store state.
   */
  const inFlightTokens = useRef<Set<number>>(new Set());
  const pendingSync = useRef(0);
  const served = useRef(0);
  const renderedManifest = useRef<StageManifest | null>(null);
  const mounted = useRef(false);
  const retries = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  // Read at pass time so an explicit host handoff uses the current bootstrap
  // policy without restarting the course's freshness stream.
  const bootstrapDocumentRef = useRef(bootstrapDocument);
  useEffect(() => {
    bootstrapDocumentRef.current = bootstrapDocument;
  }, [bootstrapDocument]);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    };
  }, []);

  // Commit the stage fence in a layout effect: it runs before promise
  // continuations can observe the newly committed UI, while an abandoned
  // concurrent render never mutates the durable refs.
  useLayoutEffect(() => {
    generation.current += 1;
    activeStage.current = stageId;
    inFlightTokens.current.clear();
    pendingSync.current = 0;
    served.current = 0;
    renderedManifest.current = null;
    retries.current = 0;
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    if (fallbackTimer.current) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }
  }, [stageId]);

  useEffect(() => {
    if (!stageId) return;
    const token = generation.current;
    const requestedStage = stageId;
    const isCurrent = () =>
      mounted.current && generation.current === token && activeStage.current === requestedStage;

    /**
     * Mirror the read-side rendered manifest into the store's write-side
     * baseline (the aggregate-save veto, #1960 Part 2 fix): the save paths
     * compare that baseline against a manifest fetched at write time, so it
     * must track what THIS browser has actually applied. Recorded on every
     * pass EXCEPT the warm zeroed-baseline branch below, where scene revs are
     * unknown — recording the zeroed manifest there would make every later
     * save look stale; the store's own load records the true baseline instead.
     */
    const recordWriteBaseline = (fresh: StageManifest) => {
      const previous = useStageStore.getState().serverManifestByStage?.[requestedStage];
      // Revs never roll back (Part 1): a stale response must not regress the
      // baseline and re-open a false veto.
      if (previous && fresh.rev < previous.rev) return;
      useStageStore.setState((state) => ({
        serverManifestByStage: { ...state.serverManifestByStage, [requestedStage]: fresh },
      }));
    };

    const scheduleFallback = () => {
      // A stale pass's late `finally` (after a course switch) must not clobber
      // the CURRENT stage's fallback timer — that timer is the convergence
      // backstop when the stream is dead (cr D3-F4).
      if (!isCurrent()) return;
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
      const jitter = 1 + (Math.random() * 2 - 1) * STAGE_SYNC_FALLBACK_JITTER;
      fallbackTimer.current = setTimeout(() => {
        fallbackTimer.current = null;
        if (!isCurrent()) return;
        requestSync('fallback');
      }, STAGE_SYNC_FALLBACK_MS * jitter);
    };

    /** One pass: manifest → diff → narrow re-fetch → local apply. */
    const syncOnce = async () => {
      const manifestResult = await fetchStageManifest(requestedStage);
      if (!isCurrent()) return;
      if (manifestResult.status !== 'ok') {
        // The old `if (!doc) continue;` swallowed this and never entered the
        // retry budget; a just-created course could park the canvas on empty
        // forever. Now it is explicit: logged, retried, and the fallback clock
        // keeps ticking underneath. Both `missing` (course not created yet /
        // non-live) and `transient` (-live 5xx / network) land here.
        console.warn(`[workbench] manifest unavailable for ${requestedStage}; retrying`);
        throw new Error(`stage manifest unavailable for ${requestedStage}`);
      }
      const manifest = manifestResult.manifest;

      if (renderedManifest.current === null) {
        // First pass for this stage — establish the rendered baseline.
        if (bootstrapDocumentRef.current) {
          // The sync is the delegated initial reader: one full read, manifest first so the
          // recorded baseline is never newer than the content it describes.
          const doc = await getDocumentStore().loadDocument(requestedStage);
          if (!isCurrent()) return;
          if (!doc) {
            console.warn(`[workbench] course document unavailable for ${requestedStage}; retrying`);
            throw new Error(`course document unavailable for ${requestedStage}`);
          }
          const scenes = [...(doc.scenes as unknown as Scene[])].sort((a, b) => a.order - b.order);
          const record = doc.outline as AppDocumentOutline | undefined;
          const outlines = (record?.outlines as SceneOutline[]) ?? [];
          useStageStore.setState((state) => ({
            stage: (doc.stage as unknown as Stage) ?? state.stage,
            scenes,
            outlines,
            // Select the newest page the first time anything exists, then
            // leave the user's selection alone.
            currentSceneId:
              state.currentSceneId && scenes.some((s) => s.id === state.currentSceneId)
                ? state.currentSceneId
                : (scenes[scenes.length - 1]?.id ?? null),
            generationComplete: record?.generationComplete ?? false,
            outlineProducer: record?.producer ?? state.outlineProducer,
          }));
          renderedManifest.current = manifest;
          recordWriteBaseline(manifest);
          return;
        }

        // The classroom load owns the store; the sync only keeps it fresh.
        // NEVER apply here — filling the store first would trip the classroom
        // load's warm-skip and lose media/ownership hydration.
        const store = useStageStore.getState();
        const warm = store.stage?.id === requestedStage && store.scenes.length > 0;
        if (warm) {
          // Content revs are unknown (the load does not carry them). Record a
          // ZEROED baseline so the next pass treats every scene as changed and
          // verifies the true revs exactly once — this closes the window where
          // a manifest recorded after the load could hide a write that landed
          // in between.
          renderedManifest.current = {
            rev: manifest.rev,
            scenes: manifest.scenes.map((scene) => ({ ...scene, rev: 0 })),
          };
        } else {
          // Store still cold: record the real manifest. The classroom load's
          // content lands after, so any write between here and there shows up
          // as a change on the next diff (never hidden).
          renderedManifest.current = manifest;
          recordWriteBaseline(manifest);
        }
        return;
      }

      const diff = diffStageManifest(renderedManifest.current, manifest);
      if (diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0) {
        // Only the stage rev moved (an outline/stage-name write): record it,
        // nothing else to do — scene content is unchanged.
        renderedManifest.current = manifest;
        recordWriteBaseline(manifest);
        return;
      }

      const idsToFetch = [...diff.changed, ...diff.added];
      const fetched = await fetchScenesByIds(requestedStage, idsToFetch);
      if (!isCurrent()) return;

      // D3-F1 structural guard: a non-empty request that fetched NOTHING must
      // abort this pass — do NOT advance `renderedManifest`, do NOT
      // `recordWriteBaseline` (a zeroed baseline written here would make every
      // later save look stale and permanently veto the course). Throwing lands
      // in the retry budget; the fallback clock keeps ticking underneath. Even
      // if the chunked fetch has a bug, "could not fetch" is never recorded as
      // "already up to date".
      if (idsToFetch.length > 0 && fetched.length === 0) {
        console.warn(
          `[workbench] batch scene fetch returned nothing for ${requestedStage} ` +
            `(${idsToFetch.length} ids); aborting pass`,
        );
        throw new Error(`batch scene fetch returned nothing for ${requestedStage}`);
      }

      const appliedIds = new Set(fetched.map((scene) => scene.id));
      const merge = mergeFetchedScenes({
        current: useStageStore.getState().scenes,
        fetched,
        removedIds: diff.removed,
      });
      if (merge.changed) {
        useStageStore.setState((state) => {
          const nextScenes = merge.changed ? (merge.scenes as Scene[]) : state.scenes;
          const current = state.currentSceneId;
          const currentSceneId =
            current && nextScenes.some((s) => s.id === current)
              ? current
              : (nextScenes[nextScenes.length - 1]?.id ?? null);
          return {
            scenes: nextScenes,
            ...(currentSceneId !== current ? { currentSceneId } : {}),
          };
        });
      }

      // Advance the rendered manifest to what the store now holds: applied
      // scenes get their fresh rev/order, removed scenes are dropped. Scenes
      // that were in the diff but NOT fetched (a chunk failed) keep their old
      // rev so the next pass re-attempts them — partial failure must never be
      // recorded as fully applied (cr D3-F3).
      const freshById = new Map(manifest.scenes.map((scene) => [scene.id, scene]));
      const renderedById = new Map(
        (renderedManifest.current as StageManifest).scenes.map((scene) => [scene.id, scene]),
      );
      for (const sceneId of diff.removed) renderedById.delete(sceneId);
      for (const sceneId of appliedIds) {
        const fresh = freshById.get(sceneId);
        if (fresh) renderedById.set(sceneId, fresh);
      }
      renderedManifest.current = {
        rev: manifest.rev,
        scenes: [...renderedById.values()].sort((a, b) => a.order - b.order),
      };
      // The write-side baseline mirrors the rendered manifest: every applied
      // scene carries its fresh rev (no edit-state protection anymore, so no
      // scene keeps an old rev here — #1961 decision change).
      recordWriteBaseline(renderedManifest.current);
    };

    const runPass = async (_reason: string) => {
      try {
        while (isCurrent() && pendingSync.current > served.current) {
          served.current = pendingSync.current;
          await syncOnce();
          if (!isCurrent()) return;
        }
        // Everything asked for has been served; the next failure starts its
        // retry budget from zero again.
        retries.current = 0;
      } catch (error) {
        if (!isCurrent()) return;
        console.warn('[workbench] stage freshness sync failed', error);
        if (retries.current < STAGE_SYNC_MAX_RETRIES) {
          retries.current += 1;
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            if (!isCurrent() || inFlightTokens.current.has(token)) return;
            requestSync('retry');
          }, STAGE_SYNC_RETRY_DELAY_MS);
        }
      } finally {
        inFlightTokens.current.delete(token);
        scheduleFallback();
      }
    };

    const requestSync = (reason: string) => {
      pendingSync.current += 1;
      // Coalesce only passes of the SAME stage generation (cr D3-F4): a
      // different stage's in-flight pass must not block this stage's mount
      // sync. Each pass is independently fenced by `isCurrent()`.
      if (inFlightTokens.current.has(token)) return;
      inFlightTokens.current.add(token);
      void runPass(reason);
    };

    // ── triggers ───────────────────────────────────────────────────────────
    requestSync('mount');

    const source = new EventSource(`/api/stages/${encodeURIComponent(requestedStage)}/freshness`);
    sourceRef.current = source;
    let streamHadError = false;
    const onFreshnessFrame = () => {
      if (isCurrent()) requestSync('freshness');
    };
    source.addEventListener('stage_freshness', onFreshnessFrame);
    source.onopen = () => {
      if (!isCurrent()) return;
      // First open and every re-open pull the manifest once: a drop means
      // frames between the last pull and now were lost (EventSource has no
      // replay here by design — freshness is volatile).
      requestSync(streamHadError ? 'reconnect' : 'open');
      streamHadError = false;
    };
    source.onerror = () => {
      if (!isCurrent()) return;
      streamHadError = true;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && isCurrent()) requestSync('focus');
    };
    document.addEventListener('visibilitychange', onVisibility);

    // The aggregate-save veto bumped the store's sync-request tick when it
    // refused a write: the server moved past the browser's baseline, so the
    // store must converge before the user's next save is judged. Run one pass
    // (the store's tick only moves forward, so a repeat render cannot loop).
    const unsubscribeVetoSync = useStageStore.subscribe((state, prev) => {
      const now = (state as { stageSyncRequest?: number }).stageSyncRequest ?? 0;
      const before = (prev as { stageSyncRequest?: number }).stageSyncRequest ?? 0;
      if (now > before && isCurrent()) requestSync('veto');
    });

    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
      source.removeEventListener('stage_freshness', onFreshnessFrame);
      source.onopen = null;
      source.onerror = null;
      source.close();
      if (sourceRef.current === source) sourceRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribeVetoSync();
    };
  }, [stageId]);
}
