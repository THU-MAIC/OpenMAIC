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
import { migrateScene } from '@/lib/edit/slide-schema';
import { preparePBLScenesForDocumentPersistence } from '@/lib/pbl/v2/runtime/document-persistence';
import { hydratePBLScenesFromRuntime } from '@/lib/pbl/v2/runtime/hydration';
import type { ChatStorageSnapshot } from '@/lib/utils/chat-storage';
import type { PendingChange } from '@/lib/utils/stage-storage';

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
  if (!stageId) return;
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

export function claimStageSceneLoadToken(): StageSceneLoadToken {
  latestStageSceneLoadToken += 1;
  return latestStageSceneLoadToken;
}

export function isCurrentStageSceneLoadToken(token: StageSceneLoadToken): boolean {
  return token === latestStageSceneLoadToken;
}

// ==================== Debounce Helper ====================

/**
 * Debounce function to limit how often a function is called
 * @param func Function to debounce
 * @param delay Delay in milliseconds
 */
function debounce<T extends (...args: Parameters<T>) => ReturnType<T>>(
  func: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      func(...args);
      timeoutId = null;
    }, delay);
  };
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
): Promise<Set<string>> {
  if (!snapshot.stage) return new Set();
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
  );
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
    markPendingChanges(stage.id, { kind: 'stage' });
    debouncedSaveAgents();
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

    const pendingAtStart = new Map(pendingChanges);
    try {
      const persistedScenes = await preparePBLScenesForDocumentPersistence(stage.id, scenes);
      const { saveStageData } = await import('@/lib/utils/stage-storage');
      const result = await saveStageData(stage.id, {
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
      });

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
        log.info('Stage already loaded in memory, skipping IndexedDB load:', stageId);
        return;
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

  const run = (async () => {
    try {
      const failedKeys = await persistDirtySnapshot(stageId, dirtySnapshot, snapshot);
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
  const round = { dirtySnapshot, promise: run };
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

/**
 * Debounced registry sync — fires ONLY when the agent roster is edited.
 * Keeps db.generatedAgents writes off the broad saveToStorage path so scene
 * advances (setCurrentSceneId etc.) never churn the registry mid-playback.
 */
const debouncedSaveAgents = debounce(async () => {
  const { stage } = useStageStore.getState();
  if (!stage?.id || !stage.generatedAgentConfigs) return;
  const { saveGeneratedAgents } = await import('@/lib/orchestration/registry/store');
  await saveGeneratedAgents(stage.id, stage.generatedAgentConfigs);
  const { useSettingsStore } = await import('@/lib/store/settings');
  useSettingsStore.getState().setSelectedAgentIds(stage.generatedAgentConfigs.map((a) => a.id));
}, 500);
