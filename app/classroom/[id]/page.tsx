'use client';

import { Stage } from '@/components/stage';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { claimStageSceneLoadToken, isCurrentStageSceneLoadToken } from '@/lib/store/stage';
import { loadImageMapping } from '@/lib/utils/image-storage';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useSceneGenerator } from '@/lib/hooks/use-scene-generator';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { clearPendingMediaAllocations } from '@/lib/media/pending-media-allocations';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { createLogger } from '@/lib/logger';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { fetchStageMeta } from '@/lib/classroom/stage-meta-client';
import {
  classroomGenerationOwnership,
  mayStartOwnerGeneration,
  noteStageOwnership,
} from '@/lib/classroom/stage-ownership-signal';
import {
  noteStageGenerationOwnership,
  useStageGenerationOwnership,
} from '@/lib/classroom/generation-permission';
import {
  applyClassroomStageAndScenes,
  defaultClassroomLoadDeps,
  runClassroomLoad,
} from '@/lib/classroom/load-classroom';
import { isServerBackedMediaPersistence } from '@/lib/persistence/media-persistence';

const log = createLogger('Classroom');

export default function ClassroomDetailPage() {
  const params = useParams();
  const classroomId = params?.id as string;

  const { loadFromStorage } = useStageStore();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Not a boolean on purpose: `false` would say "this is a stranger's course",
  // which is neither what an unanswered sidecar nor a 404 means. Held in the
  // shared permission store rather than in local state, so the retry
  // affordances read exactly the value this effect gates on.
  const ownership = useStageGenerationOwnership(classroomId);
  // Render condition and action precondition are the same value: an outline
  // retry runs the whole content + actions + narration chain on the operator's
  // keys, so a viewer must not even be offered it.
  const mayGenerate = mayStartOwnerGeneration(isServerBackedMediaPersistence(), ownership);

  const generationStartedRef = useRef(false);

  const { generateRemaining, retrySingleOutline, stop } = useSceneGenerator({
    onComplete: () => {
      log.info('[Classroom] All scenes generated');
    },
  });

  const loadClassroom = useCallback(
    async (isEffectCurrent: () => boolean = () => true) => {
      const loadToken = claimStageSceneLoadToken();
      const isCurrent = () => isEffectCurrent() && isCurrentStageSceneLoadToken(loadToken);

      await runClassroomLoad({
        classroomId,
        loadToken,
        isCurrent,
        loadFromStorage,
        getCurrentStage: () => useStageStore.getState().stage,
        fetchClassroom: defaultClassroomLoadDeps.fetchClassroom,
        applyFallbackScenes: (args) =>
          defaultClassroomLoadDeps.applyFallbackScenes({
            ...args,
            isCurrent,
            applyStageAndScenes: applyClassroomStageAndScenes,
          }),
        loadRestoredMediaTasks: defaultClassroomLoadDeps.loadRestoredMediaTasks,
        applyRestoredMediaTasks: (restored) =>
          defaultClassroomLoadDeps.applyRestoredMediaTasks(restored, isCurrent),
        discardRestoredMediaTasks: defaultClassroomLoadDeps.discardRestoredMediaTasks,
        loadLegacyAgentFallbacks: defaultClassroomLoadDeps.loadLegacyAgentFallbacks,
        commitMigratedAgentConfigs: defaultClassroomLoadDeps.commitMigratedAgentConfigs,
        applyGeneratedAgents: defaultClassroomLoadDeps.applyGeneratedAgents,
        getSettings: () => useSettingsStore.getState(),
        getAgent: (id) => useAgentRegistry.getState().getAgent(id),
        restoreAgentSelection: defaultClassroomLoadDeps.restoreAgentSelection,
        setError,
        setLoading,
        log,
      });

      // The stage-meta sidecar resolves the viewer-facing ownership facts the
      // document seam does not carry — `isOwner` decides read-only vs editable
      // (see `stage-meta-client.ts`). Run it strictly AFTER the load applied
      // its defaults so its answer wins, and fire it without blocking the
      // render that already happened.
      if (isEffectCurrent()) {
        void fetchStageMeta(classroomId)
          .then((result) => {
            if (!isEffectCurrent()) return;
            // One mapping of the sidecar's three outcomes onto the generation
            // gate, shared with every other classroom surface and with every
            // affordance that could start generation.
            noteStageGenerationOwnership(classroomId, classroomGenerationOwnership(result));
            if (result.outcome === 'found') {
              noteStageOwnership(classroomId, true, {
                isOwner: result.meta.isOwner,
              });
              useStageStore.getState().setViewerAccess({
                isOwner: result.meta.isOwner,
              });
            } else if (result.outcome === 'unavailable') {
              // A silent sidecar is not "this is a stranger's course": record
              // the outage so nothing treats `isOwner === false` as a visitor
              // conclusion. The edit gate stays on the upstream defaults.
              noteStageOwnership(classroomId, false, null);
            } else {
              // 'absent' — no sidecar row for this id. This classroom also
              // serves local-only courses, so the upstream editable default
              // stays; the server's owner-scoped writes remain the authority.
              noteStageOwnership(classroomId, true, null);
            }
          })
          .catch(() => noteStageOwnership(classroomId, false, null));
      }
    },
    [classroomId, loadFromStorage],
  );

  useEffect(() => {
    // Reset loading state on course switch to unmount Stage during transition,
    // preventing stale data from syncing back to the new course
    /* eslint-disable react-hooks/set-state-in-effect -- Course switch must hide stale Stage before async load */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // Ownership belongs to the departing course; the new one must re-earn it
    // before anything it holds may be generated.
    noteStageGenerationOwnership(classroomId, 'unresolved');
    generationStartedRef.current = false;

    // Clear previous classroom's media tasks to prevent cross-classroom contamination.
    // Placeholder IDs (gen_img_1, gen_vid_1) are NOT globally unique across stages,
    // so stale tasks from a previous classroom would shadow the new one's.
    const mediaStore = useMediaGenerationStore.getState();
    mediaStore.revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });
    // Allocations parked by an interrupted run on THIS id must go with them.
    // Classic placeholders are reused across runs of the same course, so a
    // survivor would be handed to a different slide of the next deck.
    clearPendingMediaAllocations(classroomId);

    // Clear whiteboard history to prevent snapshots from a previous course leaking in.
    useWhiteboardHistoryStore.getState().clearHistory();

    let cancelled = false;
    loadClassroom(() => !cancelled);

    // Cancel ongoing generation when classroomId changes or component unmounts
    return () => {
      cancelled = true;
      stop();
    };
  }, [classroomId, loadClassroom, stop]);

  // Auto-resume generation for pending outlines
  useEffect(() => {
    if (loading || error || generationStartedRef.current) return;
    // Generation spends the operator's provider budget, and a server-backed
    // course is readable by anyone it was shared with, so a viewer must never
    // start it. `generationStartedRef` is deliberately NOT set here, so the
    // effect re-runs and starts once the sidecar's answer arrives.
    if (!mayGenerate) return;

    const state = useStageStore.getState();
    const { outlines, scenes, stage, generationComplete } = state;

    // Check if there are pending outlines. A finished deck is frozen for
    // editing: deleting a slide leaves its outline orphaned, but that must not
    // be treated as an interrupted generation and regenerated. Only resume
    // when generation has not completed.
    const completedOrders = new Set(scenes.map((s) => s.order));
    const hasPending = !generationComplete && outlines.some((o) => !completedOrders.has(o.order));

    if (hasPending && stage) {
      generationStartedRef.current = true;

      // Load generation params from sessionStorage (stored by generation-preview before navigating)
      const genParamsStr = sessionStorage.getItem('generationParams');
      const params = genParamsStr ? JSON.parse(genParamsStr) : {};

      // Reconstruct imageMapping for the resumed generation. A server-backed
      // deployment stored allocated asset ids on the session's pdfImages (RFC
      // #1153 part 2 B): the extracted images are pool assets, so generation
      // is fed by id and the routes resolve the bytes server-side. Per source
      // (N4) the mapping may MIX allocated asset ids and IndexedDB data URLs —
      // a source whose cache write failed materialized its own images — so the
      // resume mapping merges both, instead of choosing one transport for the
      // whole set and silently dropping the other half.
      const pdfImages = (params.pdfImages || []) as Array<
        { id: string; assetId?: string; storageId?: string } & Record<string, unknown>
      >;
      const finishResume = (imageMapping: Record<string, string>) =>
        generateRemaining({
          pdfImages: params.pdfImages,
          imageMapping,
          stageInfo: {
            name: stage.name || '',
            description: stage.description,
            style: stage.style,
          },
          agents: params.agents,
          userProfile: params.userProfile,
          languageDirective: params.languageDirective || stage.languageDirective,
        });

      const imageMapping: Record<string, string> = {};
      for (const img of pdfImages) {
        if (img.assetId) imageMapping[img.id] = img.assetId;
      }
      const storageIds = pdfImages
        .filter((img) => !img.assetId && img.storageId)
        .map((img) => img.storageId as string);
      void (async () => {
        if (storageIds.length > 0) {
          Object.assign(imageMapping, await loadImageMapping(storageIds));
        }
        finishResume(imageMapping);
      })();
    } else if (outlines.length > 0 && stage) {
      // All scenes are generated, but some media may not have finished.
      // Resume media generation for any tasks not yet in IndexedDB.
      // generateMediaForOutlines skips already-completed tasks automatically.
      generationStartedRef.current = true;
      // The deck reached the classroom already fully materialized (e.g. a
      // single-slide course, or a deck whose last slide finished in
      // generation-preview), so generateRemaining's completion path never
      // ran. Record completion now so a later edit/delete is not treated as
      // an interrupted generation. No-op if already complete or not all
      // outlines have scenes.
      useStageStore.getState().markGenerationCompleteIfDone();
      // Resume media only for outlines that still have a scene. On a finished
      // deck the user may have deleted a slide, leaving an orphaned outline;
      // generating its media would waste API calls on a slide that is gone.
      const materializedOrders = new Set(scenes.map((s) => s.order));
      const materializedOutlines = outlines.filter((o) => materializedOrders.has(o.order));
      generateMediaForOutlines(materializedOutlines, stage.id).catch((err) => {
        log.warn('[Classroom] Media generation resume error:', err);
      });
    }
  }, [loading, error, mayGenerate, generateRemaining]);

  return (
    <ThemeProvider>
      <MediaStageProvider value={classroomId}>
        <div className="h-screen flex flex-col overflow-hidden">
          {loading ? (
            <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
              <div className="text-center text-muted-foreground">
                <p>Loading classroom...</p>
              </div>
            </div>
          ) : error ? (
            <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
              <div className="text-center">
                <p className="text-destructive mb-4">Error: {error}</p>
                <button
                  onClick={() => {
                    setError(null);
                    setLoading(true);
                    loadClassroom();
                  }}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                >
                  Retry
                </button>
              </div>
            </div>
          ) : (
            <Stage onRetryOutline={mayGenerate ? retrySingleOutline : undefined} />
          )}
        </div>
      </MediaStageProvider>
    </ThemeProvider>
  );
}
