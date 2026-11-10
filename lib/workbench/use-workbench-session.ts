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
import { recordAgentChange } from '@/lib/edit/course-edit';
import { useCourseTimeline } from '@/lib/edit/course-timeline';
import { keepLocalWhereUnchanged } from '@/lib/edit/scene-echo';
import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { hydratePBLScenesFromRuntime } from '@/lib/pbl/v2/runtime/hydration';
import { forgetKnownScenes } from '@/lib/store/known-scenes';
import {
  forgetServerRosterBase,
  hasQueuedWholeDocumentChange,
  hasUnsavedSceneEdit,
  hasUnsavedStageEdit,
  isStageWriteInFlight,
  recordServerRosterBase,
  serverRosterBaseOf,
  stageDocumentEditClock,
  useStageStore,
  isServerGeneratingStage,
} from '@/lib/store/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';
import {
  appendCompactedReplayEvent,
  compactReplayEvents,
  useWorkbenchStore,
  type WorkbenchEvent,
} from '@/lib/workbench/session-store';
import { applyMediaReadyFrame, parseMediaReadyFrame } from '@/lib/workbench/media-lifecycle';
import {
  diffStageManifest,
  fetchScenesByIds,
  fetchStageManifest,
  fetchStageRoster,
  sameStageRoster,
  stageRosterChanged,
  type StageRoster,
  mergeFetchedScenes,
  type StageManifest,
  withLocalSceneOrder,
} from '@/lib/workbench/stage-freshness';
import { FetchEventSource } from '@/lib/utils/fetch-event-source';
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

/** How long an open stream may take to send `caught_up`. */
const REPLAY_WATCHDOG_MS = 20_000;
/** How long the transcript may wait for a stream that has not opened at all. */
const REPLAY_BACKSTOP_MS = 120_000;

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
    let active = true;
    const isCurrent = () => active && useWorkbenchStore.getState().sessionId === sessionId;
    const expectedTitleRevision = useWorkbenchStore.getState().sessionTitleRevision;
    // The header title wants the prompt before the runner emits session_start
    // (a queued session can sit there a while), and a `?session=` deep link
    // arrives without the session's own stage — one meta fetch covers both.
    fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((meta) => {
        // A switch away invalidates this attachment even if the user later
        // returns to the same id before its old request settles.
        if (!isCurrent()) return;
        if (meta && typeof meta.prompt === 'string') {
          const status =
            meta.status === 'queued' ||
            meta.status === 'running' ||
            meta.status === 'succeeded' ||
            meta.status === 'failed' ||
            meta.status === 'cancelled'
              ? meta.status
              : undefined;
          const detailTitle = typeof meta.title === 'string' && meta.title ? meta.title : null;
          useWorkbenchStore.getState().setSessionBootstrap({
            prompt: meta.prompt,
            // Detail is only the cold-start title source. Once the owner list,
            // an owner event, or a local decision has seeded this attachment,
            // a GET that overtook an uncommitted PATCH must not replace it.
            ...(expectedTitleRevision === 0 ? { title: detailTitle, expectedTitleRevision } : {}),
            ...(status ? { status } : {}),
            ...(typeof meta.stageId === 'string' && meta.stageId ? { stageId: meta.stageId } : {}),
          });
        }
      })
      .catch(() => {});
    // Read the resume point imperatively: subscribing to `lastEventId` would
    // re-run this effect on every event and reconnect in a loop.
    const from = useWorkbenchStore.getState().lastEventId;
    const source = new FetchEventSource(
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/events?lastEventId=${from}`,
    );

    let connected = false;
    let caughtUp = false;
    const backlog: WorkbenchEvent[] = [];
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
        armReplayWatchdog();
        return;
      }
      applyEvent(parsed);
      markAttached();
      // Start first: it judges an abandoned run by how long that run has been silent.
      if (parsed.type === 'agent_start') useCourseTimeline.getState().beginAgentRun(Date.now());
      else useCourseTimeline.getState().touchAgentRun(Date.now());
      if (parsed.type === 'agent_end' || parsed.type === LIFECYCLE.sessionEnd) {
        useCourseTimeline.getState().endAgentRun(Date.now());
      }

      // Async media completion (generate_video's detached job) settles into
      // the media generation store keyed by the placeholder ref — live frames
      // here, replayed frames in finishReplay below.
      if (parsed.type === LIFECYCLE.mediaReady) {
        const frame = parseMediaReadyFrame(parsed.data);
        if (frame) applyMediaReadyFrame(frame);
      }

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
          if (scenes !== stage.scenes) {
            useStageStore.setState({ scenes: [...scenes] });
            recordAgentChange(stage);
          }
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
      // Attached in the middle of a run: its later writes still belong together.
      const lastRunEvent = backlog.findLast(
        (event) =>
          event.type === 'agent_start' ||
          event.type === 'agent_end' ||
          event.type === LIFECYCLE.sessionEnd,
      );
      if (lastRunEvent?.type === 'agent_start') {
        useCourseTimeline.getState().beginAgentRun(Date.now());
      }
      applyEvents(compactReplayEvents(backlog));
      // Replay the media_ready side effect too: a failed job never lands in
      // the document, so without this fold a re-attached client would keep
      // the placeholder's skeleton instead of the error state.
      for (const event of backlog) {
        if (event.type !== LIFECYCLE.mediaReady) continue;
        const frame = parseMediaReadyFrame(event.data);
        if (frame) applyMediaReadyFrame(frame);
      }
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
    // A low-priority request can wait in the browser's queue for as long as other
    // requests hold it there, so the wait for `caught_up` runs only while a
    // connection is open and counts from its last sign of progress. Finishing early
    // would let the late replay in as live frames: an old course link would open its
    // tab. The backstop only ends the spinner on a stream that never gets through.
    let replayWatchdog: number | undefined;
    const armReplayWatchdog = () => {
      window.clearTimeout(replayWatchdog);
      if (!caughtUp) replayWatchdog = window.setTimeout(finishReplay, REPLAY_WATCHDOG_MS);
    };
    source.addEventListener('open', armReplayWatchdog);
    const replayBackstop = window.setTimeout(finishReplay, REPLAY_BACKSTOP_MS);

    for (const type of WORKBENCH_EVENT_TYPES) source.addEventListener(type, onAny as EventListener);
    source.onerror = () => {
      if (!isCurrent()) return;
      window.clearTimeout(replayWatchdog);
      // During native auto-reconnect the server snapshot is more current than
      // this frozen fold. The next received frame marks it attached again.
      connected = false;
      setAttached(false);
      // EventSource retries on its own; only surface a hard failure.
      if (source.readyState === FetchEventSource.CLOSED) {
        finishReplay();
        setError('event stream closed');
      }
    };

    return () => {
      active = false;
      caughtUp = true;
      backlog.length = 0;
      window.clearTimeout(replayWatchdog);
      window.clearTimeout(replayBackstop);
      source.removeEventListener('open', armReplayWatchdog);
      for (const type of WORKBENCH_EVENT_TYPES)
        source.removeEventListener(type, onAny as EventListener);
      source.removeEventListener('caught_up', onCaughtUp);
      source.close();
      useCourseTimeline.getState().endAgentRun(Date.now());
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
 *   - a save of the course finishing, when the last pass left scenes alone
 *     for it (see UNSAVED EDITS).
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
 * UNSAVED EDITS: a scene with an edit this browser has not finished saving is
 * left as it is (`hasUnsavedSceneEdit`). Taking the server's copy would discard
 * the edit, and the queued save would then write the copy over it. There is no
 * merging: the scene keeps its old rev in the rendered manifest, so a later pass
 * reads it again; the pass runs as soon as the save finishes (`stageSyncRequest`).
 * Writes are last-write-wins on the server, so a remote change to the scene that
 * landed before that save is replaced by it. A scene with no unsaved edit takes
 * the server's copy outright, including the page open in the editor.
 *
 * The check runs before the read and again after it. A read older than an edit
 * made since it started is dropped, even if that edit is already saved.
 *
 * A structural or outline change waiting in the debounce is different: its flush
 * saves the store's scene list as the whole document, deleting whatever is absent
 * from it, so holding remote scenes back would erase them. They are taken on top of
 * the local list and order; only a scene deleted locally stays out.
 *
 * FAILURE CONTRACT (cr D3-F1 hardening): a pass whose batch fetch returns
 * NOTHING for a non-empty request aborts WITHOUT advancing the rendered
 * manifest or the store's baseline — "could not fetch" must never be recorded
 * as "already up to date".
 */
const STAGE_SYNC_FALLBACK_MS = 30_000;
/** Jitter band around the fallback period, so a fleet of tabs desyncs. */
const STAGE_SYNC_FALLBACK_JITTER = 0.2;
const STAGE_SYNC_RETRY_DELAY_MS = 3_000;
const STAGE_SYNC_MAX_RETRIES = 5;
/** The roster fields of a stage, as the roster route answers them. */
function rosterOf(stage: Stage): StageRoster {
  return {
    ...(stage.agentIds ? { agentIds: stage.agentIds } : {}),
    ...(stage.generatedAgentConfigs ? { generatedAgentConfigs: stage.generatedAgentConfigs } : {}),
  };
}

/**
 * The scenes as a classroom holds them. A stored PBL project is a design template,
 * with the learner's work in the runtime store, so it is folded back in here as on
 * a load. Taken as stored it would empty the project on screen, and the next save
 * would record that as the learner's state. A scene whose fold fails is left out:
 * it keeps its old rev and is read again, and the others still go through.
 */
async function readScenes(
  stageId: string,
  ids: readonly string[],
): Promise<{ scenes: Scene[]; foldFailures: number }> {
  const fetched = await fetchScenesByIds(stageId, ids);
  const folded = await Promise.allSettled(
    fetched.map((scene) => hydratePBLScenesFromRuntime(stageId, [scene])),
  );
  return {
    scenes: folded.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])),
    foldFailures: folded.filter((result) => result.status === 'rejected').length,
  };
}

/** A stage rev no manifest carries: the next pass treats the stage as moved. */
const UNVERIFIED_STAGE_REV = -1;

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
  /** This run's baseline is a manifest from before the classroom load (see below). */
  const coldBaseline = useRef(false);
  /** The last pass left scenes behind for a save still to finish (see UNSAVED EDITS). */
  const heldBackForSave = useRef(false);
  const mounted = useRef(false);
  const retries = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceRef = useRef<FetchEventSource | null>(null);
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
    coldBaseline.current = false;
    heldBackForSave.current = false;
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
     * Mirror the rendered manifest into the store (`serverManifestByStage`):
     * what THIS browser has actually applied. Recorded on every pass EXCEPT the
     * warm zeroed-baseline branch below, where scene revs are unknown, and a run
     * that started cold: its manifest describes what the load was going to bring,
     * which a later start must not take as applied.
     */
    const recordWriteBaseline = (fresh: StageManifest) => {
      if (coldBaseline.current) return;
      const previous = useStageStore.getState().serverManifestByStage?.[requestedStage];
      // Revs never roll back (Part 1): a stale response must not regress the
      // baseline.
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
      heldBackForSave.current = false;
      // Taken before the manifest: one older than an edit made since must not
      // decide what to drop or read, even if that edit is already saved.
      const editClock = stageDocumentEditClock();
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
          const editClock = stageDocumentEditClock();
          const doc = await getDocumentStore().loadDocument(requestedStage);
          if (!isCurrent()) return;
          let loadedScenes = (doc?.scenes ?? []) as unknown as Scene[];
          if (loadedScenes.some((scene) => scene.content?.type === 'pbl')) {
            loadedScenes = await hydratePBLScenesFromRuntime(requestedStage, loadedScenes);
            if (!isCurrent()) return;
          }
          if (!doc) {
            console.warn(`[workbench] course document unavailable for ${requestedStage}; retrying`);
            throw new Error(`course document unavailable for ${requestedStage}`);
          }
          // This read replaces every scene; it waits for any unsaved edit.
          if (stageDocumentEditClock() !== editClock) {
            requestSync('edited-during-read');
            return;
          }
          if (
            hasQueuedWholeDocumentChange(requestedStage) ||
            useStageStore
              .getState()
              .scenes.some((scene) => hasUnsavedSceneEdit(requestedStage, scene.id))
          ) {
            heldBackForSave.current = true;
            return;
          }
          const scenes = [...loadedScenes].sort((a, b) => a.order - b.order);
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
          const loadedStage = useStageStore.getState().stage;
          if (loadedStage?.id === requestedStage) {
            recordServerRosterBase(requestedStage, rosterOf(loadedStage));
          }
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
          // The roster the load brought is the server's, as far as this
          // browser knows: the merge base (see `syncRoster`).
          recordServerRosterBase(requestedStage, rosterOf(store.stage!));
          // Content revs are unknown (the load does not carry them). Record a
          // ZEROED baseline so the next pass treats every scene as changed and
          // verifies the true revs exactly once — this closes the window where
          // a manifest recorded after the load could hide a write that landed
          // in between. The stage rev is a sentinel no manifest carries, for
          // the same reason: a roster written between the load and here is
          // read on the next pass, not hidden behind the rev recorded now.
          //
          // Unless this page has synced the course before: what it recorded then
          // is what it applied, so it is never newer than the store, and only
          // what changed since is read again (a host that stops and starts the
          // sync does not re-read the whole course each time).
          renderedManifest.current = store.serverManifestByStage?.[requestedStage] ?? {
            rev: UNVERIFIED_STAGE_REV,
            scenes: manifest.scenes.map((scene) => ({ ...scene, rev: 0 })),
          };
        } else {
          // Store still cold: no roster known yet (a base from an earlier
          // visit may be stale); the first roster read records one.
          forgetServerRosterBase(requestedStage);
          // Store still cold: record the real manifest. The classroom load's
          // content lands after, so any write between here and there shows up
          // as a change on the next diff (never hidden).
          renderedManifest.current = manifest;
          coldBaseline.current = true;
        }
        return;
      }

      const previousStageRev = renderedManifest.current.rev;
      const diff = diffStageManifest(renderedManifest.current, manifest);
      if (diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0) {
        // Only the stage rev moved (an outline/stage-name/roster write): scene
        // content is unchanged, the roster may not be.
        await settleStage(manifest, previousStageRev);
        return;
      }

      const idsToFetch = [...diff.changed, ...diff.added];
      const idsToRead = idsToFetch.filter((id) => !hasUnsavedSceneEdit(requestedStage, id));
      const queuedAtRead = hasQueuedWholeDocumentChange(requestedStage);
      if (queuedAtRead || idsToRead.length < idsToFetch.length) heldBackForSave.current = true;
      const { scenes: fetched, foldFailures } = await readScenes(requestedStage, idsToRead);
      if (!isCurrent()) return;

      // D3-F1 structural guard: a non-empty request that fetched NOTHING must
      // abort this pass — do NOT advance `renderedManifest`, do NOT
      // `recordWriteBaseline`. Throwing lands in the retry budget; the fallback
      // clock keeps ticking underneath. Even if the chunked fetch has a bug,
      // "could not fetch" is never recorded as "already up to date".
      if (idsToRead.length > 0 && fetched.length === 0) {
        console.warn(
          `[workbench] batch scene fetch returned nothing for ${requestedStage} ` +
            `(${idsToRead.length} ids); aborting pass`,
        );
        throw new Error(`batch scene fetch returned nothing for ${requestedStage}`);
      }

      // The store holds another course (the classroom load has not caught up
      // with this stage, or has moved on): these scenes are not its to take.
      if (useStageStore.getState().stage?.id !== requestedStage) return;
      // Edited since the read started: the response may be older than the edit
      // even if that edit is already saved, so read again now.
      if (stageDocumentEditClock() !== editClock) {
        requestSync('edited-during-read');
        return;
      }
      // Either way the local scene list is the one to keep: the change may have
      // been saved while the read was out, and the read would be older than it.
      const keepLocalList = queuedAtRead || hasQueuedWholeDocumentChange(requestedStage);
      const before = useStageStore.getState();
      const localScenes = before.scenes;
      const localIds = new Set(localScenes.map((scene) => scene.id));
      const remoteOnly = new Set(diff.added);
      const applicable = fetched.filter(
        (scene) =>
          !hasUnsavedSceneEdit(requestedStage, scene.id) &&
          // Known to the server and not here: deleted locally, not remote news.
          (!keepLocalList || localIds.has(scene.id) || remoteOnly.has(scene.id)),
      );
      const removable = diff.removed.filter((id) => !hasUnsavedSceneEdit(requestedStage, id));
      if (applicable.length < fetched.length || removable.length < diff.removed.length) {
        heldBackForSave.current = true;
      }

      // A run generating this course writes it: not an edit, nothing to tell apart.
      const isEditableCopy = !before.courseGenerating && !isServerGeneratingStage(requestedStage);
      const incoming = isEditableCopy
        ? keepLocalWhereUnchanged(localScenes, applicable)
        : applicable;

      const appliedIds = new Set(applicable.map((scene) => scene.id));
      const merge = mergeFetchedScenes({
        current: localScenes,
        fetched: keepLocalList ? withLocalSceneOrder(localScenes, incoming) : incoming,
        removedIds: removable,
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
        // Including the pass that confirms what the load brought: a copy equal to it
        // records nothing, and anything else changed after the load.
        if (isEditableCopy) recordAgentChange(before);
      }

      // Advance the rendered manifest to what the store now holds: applied
      // scenes get their fresh rev/order, removed scenes are dropped. Scenes
      // that were in the diff but NOT applied (a chunk failed, or an unsaved
      // edit kept them) keep their old rev so the next pass re-attempts them —
      // that must never be recorded as fully applied (cr D3-F3).
      const freshById = new Map(manifest.scenes.map((scene) => [scene.id, scene]));
      const renderedById = new Map(
        (renderedManifest.current as StageManifest).scenes.map((scene) => [scene.id, scene]),
      );
      for (const sceneId of removable) renderedById.delete(sceneId);
      forgetKnownScenes(requestedStage, removable);
      for (const sceneId of appliedIds) {
        const fresh = freshById.get(sceneId);
        if (fresh) renderedById.set(sceneId, fresh);
      }
      await settleStage(
        {
          rev: manifest.rev,
          scenes: [...renderedById.values()].sort((a, b) => a.order - b.order),
        },
        previousStageRev,
      );
      // The rest is applied; into the retry budget for what is left, since no new
      // signal may come for it.
      if (foldFailures > 0) {
        throw new Error(`${foldFailures} PBL scene(s) of ${requestedStage} could not be folded`);
      }
    };

    /**
     * Last step of a pass, after the scenes: follow the stage's own fields
     * when its rev moved, then record the baseline. A roster write
     * (`set_roster`, an edit in another tab) lands only on the stage, and the
     * classroom on screen must follow it -- names, avatars, voices -- without
     * a reload. When the roster could not be settled, the stage rev keeps its
     * previous value (the scenes still advance), so the next pass reads the
     * roster again instead of taking the moved rev as already seen.
     */
    const settleStage = async (next: StageManifest, previousStageRev: number) => {
      const settled = next.rev === previousStageRev || (await syncRoster());
      if (!isCurrent()) return;
      renderedManifest.current = settled ? next : { ...next, rev: previousStageRev };
      recordWriteBaseline(renderedManifest.current);
    };

    /**
     * Read the course's roster and merge it into the one on screen, three-way
     * against the roster this browser last knew the server to hold (the
     * base, kept by the stage store). Answers whether the shown roster is now
     * reconciled with the server's; never throws, so a roster that cannot be
     * read does not hold up the scenes.
     *
     * - server equals shown: nothing to do; the base becomes it.
     * - shown equals base: the server's is a remote change (`set_roster`, an
     *   edit in another tab). It is applied even with other stage edits
     *   pending: the apply queues no write of its own, and the pending flush,
     *   which captures the stage when it starts, then writes the new roster
     *   rather than putting the old one back.
     * - shown differs from base: a roster edit of this browser's own. It is
     *   kept and not settled; once its save lands (which moves the base),
     *   the next pass reconciles again. Concurrent edits: the last save wins.
     */
    const syncRoster = async (): Promise<boolean> => {
      // A stage write already on the wire carries the roster it captured;
      // applying under it would be overwritten. Try again once it lands.
      if (isStageWriteInFlight(requestedStage)) return false;
      const roster = await fetchStageRoster(requestedStage);
      if (!isCurrent()) return false;
      if (!roster) {
        console.warn(`[workbench] stage roster unavailable for ${requestedStage}; will retry`);
        return false;
      }
      const store = useStageStore.getState();
      // The classroom has not loaded this course yet: its load brings the
      // roster; read again on the next pass rather than assume it is current.
      if (store.stage?.id !== requestedStage) return false;
      // A course that never stored a roster: nothing to take from it.
      if (!roster.generatedAgentConfigs) return true;
      if (isStageWriteInFlight(requestedStage)) return false;
      const shown = rosterOf(store.stage);
      // The server's roster in full: one without agentIds keeps the shown ones.
      const agentIds = roster.agentIds ?? shown.agentIds;
      const server: StageRoster = {
        ...(agentIds ? { agentIds } : {}),
        generatedAgentConfigs: roster.generatedAgentConfigs,
      };
      if (!stageRosterChanged(shown, roster)) {
        recordServerRosterBase(requestedStage, server);
        return true;
      }
      let base = serverRosterBaseOf(requestedStage);
      if (!base) {
        // No base yet (the store was cold at the first pass). With no stage
        // edit pending, the shown roster is the one the load brought.
        if (hasUnsavedStageEdit(requestedStage)) return false;
        base = shown;
      }
      if (!sameStageRoster(shown, base)) return false;
      store.setStageAgents([...roster.generatedAgentConfigs], {
        fromServer: true,
        ...(roster.agentIds ? { agentIds: [...roster.agentIds] } : {}),
      });
      recordServerRosterBase(requestedStage, server);
      return true;
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

    const source = new FetchEventSource(
      `/api/stages/${encodeURIComponent(requestedStage)}/freshness`,
    );
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

    // A save of the course finished. Its own frame may be up to a poll interval
    // away, and may have come already, while the write was still in flight: if
    // the last pass left scenes behind for a save, read them now.
    const unsubscribeSaveSettled = useStageStore.subscribe((state, prev) => {
      const now = (state as { stageSyncRequest?: number }).stageSyncRequest ?? 0;
      const before = (prev as { stageSyncRequest?: number }).stageSyncRequest ?? 0;
      if (now > before && heldBackForSave.current && isCurrent()) requestSync('save-settled');
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
      unsubscribeSaveSettled();
    };
  }, [stageId]);
}
