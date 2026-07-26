import { create } from 'zustand';
import {
  makeScene,
  type PBLContent,
  type Stage,
  type Scene,
  type SceneContent,
  type ScenePatch,
  type StageMode,
  type GeneratedAgentConfig,
} from '@/lib/types/stage';
import { createSelectors } from '@/lib/utils/create-selectors';
import type { ChatSession } from '@/lib/types/chat';
import type { SceneOutline } from '@/lib/types/generation';
import { createLogger } from '@/lib/logger';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import { applyGeneratedAgentsToRegistry } from '@/lib/orchestration/registry/store';
import { migrateScene } from '@/lib/edit/slide-schema';
import { preparePBLScenesForDocumentPersistence } from '@/lib/pbl/v2/runtime/document-persistence';
import { hydratePBLScenesFromRuntime } from '@/lib/pbl/v2/runtime/hydration';
import type { ChatStorageSnapshot } from '@/lib/utils/chat-storage';
import type { PendingChange } from '@/lib/utils/stage-storage';
import {
  isStageDeleted,
  isStageDeletionInFlight,
  isStageWriteStale,
  stageDeletionEpoch,
} from '@/lib/utils/deleted-stages';

const log = createLogger('StageStore');

/** Virtual scene ID used when the user navigates to a page still being generated */
export const PENDING_SCENE_ID = '__pending__';

export type StageSceneLoadToken = number;

let latestStageSceneLoadToken = 0;

type PendingEntry = { change: PendingChange; revision: number };

let pendingStageId: string | null = null;
let pendingRevision = 0;
const pendingChanges = new Map<string, PendingEntry>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
type FlushRound = {
  stageId: string;
  dirtySnapshot: ReadonlyMap<string, PendingEntry>;
  promise: Promise<Set<string>>;
};
let flushInFlight: FlushRound | null = null;
let stageStorageModulePromise: Promise<typeof import('@/lib/utils/stage-storage')> | null = null;

const DEPARTING_STAGE_RETRY_DELAY_MS = 100;

function pendingChangeKey(change: PendingChange): string {
  return change.kind === 'scene' ? `scene:${change.sceneId}` : change.kind;
}

function cancelScheduledSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

function resetPendingChanges(stageId: string | null = null): void {
  cancelScheduledSave();
  pendingChanges.clear();
  pendingStageId = stageId;
}

function schedulePendingSave(): void {
  cancelScheduledSave();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushStageSave().catch(() => {
      // flushStageSave logs once and retains the pending entries for retry.
    });
  }, 500);
}

function markPendingChanges(stageId: string | undefined, ...changes: PendingChange[]): void {
  if (!stageId || isStageDeleted(stageId)) return;
  if (pendingStageId !== stageId) resetPendingChanges(stageId);
  for (const change of changes) {
    pendingRevision += 1;
    pendingChanges.set(pendingChangeKey(change), { change, revision: pendingRevision });
  }
  schedulePendingSave();
}

/**
 * Persistence seam for production code that must use the raw Zustand
 * setState API. Normal store actions mark their own logical changes.
 */
export function markStagePersistenceDirty(changes: PendingChange[]): void {
  markPendingChanges(useStageStore.getState().stage?.id, ...changes);
}

/**
 * Drop any pending persistence work for a deleted stage. Called by the stage
 * deletion path (which marks the deletion first, bumping the stage's deletion
 * epoch — see `lib/utils/deleted-stages.ts`) so a mutation still sitting in
 * the debounce window cannot flush after the delete and resurrect the removed
 * document. Work already outside the pending map — an in-flight flush round's
 * snapshot and the departing-stage snapshot held by `setStage` — is fenced by
 * the deletion-epoch checks in `persistDirtySnapshot` and the storage layer
 * instead.
 */
export function discardPendingStageChanges(stageId: string): void {
  if (pendingStageId === stageId) resetPendingChanges();
}

/**
 * Snapshot the logical changes a deletion is about to throw away: everything
 * still queued for the stage plus the in-flight flush round's dirt (whose
 * write the deletion fence will drop). Taken by the deletion path BEFORE the
 * deletion is marked, so a deletion that fails while the document still
 * exists can hand the snapshot back to `restorePendingStageChanges` — without
 * it, the pre-delete edits would silently live only in memory.
 */
export function snapshotPendingStageChangesForDeletion(stageId: string): PendingChange[] {
  const byKey = new Map<string, PendingChange>();
  if (flushInFlight?.stageId === stageId) {
    for (const { change } of flushInFlight.dirtySnapshot.values()) {
      byKey.set(pendingChangeKey(change), change);
    }
  }
  if (pendingStageId === stageId) {
    for (const { change } of pendingChanges.values()) {
      byKey.set(pendingChangeKey(change), change);
    }
  }
  return [...byKey.values()];
}

/**
 * Re-mark the changes a failed deletion discarded, so they reach durability
 * again through the normal scheduler. Only meaningful after the deleted flag
 * was lifted; no-ops when the store has since moved to another stage (the
 * departing-stage snapshot owns that world).
 *
 * Scope: this restores the dirt captured BEFORE the deletion started (queued
 * + in-flight). Edits attempted DURING the deletion window were refused by
 * `markPendingChanges` while the deletion was in effect and are not part of
 * the snapshot — they stay memory-only until the same key is edited again
 * (deletion is driven from the home page, so such edits are not reachable in
 * the normal flow).
 *
 * Epoch note: the failed delete bumped the stage's deletion epoch, so every
 * write captured before it is permanently stale. Restoring here is still
 * safe: this function re-queues change DESCRIPTORS — the next flush round
 * captures a fresh snapshot of the CURRENT store state under the CURRENT
 * epoch. It never replays the pre-delete data capture, so the restored dirt
 * cannot be dropped as epoch-stale.
 */
export function restorePendingStageChanges(
  stageId: string,
  changes: readonly PendingChange[],
): void {
  if (changes.length === 0) return;
  if (useStageStore.getState().stage?.id !== stageId) return;
  markPendingChanges(stageId, ...changes);
}

/**
 * Evict a deleted stage from the in-memory store. Called by the deletion path
 * after the cascade succeeds: a warm store would otherwise keep rendering the
 * deleted classroom from memory — `loadFromStorage` short-circuits on it, the
 * server-restore path never runs, and every edit is silently dropped (the
 * back-button-to-a-deleted-classroom trap). No-ops when the store has since
 * moved to another stage.
 */
export function clearStoreForDeletedStage(stageId: string): void {
  if (useStageStore.getState().stage?.id !== stageId) return;
  // Re-check the deleted flag at eviction time: if a same-id restore
  // completed (and unmarked the deletion) inside the cascade-tail window,
  // the warm state is the RESTORED classroom, not the deleted ghost —
  // clearing it would discard the restore and its post-restore edits.
  if (!isStageDeleted(stageId)) return;
  useStageStore.getState().clearStore();
}

export function claimStageSceneLoadToken(): StageSceneLoadToken {
  latestStageSceneLoadToken += 1;
  return latestStageSceneLoadToken;
}

export function isCurrentStageSceneLoadToken(token: StageSceneLoadToken): boolean {
  return token === latestStageSceneLoadToken;
}

type ToolbarState = 'design' | 'ai';

function mergeSceneContentForUpdate(
  current: SceneContent,
  incoming: SceneContent | undefined,
): SceneContent | undefined {
  if (!incoming) return incoming;
  if (current.type !== 'pbl' || incoming.type !== 'pbl') return incoming;
  const currentPBL = current as PBLContent;
  const incomingPBL = incoming as PBLContent;
  if ('projectV2' in incomingPBL || !currentPBL.projectV2) return incoming;
  return {
    ...incomingPBL,
    projectV2: currentPBL.projectV2,
  };
}

interface StageState {
  // Stage info
  stage: Stage | null;

  // Scenes
  scenes: Scene[];
  currentSceneId: string | null;

  // Chats
  chats: ChatSession[];
  chatSnapshot: ChatStorageSnapshot;

  // Mode
  mode: StageMode;

  // UI state
  toolbarState: ToolbarState;

  // Transient generation state (not persisted)
  generatingOutlines: SceneOutline[];

  // Persisted outlines for resume-on-refresh
  outlines: SceneOutline[];

  // Persisted (with outlines): true once generation finished for this stage.
  // Gates resume-on-mount so an edited finished deck is not regenerated.
  generationComplete: boolean;

  // Transient generation tracking (not persisted)
  generationEpoch: number;
  generationStatus: 'idle' | 'generating' | 'paused' | 'completed' | 'error';
  currentGeneratingOrder: number;
  failedOutlines: SceneOutline[];

  // Actions
  setStage: (stage: Stage) => void;
  setScenes: (scenes: Scene[]) => void;
  addScene: (scene: Scene) => void;
  insertSceneAfter: (anchorSceneId: string, scene: Scene) => void;
  updateScene: (sceneId: string, updates: ScenePatch) => void;
  deleteScene: (sceneId: string) => void;
  setCurrentSceneId: (sceneId: string | null) => void;
  setChats: (chats: ChatSession[]) => void;
  setMode: (mode: StageMode) => void;
  setToolbarState: (state: ToolbarState) => void;
  setStageAgents: (configs: GeneratedAgentConfig[]) => void;
  setGeneratingOutlines: (outlines: SceneOutline[]) => void;
  setOutlines: (outlines: SceneOutline[]) => void;
  setGenerationComplete: (complete: boolean) => void;
  /** Mark generation complete iff every outline has a scene and none failed. */
  markGenerationCompleteIfDone: () => void;
  setGenerationStatus: (status: 'idle' | 'generating' | 'paused' | 'completed' | 'error') => void;
  setCurrentGeneratingOrder: (order: number) => void;
  bumpGenerationEpoch: () => void;
  addFailedOutline: (outline: SceneOutline) => void;
  clearFailedOutlines: () => void;
  retryFailedOutline: (outlineId: string) => void;

  // Getters
  getCurrentScene: () => Scene | null;
  getSceneById: (sceneId: string) => Scene | null;
  getSceneIndex: (sceneId: string) => number;

  // Storage
  saveToStorage: () => Promise<boolean>;
  loadFromStorage: (stageId: string, loadToken?: StageSceneLoadToken) => Promise<void>;
  clearStore: () => void;
}

function isDeckComplete({
  outlines,
  scenes,
  failedOutlines,
}: Pick<StageState, 'outlines' | 'scenes' | 'failedOutlines'>): boolean {
  return (
    outlines.length > 0 &&
    failedOutlines.length === 0 &&
    outlines.every((o) => scenes.some((s) => s.order === o.order))
  );
}

type StagePersistenceSnapshot = Pick<
  StageState,
  | 'stage'
  | 'scenes'
  | 'currentSceneId'
  | 'chats'
  | 'chatSnapshot'
  | 'outlines'
  | 'generationComplete'
>;

function persistenceSnapshot(state: StageState): StagePersistenceSnapshot {
  const { stage, scenes, currentSceneId, chats, chatSnapshot, outlines, generationComplete } =
    state;
  return { stage, scenes, currentSceneId, chats, chatSnapshot, outlines, generationComplete };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistDirtySnapshot(
  stageId: string,
  dirtySnapshot: ReadonlyMap<string, PendingEntry>,
  snapshot: StagePersistenceSnapshot,
  capturedEpoch: number,
): Promise<Set<string>> {
  if (!snapshot.stage) return new Set();
  // A stale capture is dropped, not retried: this covers snapshots that
  // escaped `discardPendingStageChanges` because they already left the
  // pending map (an in-flight flush round, or the departing-stage retry in
  // setStage). `capturedEpoch` is the deletion epoch recorded when `snapshot`
  // was taken; a deletion after that moment permanently invalidates this
  // write, even if a same-id restore has since lifted the deleted flag.
  if (isStageWriteStale(stageId, capturedEpoch)) return new Set();
  stageStorageModulePromise ??= import('@/lib/utils/stage-storage');
  const { saveStageDataIncremental } = await stageStorageModulePromise;
  const result = await saveStageDataIncremental(
    stageId,
    [...dirtySnapshot.values()].map(({ change }) => change),
    {
      stage: snapshot.stage,
      scenes: snapshot.scenes,
      currentSceneId: snapshot.currentSceneId,
      chats: snapshot.chats,
      chatSnapshot: snapshot.chatSnapshot,
      outline: {
        outlines: snapshot.outlines,
        generationComplete: snapshot.generationComplete,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
    capturedEpoch,
  );
  // A stale drop persisted nothing, but also leaves nothing to retry: the
  // deletion path owns the discard (and, on a failed delete, the restore) of
  // this stage's pending dirt. Reporting no failures is deliberate — the
  // revision guards keep any restored (re-queued) descriptors, since
  // restores mint fresh revisions.
  if (result === 'stale-dropped') return new Set();
  return new Set((result?.failedChanges ?? []).map(pendingChangeKey));
}

const useStageStoreBase = create<StageState>()((set, get) => ({
  // Initial state
  stage: null,
  scenes: [],
  currentSceneId: null,
  chats: [],
  chatSnapshot: { sessions: [], restoreMarker: null },
  mode: 'playback',
  toolbarState: 'ai',
  generatingOutlines: [],
  outlines: [],
  generationComplete: false,
  generationEpoch: 0,
  generationStatus: 'idle' as const,
  currentGeneratingOrder: -1,
  failedOutlines: [],

  // Actions
  setStage: (stage) => {
    claimStageSceneLoadToken();
    const departingState = get();
    if (
      departingState.stage?.id &&
      pendingStageId === departingState.stage.id &&
      pendingChanges.size > 0
    ) {
      const departingStageId = departingState.stage.id;
      const departingDirty = new Map(pendingChanges);
      const departingSnapshot = persistenceSnapshot(departingState);
      // The deletion epoch travels with the snapshot: a deletion during the
      // retry window permanently invalidates both attempts, even if a
      // same-id restore lands before the retry fires.
      const departingEpoch = stageDeletionEpoch(departingStageId);
      /**
       * Navigation is intentionally not a durability barrier. The immutable
       * departing snapshot is attempted immediately, retried once after a
       * short delay, then logged and dropped so it cannot leak into the next
       * document or block navigation indefinitely.
       */
      void (async () => {
        let lastFailedKeys = new Set<string>();
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            lastFailedKeys = await persistDirtySnapshot(
              departingStageId,
              departingDirty,
              departingSnapshot,
              departingEpoch,
            );
            if (lastFailedKeys.size === 0) return;
          } catch (error) {
            if (attempt === 1) throw error;
          }
          await delay(DEPARTING_STAGE_RETRY_DELAY_MS);
        }
        log.warn(
          `Departing stage ${departingStageId} dropped failed changes after one retry: ${[...lastFailedKeys].join(', ')}`,
        );
      })().catch((error) => {
        log.error(
          `Failed to flush departing stage ${departingStageId} after one retry; changes were dropped:`,
          error,
        );
      });
    }
    resetPendingChanges(stage.id);
    set((s) => ({
      stage,
      scenes: [],
      currentSceneId: null,
      chats: [],
      chatSnapshot: { sessions: [], restoreMarker: null },
      generationComplete: false,
      generationEpoch: s.generationEpoch + 1,
    }));
    markPendingChanges(stage.id, { kind: 'structure' }, { kind: 'stage' });
  },

  setScenes: (scenes) => {
    // Funnel through migrateScene so any incoming slide content lacking
    // a schemaVersion (API / snapshot / legacy) is normalized once at
    // the store boundary.
    const migrated = scenes.map(migrateScene);
    const previousCurrentSceneId = get().currentSceneId;
    const currentSceneId =
      !previousCurrentSceneId && migrated.length > 0 ? migrated[0].id : previousCurrentSceneId;
    set({ scenes: migrated, currentSceneId });
    markPendingChanges(
      get().stage?.id,
      { kind: 'structure' },
      ...(currentSceneId !== previousCurrentSceneId
        ? ([{ kind: 'currentScene' }] as PendingChange[])
        : []),
    );
  },

  addScene: (scene) => {
    const currentStage = get().stage;
    // Ignore scenes from different stages (prevents race condition during generation)
    if (!currentStage || scene.stageId !== currentStage.id) {
      log.warn(
        `Ignoring scene "${scene.title}" - stageId mismatch (scene: ${scene.stageId}, current: ${currentStage?.id})`,
      );
      return;
    }
    const scenes = [...get().scenes, migrateScene(scene)];
    // Remove the matching outline from generatingOutlines (match by order)
    const generatingOutlines = get().generatingOutlines.filter((o) => o.order !== scene.order);
    // Auto-switch from pending page to the newly generated scene
    const shouldSwitch = get().currentSceneId === PENDING_SCENE_ID;
    set({
      scenes,
      generatingOutlines,
      ...(shouldSwitch ? { currentSceneId: scene.id } : {}),
    });
    markPendingChanges(
      currentStage.id,
      { kind: 'structure' },
      ...(shouldSwitch ? ([{ kind: 'currentScene' }] as PendingChange[]) : []),
    );
  },

  insertSceneAfter: (anchorSceneId, scene) => {
    // Pro mode slide management entry point — inserts after the anchor and
    // rebalances `order` so PPTX export / array position stay consistent.
    // Edit mode is gated against active regeneration (see useEditModeLock),
    // so rewriting `order` here is safe — no outline matcher is racing us.
    const currentStage = get().stage;
    if (!currentStage || scene.stageId !== currentStage.id) {
      log.warn(
        `insertSceneAfter ignored "${scene.title}" - stageId mismatch (scene: ${scene.stageId}, current: ${currentStage?.id})`,
      );
      return;
    }
    const current = get().scenes;
    const anchorIndex = current.findIndex((s) => s.id === anchorSceneId);
    const insertIndex = anchorIndex < 0 ? current.length : anchorIndex + 1;
    const migrated = migrateScene(scene);
    const next = [...current.slice(0, insertIndex), migrated, ...current.slice(insertIndex)];
    const rebalanced = next.map((s, i) => (s.order === i + 1 ? s : { ...s, order: i + 1 }));
    set({ scenes: rebalanced });
    markPendingChanges(currentStage.id, { kind: 'structure' });
  },

  updateScene: (sceneId, updates) => {
    const scenes = get().scenes.map((scene) => {
      if (scene.id !== sceneId) return scene;
      const content = mergeSceneContentForUpdate(scene.content, updates.content) ?? scene.content;
      // Rebind `type` to the merged content's kind (a type-only patch can no
      // longer desync the discriminant from the content).
      return makeScene({ ...scene, ...updates }, content);
    });
    set({ scenes });
    markPendingChanges(get().stage?.id, { kind: 'scene', sceneId });
  },

  deleteScene: (sceneId) => {
    // A deck that is complete right now (every outline has a scene) stays
    // complete after a deletion. Capture that BEFORE removing the scene so the
    // completion (end) page and resume-suppression survive even for decks whose
    // generationComplete flag was never recorded — e.g. generated before the
    // flag existed, or edited without a reload so loadFromStorage's self-heal
    // never ran. Without this, the deletion breaks the scenes===outlines count
    // and the "Course complete" page disappears.
    const state = get();
    const wasComplete = !state.generationComplete && isDeckComplete(state);

    const scenes = get().scenes.filter((scene) => scene.id !== sceneId);
    const currentSceneId = get().currentSceneId;

    // If deleted scene was current, select next or previous
    if (currentSceneId === sceneId) {
      const index = get().getSceneIndex(sceneId);
      const newIndex = index < scenes.length ? index : scenes.length - 1;
      set({
        scenes,
        currentSceneId: scenes[newIndex]?.id || null,
      });
    } else {
      set({ scenes });
    }

    if (wasComplete) get().setGenerationComplete(true);

    markPendingChanges(
      get().stage?.id,
      { kind: 'structure' },
      ...(currentSceneId === sceneId ? ([{ kind: 'currentScene' }] as PendingChange[]) : []),
    );
  },

  setCurrentSceneId: (sceneId) => {
    set({ currentSceneId: sceneId });
    markPendingChanges(get().stage?.id, { kind: 'currentScene' });
  },

  setChats: (chats) => {
    set({ chats });
    markPendingChanges(get().stage?.id, { kind: 'chats' });
  },

  setMode: (mode) => {
    const previousMode = get().mode;
    set({ mode });

    if (previousMode === 'edit' && mode !== 'edit') {
      useCanvasStore.getState().resetCanvasState();
    }
  },

  setToolbarState: (toolbarState) => set({ toolbarState }),

  setStageAgents: (configs) => {
    const stage = get().stage;
    if (!stage) return;
    set({ stage: { ...stage, generatedAgentConfigs: configs } });
    // The roster is part of the stage document — persistence rides the shared
    // pending-change scheduler like every other stage mutation. The registry
    // and selection updates below are synchronous in-memory mirrors only.
    markPendingChanges(stage.id, { kind: 'stage' });
    applyGeneratedAgentsToRegistry(stage.id, configs);
    // Selection mirror honors provenance (same semantics as
    // restoreAgentSelection): a stage-derived selection tracks the roster
    // wholesale; a user's explicit auto choice is handled by cases below. A
    // user-set preset selection references non-generated agents only, so a
    // roster edit does not concern it.
    const settings = useSettingsStore.getState();
    const nextRosterIds = configs.map((a) => a.id);
    if (!settings.agentSelectionIsUserSet) {
      settings.setSelectedAgentIds(nextRosterIds);
    } else if (settings.agentMode === 'auto') {
      // The AgentBar's auto toggle snapshots the whole roster as the user's
      // selection, so "selection === pre-edit full roster" means the intent
      // was "everyone", not "this exact subset" — keep tracking the roster
      // wholesale (newcomers included). A genuine subset is only narrowed:
      // departed agents are dropped, newcomers are never auto-selected.
      const previousRosterIds = new Set((stage.generatedAgentConfigs ?? []).map((a) => a.id));
      const selectionWasFullRoster =
        settings.selectedAgentIds.length > 0 &&
        settings.selectedAgentIds.length === previousRosterIds.size &&
        settings.selectedAgentIds.every((id) => previousRosterIds.has(id));
      const rosterIds = new Set(nextRosterIds);
      const retained = selectionWasFullRoster
        ? nextRosterIds
        : settings.selectedAgentIds.filter((id) => rosterIds.has(id));
      if (retained.length === 0) {
        // Narrowed to nothing (every pick left the roster, or the roster was
        // rebuilt). `restoreAgentSelection` refuses an empty user-set
        // selection (`length > 0` gate) and falls back to the stage-derived
        // full roster — mirror that here instead of running the classroom
        // with zero agents until reload.
        settings.setSelectedAgentIds(nextRosterIds);
        settings.setAgentSelectionIsUserSet(false);
      } else if (
        retained.length !== settings.selectedAgentIds.length ||
        retained.some((id, index) => id !== settings.selectedAgentIds[index])
      ) {
        settings.setSelectedAgentIds(retained);
      }
    }
  },

  setGeneratingOutlines: (generatingOutlines) => set({ generatingOutlines }),

  setOutlines: (outlines) => {
    set({ outlines });
    markPendingChanges(get().stage?.id, { kind: 'outline' });
  },

  setGenerationComplete: (generationComplete) => {
    set({ generationComplete });
    // Final scenes and the completion barrier commit in the same aggregate write.
    void get().saveToStorage();
  },

  markGenerationCompleteIfDone: () => {
    const { outlines, scenes, failedOutlines, generationComplete } = get();
    if (generationComplete) return;
    if (isDeckComplete({ outlines, scenes, failedOutlines })) get().setGenerationComplete(true);
  },

  setGenerationStatus: (generationStatus) => set({ generationStatus }),

  setCurrentGeneratingOrder: (currentGeneratingOrder) => set({ currentGeneratingOrder }),

  bumpGenerationEpoch: () => set((s) => ({ generationEpoch: s.generationEpoch + 1 })),

  addFailedOutline: (outline) => {
    const existed = get().failedOutlines.some((o) => o.id === outline.id);
    if (existed) return;
    set({ failedOutlines: [...get().failedOutlines, outline] });
  },

  clearFailedOutlines: () => set({ failedOutlines: [] }),

  retryFailedOutline: (outlineId) => {
    set({
      failedOutlines: get().failedOutlines.filter((o) => o.id !== outlineId),
    });
  },

  // Getters
  getCurrentScene: () => {
    const { scenes, currentSceneId } = get();
    if (!currentSceneId) return null;
    return scenes.find((s) => s.id === currentSceneId) || null;
  },

  getSceneById: (sceneId) => {
    return get().scenes.find((s) => s.id === sceneId) || null;
  },

  getSceneIndex: (sceneId) => {
    return get().scenes.findIndex((s) => s.id === sceneId);
  },

  // Storage methods. Returns true on a verified write so callers that gate on
  // durability (e.g. setGenerationComplete) can avoid recording state that
  // outruns the scene data.
  saveToStorage: async () => {
    const { stage, scenes, currentSceneId, chats, chatSnapshot, outlines, generationComplete } =
      get();
    if (!stage?.id) {
      log.warn('Cannot save: stage.id is required');
      return false;
    }

    // Epoch captured with the state read above: a deletion during the PBL
    // preparation await below permanently invalidates this write.
    const capturedEpoch = stageDeletionEpoch(stage.id);
    const pendingAtStart = new Map(pendingChanges);
    try {
      const persistedScenes = await preparePBLScenesForDocumentPersistence(stage.id, scenes);
      const { saveStageData } = await import('@/lib/utils/stage-storage');
      const result = await saveStageData(
        stage.id,
        {
          stage,
          scenes: persistedScenes,
          currentSceneId,
          chats,
          chatSnapshot,
          outline: {
            outlines,
            generationComplete,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
        capturedEpoch,
      );

      // An epoch-stale drop persisted nothing: skip every piece of success
      // bookkeeping. The chatSnapshot must not rebind to a snapshot that
      // never landed, and the pending map must keep its dirt (the deletion
      // path owns its discard/restore). Report the write as not durable.
      if (result === 'stale-dropped') {
        log.info(`Save dropped by deletion fence for stage ${stage.id}; nothing persisted`);
        return false;
      }

      const failedKeys = new Set((result?.failedChanges ?? []).map(pendingChangeKey));
      if (
        failedKeys.has('chats') &&
        pendingStageId === stage.id &&
        !pendingChanges.has('chats') &&
        get().stage?.id === stage.id &&
        get().chats === chats
      ) {
        markPendingChanges(stage.id, { kind: 'chats' });
      }
      // Bind future saves to the exact chat snapshot this successful write
      // represented. Keep the restore marker unchanged: a stale no-op after a
      // restore must remain stale until the editor reloads.
      if (!failedKeys.has('chats') && get().stage?.id === stage.id && get().chats === chats) {
        set({
          chatSnapshot: {
            sessions: structuredClone(chats),
            restoreMarker: chatSnapshot.restoreMarker,
          },
        });
      }
      if (pendingStageId === stage.id) {
        for (const [key, entry] of pendingAtStart) {
          if (!failedKeys.has(key) && pendingChanges.get(key)?.revision === entry.revision) {
            pendingChanges.delete(key);
          }
        }
        if (pendingChanges.size === 0) cancelScheduledSave();
        else schedulePendingSave();
      }

      return true;
    } catch (error) {
      log.error('Failed to save to storage:', error);
      return false;
    }
  },

  loadFromStorage: async (stageId: string, loadToken?: StageSceneLoadToken) => {
    try {
      const token = loadToken ?? claimStageSceneLoadToken();
      // Skip IndexedDB load if the store already has this stage with scenes
      // (e.g. navigated from generation-preview with fresh in-memory data)
      const currentState = get();
      if (currentState.stage?.id === stageId && currentState.scenes.length > 0) {
        if (!isStageDeleted(stageId)) {
          log.info('Stage already loaded in memory, skipping IndexedDB load:', stageId);
          return;
        }
        // While the deletion cascade is still unsettled the ghost must be
        // KEPT: the cascade can still fail before removing the document, in
        // which case the deleted flag is lifted and the warm state (plus the
        // pending dirt the failure path restores) is the only copy of the
        // pre-delete edits. On success, `clearStoreForDeletedStage` evicts
        // the warm copy at settlement and a later load takes the settled
        // branch below.
        if (isStageDeletionInFlight(stageId)) {
          log.info('Warm stage is mid-deletion; keeping state until it settles:', stageId);
          return;
        }
        // The warm copy is a ghost of a DELETED classroom whose deletion has
        // SETTLED with the document removed (deletion evicts the store, but a
        // partially failed cascade — or any future caller — can leave one).
        // Short-circuiting here would starve the restore path: the classroom
        // loader's server-fallback gate checks `getCurrentStage()`, so a warm
        // ghost renders a fully editable classroom whose every edit is
        // silently dropped. Discard the ghost (without claiming a new load
        // token — the caller's token must stay current) and fall through to a
        // full load, which finds no local data and lets the server-restore
        // path run and lift the deletion.
        log.info('Warm stage is deleted; discarding ghost and reloading:', stageId);
        resetPendingChanges();
        set((s) => ({
          stage: null,
          scenes: [],
          currentSceneId: null,
          chats: [],
          chatSnapshot: { sessions: [], restoreMarker: null },
          outlines: [],
          generationComplete: false,
          generationEpoch: s.generationEpoch + 1,
          generationStatus: 'idle' as const,
          currentGeneratingOrder: -1,
          failedOutlines: [],
          generatingOutlines: [],
        }));
      }

      const { loadStageData } = await import('@/lib/utils/stage-storage');
      const data = await loadStageData(stageId);

      const outlinesRecord = data?.outline;
      const outlines = outlinesRecord?.outlines || [];
      const persistedComplete = outlinesRecord?.generationComplete ?? false;

      if (data) {
        // Normalize legacy slide content (missing schemaVersion) at the load
        // boundary, same as setScenes/addScene — IndexedDB snapshots predate
        // the schema field, so they must be migrated on the way in.
        const migrated = await hydratePBLScenesFromRuntime(stageId, data.scenes.map(migrateScene));
        if (!isCurrentStageSceneLoadToken(token)) {
          log.info('Newer stage load started during IndexedDB hydration, skipping load:', stageId);
          return;
        }
        const latestState = get();
        if (latestState.stage?.id === stageId && latestState.scenes.length > 0) {
          log.info('Stage appeared in memory during IndexedDB hydration, skipping load:', stageId);
          return;
        }
        // Read-side mirror of the write fence's "re-check immediately before
        // landing": in lock-free environments `loadStageData` can read the
        // document mid-cascade, before `deleteDocument` lands. Landing that
        // read would re-materialize a ghost of the deleted classroom (whose
        // edits `markPendingChanges` refuses) until the eviction blanks it.
        if (isStageDeleted(stageId)) {
          log.info('Stage was deleted during hydration, skipping load:', stageId);
          return;
        }

        // Self-heal decks generated before generationComplete was tracked: if
        // every outline already has a matching scene and none failed,
        // generation must have finished, so treat the deck as complete and
        // persist the flag. This prevents a pre-existing finished deck from
        // regenerating a slide the user deletes before the flag was ever
        // recorded.
        //
        // Matching is by `order`, consistent with the rest of the resume
        // pipeline. For a never-edited deck order is a faithful key; the only
        // way it diverges is Pro-mode insert/reorder, which is blocked while
        // outlines are still pending (see stage-mode edit gating), so an
        // interrupted deck cannot be edited into a false "all materialized".
        const inMemoryState = get();
        const failedOutlines =
          inMemoryState.stage?.id === stageId ? inMemoryState.failedOutlines : [];
        const generationComplete =
          persistedComplete ||
          isDeckComplete({
            outlines,
            scenes: migrated,
            failedOutlines,
          });
        set({
          stage: data.stage,
          scenes: migrated,
          currentSceneId: data.currentSceneId,
          chats: data.chats,
          chatSnapshot: data.chatSnapshot ?? { sessions: [], restoreMarker: undefined },
          outlines,
          generationComplete,
          // Compute generatingOutlines from persisted outlines minus completed
          // scenes. Once generation is complete the deck is frozen for editing,
          // so an orphaned outline (e.g. from a deleted slide) must NOT surface
          // as a pending placeholder or drive resume regeneration.
          generatingOutlines: generationComplete
            ? []
            : outlines.filter((o) => !migrated.some((s) => s.order === o.order)),
          // `mode` is transient UI state, not persisted with the stage.
          // Reset to 'playback' on every load so SPA navigation between
          // classrooms doesn't carry Pro-mode state across — e.g. user
          // enters edit in A, navigates to B → B was inheriting
          // mode='edit'. Refresh already reset via initial store value;
          // this normalises the SPA path to match.
          mode: 'playback',
        });
        resetPendingChanges(stageId);
        if (generationComplete && !persistedComplete) void get().saveToStorage();
        log.info('Loaded from storage:', stageId);
      } else {
        log.warn('No data found for stage:', stageId);
      }
    } catch (error) {
      log.error('Failed to load from storage:', error);
      throw error;
    }
  },

  clearStore: () => {
    claimStageSceneLoadToken();
    resetPendingChanges();
    set((s) => ({
      stage: null,
      scenes: [],
      currentSceneId: null,
      chats: [],
      chatSnapshot: { sessions: [], restoreMarker: null },
      outlines: [],
      generationComplete: false,
      generationEpoch: s.generationEpoch + 1,
      generationStatus: 'idle' as const,
      currentGeneratingOrder: -1,
      failedOutlines: [],
      generatingOutlines: [],
    }));
    log.info('Store cleared');
  },
}));

export const useStageStore = createSelectors(useStageStoreBase);

// ==================== Debounced Save ====================

const MAX_FLUSH_DRAIN_ROUNDS = 20;

function startFlushRound(): FlushRound | null {
  if (flushInFlight) return flushInFlight;
  if (!pendingStageId || pendingChanges.size === 0) return null;

  const stageId = pendingStageId;
  const dirtySnapshot = new Map(pendingChanges);
  const state = useStageStore.getState();
  if (state.stage?.id !== stageId) {
    resetPendingChanges(state.stage?.id ?? null);
    return null;
  }
  const snapshot = persistenceSnapshot(state);
  // Capture the deletion epoch WITH the data snapshot: the pair is what the
  // storage layer validates immediately before each write.
  const capturedEpoch = stageDeletionEpoch(stageId);

  const run = (async () => {
    try {
      const failedKeys = await persistDirtySnapshot(
        stageId,
        dirtySnapshot,
        snapshot,
        capturedEpoch,
      );
      if (pendingStageId === stageId) {
        for (const [key, entry] of dirtySnapshot) {
          if (!failedKeys.has(key) && pendingChanges.get(key)?.revision === entry.revision) {
            pendingChanges.delete(key);
          }
        }
      }
      if (
        dirtySnapshot.has('chats') &&
        !failedKeys.has('chats') &&
        useStageStore.getState().stage?.id === stageId &&
        useStageStore.getState().chats === snapshot.chats
      ) {
        useStageStore.setState({
          chatSnapshot: {
            sessions: structuredClone(snapshot.chats),
            restoreMarker: snapshot.chatSnapshot.restoreMarker,
          },
        });
      }
      return failedKeys;
    } catch (error) {
      log.error(`Failed to flush pending stage changes for ${stageId}:`, error);
      throw error;
    } finally {
      flushInFlight = null;
      // Successive mutations and failed writes both leave durable work queued.
      // Always restore the retry timer so dirt is never stranded.
      if (pendingChanges.size > 0 && pendingStageId) schedulePendingSave();
    }
  })();
  const round = { stageId, dirtySnapshot, promise: run };
  flushInFlight = round;
  return round;
}

function roundCoversEntry(
  round: FlushRound,
  entrySnapshot: ReadonlyMap<string, PendingEntry>,
): boolean {
  for (const [key, entry] of entrySnapshot) {
    const pending = pendingChanges.get(key);
    if (!pending || pending.revision < entry.revision) continue;
    const attempted = round.dirtySnapshot.get(key);
    if (!attempted || attempted.revision < entry.revision) return false;
  }
  return true;
}

/**
 * Drain every mutation visible to the caller, including one that lands after
 * an in-flight round captured its snapshot. Chat-store failures are reported
 * as retained dirt and retried by the debounce without rolling back a
 * successful document commit.
 */
export async function flushStageSave(): Promise<void> {
  const entryStageId = pendingStageId;
  const entryRevision = pendingRevision;
  const entrySnapshot = new Map(
    [...pendingChanges].filter(([, entry]) => entry.revision <= entryRevision),
  );

  for (let round = 0; round < MAX_FLUSH_DRAIN_ROUNDS; round += 1) {
    cancelScheduledSave();
    const stillPendingAtEntry = [...entrySnapshot].some(([key, entry]) => {
      const pending = pendingChanges.get(key);
      return (
        pendingStageId === entryStageId &&
        pending !== undefined &&
        pending.revision >= entry.revision
      );
    });
    if (!entryStageId || entrySnapshot.size === 0 || !stillPendingAtEntry) return;

    const flushRound = startFlushRound();
    if (!flushRound) return;
    const coversEntry = roundCoversEntry(flushRound, entrySnapshot);
    try {
      const failedKeys = await flushRound.promise;
      if (coversEntry && failedKeys.size > 0) return;
    } catch (error) {
      if (coversEntry) throw error;
    }
  }
  throw new Error(`Stage persistence did not quiesce after ${MAX_FLUSH_DRAIN_ROUNDS} flush rounds`);
}

if (typeof window !== 'undefined') {
  const kickPendingSave = () => {
    void flushStageSave().catch(() => {
      // Best effort during page shutdown; pending dirt remains for a live retry.
    });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') kickPendingSave();
  });
  window.addEventListener('beforeunload', kickPendingSave);
}
