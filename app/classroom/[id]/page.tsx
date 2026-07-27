'use client';

import { Stage } from '@/components/stage';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { loadImageMappingCompressed } from '@/lib/utils/image-storage';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useSceneGenerator } from '@/lib/hooks/use-scene-generator';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { createLogger } from '@/lib/logger';
import { recordLearningEvent, saveStageToCloud } from '@/lib/utils/cloud-sync';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { migrateScene } from '@/lib/edit/slide-schema';
import { useAuth } from '@/lib/auth/use-auth';
import { useMobileDetection } from '@/lib/hooks/use-mobile-detection';
import { useRouter } from 'next/navigation';
import type { Scene } from '@/lib/types/stage';
import { inspectOrderField } from '@/lib/utils/scene-order';

const log = createLogger('Classroom');

export default function ClassroomDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const classroomId = params?.id as string;
  const readOnlyShare = searchParams.get('share') === '1';
  const studentId = searchParams.get('student') || undefined;
  const editorAutoOpen = searchParams.get('editor') === '1';
  const viewMode = searchParams.get('view') === '1';
  const explicitSceneId = searchParams.get('sceneId') || undefined;
  // Temporary repair entry: ?repairOrder=createdAt
  // Forces scenes to be re-sorted by createdAt/updatedAt/id, normalized to
  // seq=order=index, and re-uploaded to cloud. See loadClassroom for logic.
  const repairOrder = searchParams.get('repairOrder');
  const { isMobile } = useMobileDetection();
  const [verifiedStudentId, setVerifiedStudentId] = useState<string | null>(null);
  const [verifiedStudentName, setVerifiedStudentName] = useState<string | null>(null);
const [isSavingToCloud, setIsSavingToCloud] = useState(false);

  // Supabase Auth gate: anyone visiting /classroom/[id] must be
  // signed in. This replaces OPENMAIC upstream's ACCESS_CODE modal
  // — once the operator deletes ACCESS_CODE from Vercel env, the
  // only barrier to entry is a valid learner / teacher / admin
  // account. Unsigned-in visitors get redirected to /login with
  // a `next` param so they return here after authenticating.
  //
  // IMPORTANT: we must NOT early-return here (before the other hooks
  // below) — React requires hooks to be called in the same order on
  // every render. An early return would cause error #310 ("Rendered
  // fewer hooks than expected"). Instead, the redirect fires from
  // this useEffect and the main render below conditionally shows a
  // loading screen when authLoading or !user.
  const { user, profile, loading: authLoading } = useAuth();
  const authReady = !authLoading && !!user;
  // Only admin / teacher can save to cloud. Learners never see the
  // save button — they're viewers, not authors. This replaces the
  // earlier editorAutoOpen gate which also hid the button from
  // admins on the post-generation page (where ?editor=1 isn't set).
  const canSave = profile?.role === 'admin' || profile?.role === 'teacher';
  useEffect(() => {
    if (!authLoading && !user) {
      const returnUrl = window.location.pathname + window.location.search;
      window.location.assign(`/login?next=${encodeURIComponent(returnUrl)}`);
    }
  }, [authLoading, user]);

  // ── Mobile auto-redirect ──────────────────────────────────────
  // When a user opens /classroom/[id] on a mobile device and is
  // NOT in editor mode (?editor=1), redirect to the podcast-style
  // mobile player at /m/[id].
  //
  // Rules:
  //   - ?editor=1 always stays on desktop (admin editing surface)
  //   - Admin/teacher WITHOUT ?share=1 stays on desktop (management view)
  //   - Everyone else (learners, or anyone via share link) redirects on mobile
  //
  // This prevents narrowed browser windows or DevTools mobile simulation
  // from sending an admin to a 404 at /m/[courseId], while still allowing
  // admins/teachers to preview the mobile learner experience via share links.
  useEffect(() => {
    const isShareMode = readOnlyShare;
    const isEditorMode = editorAutoOpen;
    const isAdminOrTeacher = profile?.role === 'admin' || profile?.role === 'teacher';

    if (!authReady || !isMobile || isEditorMode) return;
    if (isAdminOrTeacher && !isShareMode) return;

    const params = new URLSearchParams();
    if (isShareMode) params.set('share', '1');
    if (studentId) params.set('student', studentId);
    if (viewMode) params.set('view', '1');
    const qs = params.toString();
    const target = `/m/${classroomId}${qs ? `?${qs}` : ''}`;

    log.info('[MOBILE REDIRECT][Classroom]', {
      id: classroomId,
      isMobile,
      isEditorMode,
      isShareMode,
      isAdminOrTeacher,
      target,
    });

    router.replace(target);
  }, [authReady, isMobile, editorAutoOpen, classroomId, readOnlyShare, studentId, viewMode, router, profile]);

  // When the URL says ?editor=1, flip the stage store into 'edit'
  // (MAIC Editor / Pro mode) so the admin / teacher lands directly
  // in the editing surface instead of the playback surface. The
  // MAIC Editor flag (NEXT_PUBLIC_MAIC_EDITOR_ENABLED) still gates
  // whether the EditChromeRoot renders the toggle, so this is a
  // no-op when the feature flag is off.
  useEffect(() => {
    if (editorAutoOpen) {
      useStageStore.setState({ mode: 'edit' });
    }
  }, [editorAutoOpen]);
const [saveCloudMessage, setSaveCloudMessage] = useState('');

  const { loadFromStorage } = useStageStore();
  const generationComplete = useStageStore((s) => s.generationComplete);
  const scenes = useStageStore((s) => s.scenes);
  const currentSceneId = useStageStore((s) => s.currentSceneId);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const generationStartedRef = useRef(false);
  const openEventSentRef = useRef(false);
  const completeEventSentRef = useRef(false);

  const { generateRemaining, retrySingleOutline, stop } = useSceneGenerator({
    onComplete: () => {
      log.info('[Classroom] All scenes generated');
    },
  });

  const loadClassroom = useCallback(async () => {
    if (!authReady) return;
    try {
      await loadFromStorage(classroomId);

      // ── Self-heal broken IndexedDB scene order ──────────────────────
      // BUG FIX: Historical courses may have inconsistent scene.order (cloud
      // imports, pre-rebalance writes). loadStageData now sorts by `seq`
      // (monotonic insertion sequence, schema v13), assigned as array index
      // at every save. If after load the seq fields don't match the array
      // position, normalize and persist so the next refresh shows the same
      // order.
      {
        const storeState = useStageStore.getState();
        const scenesNow = storeState.scenes;
        const isSeqBroken =
          scenesNow.length > 0 &&
          scenesNow.some((s, i) => (s as { seq?: number }).seq !== i);

        if (isSeqBroken) {
          log.warn(
            '[CLASSROOM INIT][Order Repair] Detected scene.seq mismatch with array index — repairing',
            {
              stageId: classroomId,
              before: scenesNow.map((s) => ({
                id: s.id,
                title: s.title,
                order: s.order,
                seq: (s as { seq?: number }).seq,
              })),
            },
          );
          const repaired = scenesNow.map((s, i) => ({ ...s, seq: i }));
          // Normalize to Scene[] for the store
        const { migrateScene } = await import('@/lib/edit/slide-schema');
        const repairedScenes = repaired.map((s) => migrateScene({ ...s, stageId: classroomId, type: (s as { type?: string }).type ?? 'slide' } as Parameters<typeof migrateScene>[0]));
        useStageStore.setState({ scenes: repairedScenes as unknown as ReturnType<typeof useStageStore.getState>['scenes'] });
          // Persist immediately so the repair survives a refresh even if no
          // other edit happens. Skip if the stage itself didn't load (e.g.
          // the cloud fallback path below will run and persist its own copy).
          const stageRef = useStageStore.getState().stage;
          if (stageRef) {
            try {
              // Mark the stage's scene order as trusted so subsequent
              // reads (loadStageData, getScenesByStageId, thumbnails)
              // can switch back to prefer='auto' and respect future
              // manual reorders.
              const trustedAt = Date.now();
              const trustedStage = {
                ...stageRef,
                sceneOrderTrusted: true,
                sceneOrderRepairedAt: trustedAt,
              } as typeof stageRef;
              useStageStore.setState({ stage: trustedStage });
              const { saveStageData } = await import('@/lib/utils/stage-storage');
              await saveStageData(classroomId, {
                stage: trustedStage,
                scenes: repaired,
                currentSceneId: useStageStore.getState().currentSceneId,
                chats: useStageStore.getState().chats ?? [],
              });
              log.info('[CLASSROOM INIT][Order Repair] Persisted repaired seq + trusted flag to IndexedDB');
            } catch (e) {
              log.warn('[CLASSROOM INIT][Order Repair] Failed to persist repair:', e);
            }
          }
        }
      }


      // ── Manual repair entry: ?repairOrder=createdAt ───────────────────
      // Forces scenes to be re-sorted by createdAt/updatedAt/id (the
      // trusted comparator from scene-order.ts) and persisted back to both
      // IndexedDB and cloud. Intended as an escape hatch when the auto
      // self-heal above doesn't fire because seq already aligns with the
      // (corrupted) array position.
      if (repairOrder === 'createdAt') {
        const { orderSceneRecordsForDisplay } = await import('@/lib/utils/scene-order');
        const { db: dbRef } = await import('@/lib/utils/database');
        const dbRawScenes = await dbRef.scenes.where('stageId').equals(classroomId).toArray();
        const first10Before = dbRawScenes.slice(0, 10).map((s: { id: string; title?: string; order?: number | null; seq?: number | null; createdAt?: number }) => ({
          id: s.id, title: s.title, order: s.order, seq: s.seq, createdAt: s.createdAt,
        }));
        // MUST pass prefer: 'createdAt' — auto mode would still trust the
        // poisoned seq=0,1,2... that v13 left behind. We force the recovery
        // to consult createdAt/updatedAt/id and ignore seq entirely.
        const { ordered: repaired, source: repairSource, duplicateIdsRemoved: dupIds } =
          orderSceneRecordsForDisplay(dbRawScenes, { prefer: 'createdAt' });
        const first10After = repaired.slice(0, 10).map((s: { id: string; title?: string; order?: number | null; seq?: number | null; createdAt?: number }) => ({
          id: s.id, title: s.title, order: s.order, seq: s.seq, createdAt: s.createdAt,
        }));
        log.info('[ORDER REPAIR][Before]', {
          stageId: classroomId,
          repairSource,
          beforeCount: dbRawScenes.length,
          first10Before,
        });
        log.info('[ORDER REPAIR][After]', {
          stageId: classroomId,
          repairSource,
          afterCount: repaired.length,
          duplicateIdsRemoved: dupIds.length,
          first10After,
        });
        // Normalize to Scene[] for the store
        const { migrateScene } = await import('@/lib/edit/slide-schema');
        const repairedScenes = repaired.map((s) => migrateScene({ ...s, stageId: classroomId, type: (s as { type?: string }).type ?? 'slide' } as Parameters<typeof migrateScene>[0]));
        useStageStore.setState({ scenes: repairedScenes as unknown as ReturnType<typeof useStageStore.getState>['scenes'] });
        const stageRef2 = useStageStore.getState().stage;
        if (stageRef2) {
          // Manual repair via ?repairOrder=createdAt: this is a deliberate
          // user-driven recovery, so mark the stage as trusted. Without
          // this flag, loadStageData would re-run the recovery on next
          // open — but that path would still use prefer='createdAt' for
          // this stage, so the seq we just wrote would be trusted only
          // if we flip the flag here.
          const trustedAt = Date.now();
          const trustedStage2 = {
            ...stageRef2,
            sceneOrderTrusted: true,
            sceneOrderRepairedAt: trustedAt,
          } as typeof stageRef2;
          useStageStore.setState({ stage: trustedStage2 });
          try {
            const { saveStageData } = await import('@/lib/utils/stage-storage');
            await saveStageData(classroomId, {
              stage: trustedStage2,
              scenes: repairedScenes as unknown as Parameters<typeof saveStageData>[1]['scenes'],
              currentSceneId: useStageStore.getState().currentSceneId,
              chats: useStageStore.getState().chats ?? [],
            });
            log.info('[ORDER REPAIR] Persisted repaired scenes + trusted flag to IndexedDB');
          } catch (e) {
            log.warn('[ORDER REPAIR] IndexedDB persist failed:', e);
          }
          // Also re-upload to cloud so share links see the fix immediately.
          try {
            const { saveStageToCloud } = await import('@/lib/utils/cloud-sync');
            await saveStageToCloud(classroomId);
            log.info('[ORDER REPAIR] Re-uploaded repaired scenes to cloud');
          } catch (e) {
            log.warn('[ORDER REPAIR] Cloud re-upload failed:', e);
          }
        }
      }

      // ── Initial scene resolution ───────────────────────────────
      // Priority (see CLASSROOM INIT log below for reason field):
      //   1. URL explicit sceneId (if valid)
      //   2. Editor mode + stage.currentSceneId (resume edit position)
      //   3. Default: sortedScenes[0] (learner / share / open)
      //
      // BUG FIX: Previously loadFromStorage restored stage.currentSceneId
      // from IndexedDB unconditionally, so "open" or share links landed on
      // whatever page the admin last edited (e.g. page 9). Now we force
      // learner/share entry to start from page 1.
      {
        const storeState = useStageStore.getState();
        const rawScenes = storeState.scenes;

        // ── Display order policy ─────────────────────────────────────
        // Historical courses have unreliable `order` fields. Sometimes
        // `order` is missing/non-unique; sometimes it's a stale value
        // from IndexedDB that contradicts the real display sequence the
        // admin authored (e.g. order=2 points to "开场" but the array
        // already places "开场" at index 2, while the real page 1 is
        // at array index 0 with order=null).
        //
        // We NEVER sort by `order` for display. The raw array order from
        // server / IndexedDB is the source of truth for the page sequence.
        const displayScenes = rawScenes;
        const orderDiag = inspectOrderField(rawScenes);

        const displayFirst = displayScenes[0];
        const isEditorMode = editorAutoOpen;
        const isShareMode = readOnlyShare;
        const isLearnerEntry = !isEditorMode && (!canSave || isShareMode);

        let selectedInitialSceneId: string | null = null;
        let reason: string;

        // Priority 1: explicit sceneId from URL
        if (explicitSceneId) {
          const valid = displayScenes.some((s) => s.id === explicitSceneId);
          if (valid) {
            selectedInitialSceneId = explicitSceneId;
            reason = 'explicit sceneId from URL';
          } else {
            // Invalid sceneId — fallback to default
            selectedInitialSceneId = displayFirst?.id ?? null;
            reason = 'fallback first scene (invalid explicit sceneId)';
          }
        }
        // Priority 2: editor mode may resume last position
        else if (isEditorMode && storeState.currentSceneId) {
          const exists = displayScenes.some((s) => s.id === storeState.currentSceneId);
          if (exists) {
            selectedInitialSceneId = storeState.currentSceneId;
            reason = 'editor currentSceneId';
          } else {
            // Stale currentSceneId (scene was deleted) — fallback
            selectedInitialSceneId = displayFirst?.id ?? null;
            reason = 'fallback first scene (stale editor currentSceneId)';
          }
        }
        // Priority 3: learner / share / open → always start from beginning
        else {
          selectedInitialSceneId = displayFirst?.id ?? null;
          reason = isLearnerEntry
            ? 'learner/share default first scene'
            : 'fallback first scene';
        }

        // Apply if different from what IndexedDB restored (avoid unnecessary re-render)
        if (selectedInitialSceneId !== storeState.currentSceneId) {
          useStageStore.setState({ currentSceneId: selectedInitialSceneId });
        }

        const selectedScene = displayScenes.find((s) => s.id === selectedInitialSceneId);

        log.info('[CLASSROOM INIT][Initial Scene]', {
          stageId: classroomId,
          isEditorMode,
          isShareMode,
          isLearnerEntry,
          explicitSceneId,
          explicitSceneIdValid: explicitSceneId ? displayScenes.some((s) => s.id === explicitSceneId) : undefined,
          restoredCurrentSceneId: storeState.currentSceneId, // value BEFORE our override
          selectedInitialSceneId,
          selectedInitialSceneTitle: selectedScene?.title,
          selectedInitialSceneOrder: selectedScene?.order,
          displayFirstSceneId: displayFirst?.id,
          displayFirstSceneTitle: displayFirst?.title,
          displayFirstSceneOrder: displayFirst?.order,
          totalScenes: displayScenes.length,
          reason,
          // ── Order field diagnostics ──
          // We intentionally do NOT sort by `order`. The raw array order
          // from server/IndexedDB is the source of truth for display.
          // These fields expose the order field's trustworthiness so
          // future debugging can see whether order matches reality.
          rawSceneIds: rawScenes.slice(0, 10).map((s) => s.id),
          rawSceneTitles: rawScenes.slice(0, 10).map((s) => s.title),
          rawSceneOrders: orderDiag.orders.slice(0, 10),
          orderFieldAllValid: orderDiag.allHaveValidOrder,
          orderFieldUnique: orderDiag.hasUniqueOrders,
          orderMatchesArrayIndex: orderDiag.orderMatchesArrayIndex,
          displayUsesRawArrayOrder: true,
        });
      }

      // If IndexedDB had no data, try server-side storage (API-generated classrooms)
      if (!useStageStore.getState().stage) {
        log.info('No IndexedDB data, trying server-side storage for:', classroomId);
        try {
          const res = await fetch(`/api/classroom?id=${encodeURIComponent(classroomId)}`);
          if (res.ok) {
            const json = await res.json();
            if (json.success && json.classroom) {
              const { stage, scenes } = json.classroom;
              useStageStore.getState().setStage(stage);
              // Normalize legacy slide content (missing schemaVersion) on the
              // way in, same as the store's setScenes/loadFromStorage paths —
              // server snapshots predate the schema field.
              const migrated = (scenes as Scene[]).map(migrateScene);
              // Use raw array order — `order` field is unreliable for
              // historical courses (see scene-order.ts comment).
              useStageStore.setState({
                scenes: migrated,
                currentSceneId: migrated[0]?.id ?? null,
                // Match `loadFromStorage` semantics: mode is transient UI
                // state, not persisted with the stage. Reset on every
                // classroom load so SPA navigation doesn't carry Pro
                // mode across.
                mode: 'playback',
              });
              log.info('Loaded from server-side storage:', classroomId);

              // Hydrate server-generated agents into IndexedDB + registry.
              // Don't set selectedAgentIds here — the general agent
              // restoration logic below (Path 2) handles it uniformly.
              if (stage.generatedAgentConfigs?.length) {
                const { saveGeneratedAgents } = await import('@/lib/orchestration/registry/store');
                await saveGeneratedAgents(stage.id, stage.generatedAgentConfigs);
                log.info('Hydrated server-generated agents for stage:', stage.id);
              }
            }
          }
        } catch (fetchErr) {
          log.warn('Server-side storage fetch failed:', fetchErr);
        }
      }

      if (!useStageStore.getState().stage) {
        log.info('No local/server classroom data, trying cloud course:', classroomId);
        try {
          const courseParams = new URLSearchParams();
          if (readOnlyShare) courseParams.set('share', '1');
          const courseQuery = courseParams.toString();
          const res = await fetch(
            `/api/courses/${encodeURIComponent(classroomId)}${courseQuery ? `?${courseQuery}` : ''}`,
          );
          if (res.ok) {
            const json = await res.json();
            const courseData = json?.data?.data;
            if (json.success && courseData?.stage) {
              const { stage, scenes = [], outlines = [] } = courseData;
              const migrated = (scenes as Scene[]).map(migrateScene);
              // Use raw array order — `order` field is unreliable for
              // historical courses (see scene-order.ts comment).
              useStageStore.getState().setStage(stage);
              // Hydrate generated agents from cloud course into IndexedDB + registry
              if (stage.generatedAgentConfigs?.length) {
                const { saveGeneratedAgents } = await import('@/lib/orchestration/registry/store');
                await saveGeneratedAgents(stage.id, stage.generatedAgentConfigs);
                log.info('Hydrated cloud course agents for stage:', stage.id);
              }
              useStageStore.setState({
                scenes: migrated,
                outlines,
                currentSceneId: migrated[0]?.id ?? null,
                mode: 'playback',
                generationComplete: true,
                generatingOutlines: [],
                generationStatus: 'completed',
              });
              log.info('Loaded from cloud course:', classroomId);
            }
          } else {
            const body = await res.json().catch(() => null);
            const message = body?.error ?? `课程加载失败（HTTP ${res.status}）`;
            throw new Error(message);
          }
        } catch (cloudErr) {
          log.warn('Cloud course fetch failed:', cloudErr);
        }
      }

      // Restore completed media generation tasks from IndexedDB
      await useMediaGenerationStore.getState().restoreFromDB(classroomId);
      // Restore agents for this stage
      const { loadGeneratedAgentsForStage, useAgentRegistry } =
        await import('@/lib/orchestration/registry/store');
      const generatedAgentIds = await loadGeneratedAgentsForStage(classroomId);
      const { useSettingsStore } = await import('@/lib/store/settings');
      const { restoreAgentSelection } =
        await import('@/lib/orchestration/registry/agent-selection');
      // Keep the user's explicit AgentBar mode/selection when still valid for
      // this stage instead of unconditionally forcing auto mode (which
      // clobbered it on every classroom visit); fall back to the stage-derived
      // defaults otherwise, marking them as NOT user-set so the next classroom
      // never mistakes them for a choice. Stale generated IDs (from another
      // stage / pre-bleed-fix) never validate, so they don't resolve against a
      // leftover registry entry.
      const settings = useSettingsStore.getState();
      const registry = useAgentRegistry.getState();
      const stage = useStageStore.getState().stage;
      const { selection: next, isUserSet } = restoreAgentSelection({
        persisted: { mode: settings.agentMode, selectedAgentIds: settings.selectedAgentIds },
        persistedIsUserSet: settings.agentSelectionIsUserSet,
        generatedAgentIds,
        stageAgentIds: stage?.agentIds,
        isPresetAgent: (id) => {
          const a = registry.getAgent(id);
          return !!a && !a.isGenerated;
        },
      });
      // restoreAgentSelection returns the persisted object as-is when keeping
      // it, so reference checks skip redundant store writes.
      if (next.mode !== settings.agentMode) settings.setAgentMode(next.mode);
      if (next.selectedAgentIds !== settings.selectedAgentIds) {
        settings.setSelectedAgentIds(next.selectedAgentIds);
      }
      if (isUserSet !== settings.agentSelectionIsUserSet) {
        settings.setAgentSelectionIsUserSet(isUserSet);
      }
    } catch (error) {
      log.error('Failed to load classroom:', error);
      setError(error instanceof Error ? error.message : 'Failed to load classroom');
    } finally {
      setLoading(false);
    }
  }, [classroomId, loadFromStorage, authReady]);

  useEffect(() => {
    // Reset loading state on course switch to unmount Stage during transition,
    // preventing stale data from syncing back to the new course
    setLoading(true);
    setError(null);
    generationStartedRef.current = false;

    // Clear previous classroom's media tasks to prevent cross-classroom contamination.
    // Placeholder IDs (gen_img_1, gen_vid_1) are NOT globally unique across stages,
    // so stale tasks from a previous classroom would shadow the new one's.
    const mediaStore = useMediaGenerationStore.getState();
    mediaStore.revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });

    // Clear whiteboard history to prevent snapshots from a previous course leaking in.
    useWhiteboardHistoryStore.getState().clearHistory();

    loadClassroom();

    // Cancel ongoing generation when classroomId changes or component unmounts
    return () => {
      stop();
    };
  }, [classroomId, loadClassroom, stop]);

  useEffect(() => {
    if (!readOnlyShare || !verifiedStudentId || openEventSentRef.current) return;

    openEventSentRef.current = true;
    recordLearningEvent({
      courseId: classroomId,
      studentId: verifiedStudentId!,
      eventType: 'open_course',
    }).catch((err) => {
      log.warn('Failed to record learning open event:', err);
      openEventSentRef.current = false;
    });
  }, [classroomId, readOnlyShare, verifiedStudentId]);

  useEffect(() => {
    if (
      !readOnlyShare ||
      !verifiedStudentId ||
      !generationComplete ||
      completeEventSentRef.current ||
      scenes.length === 0
    ) {
      return;
    }

    const currentScene = scenes.find((scene) => scene.id === currentSceneId);
    const lastOrder = Math.max(...scenes.map((scene) => scene.order));
    if (!currentScene || currentScene.order < lastOrder) return;

    completeEventSentRef.current = true;
    recordLearningEvent({
      courseId: classroomId,
      studentId: verifiedStudentId!,
      eventType: 'complete_course',
      sceneId: currentScene.id,
      sceneOrder: currentScene.order,
    }).catch((err) => {
      log.warn('Failed to record learning complete event:', err);
      completeEventSentRef.current = false;
    });
  }, [classroomId, currentSceneId, generationComplete, readOnlyShare, scenes, verifiedStudentId]);

  // Auto-resume generation for pending outlines
  useEffect(() => {
    if (loading || error || generationStartedRef.current) return;

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

      // Reconstruct imageMapping from IndexedDB using pdfImages storageIds
      const storageIds = (params.pdfImages || [])
        .map((img: { storageId?: string }) => img.storageId)
        .filter(Boolean);

      loadImageMappingCompressed(storageIds).then((imageMapping) => {
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
      });
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
  }, [loading, error, generateRemaining]);

  // Auth gate render: show loading screen while auth is resolving,
  // or while the redirect to /login is in flight. This MUST be
  // after all hooks (no early returns above) to satisfy React's
  // rules of hooks.
  if (authLoading || !user) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">
          {authLoading ? '正在验证账号...' : '正在跳转登录页...'}
        </div>
      </main>
    );
  }

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
            <>
              <Stage onRetryOutline={retrySingleOutline} readOnlyShare={readOnlyShare} />
{/* 保存到云端 — only exposed in Pro Mode (?editor=1) so a learner opening
    the same course via /student/courses doesn't see a 'save to cloud'
    affordance they shouldn't be using. */}
{!readOnlyShare && !viewMode && canSave && generationComplete && (
  <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
    {saveCloudMessage && (
      <div className="rounded-full bg-background/95 px-3 py-1.5 text-xs text-foreground shadow-md border">
        {saveCloudMessage}
      </div>
    )}

    <button
      onClick={async () => {
        if (isSavingToCloud) return;

        setIsSavingToCloud(true);
        setSaveCloudMessage('正在保存到云端，请稍候...');

        try {
          await saveStageToCloud(classroomId);
          setSaveCloudMessage('✅ 保存成功');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          setSaveCloudMessage('❌ 保存失败：' + (e.message || '未知错误'));
        } finally {
          setIsSavingToCloud(false);
        }
      }}
      disabled={isSavingToCloud}
      className={`rounded-full px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg transition-opacity ${
        isSavingToCloud
          ? 'cursor-not-allowed bg-primary/70 opacity-70'
          : 'bg-primary hover:opacity-90'
      }`}
    >
      {isSavingToCloud ? '⏳ 保存中...' : '☁️ 保存到云端'}
    </button>
  </div>
)}
            </>
          )}
        </div>
      </MediaStageProvider>
    </ThemeProvider>
  );
}
