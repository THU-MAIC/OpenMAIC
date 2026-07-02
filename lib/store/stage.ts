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

const log = createLogger('StageStore');

/** Virtual scene ID used when the user navigates to a page still being generated */
export const PENDING_SCENE_ID = '__pending__';

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
  loadFromStorage: (stageId: string) => Promise<void>;
  clearStore: () => void;
}

const useStageStoreBase = create<StageState>()((set, get) => ({
  // Initial state
  stage: null,
  scenes: [],
  currentSceneId: null,
  chats: [],
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
    set((s) => ({
      stage,
      scenes: [],
      currentSceneId: null,
      chats: [],
      generationComplete: false,
      generationEpoch: s.generationEpoch + 1,
    }));
    debouncedSave();
  },

  setScenes: (scenes) => {
    // Funnel through migrateScene so any incoming slide content lacking
    // a schemaVersion (API / snapshot / legacy) is normalized once at
    // the store boundary.
    const migrated = scenes.map(migrateScene);
    set({ scenes: migrated });
    // Auto-select first scene if no current scene
    if (!get().currentSceneId && migrated.length > 0) {
      set({ currentSceneId: migrated[0].id });
    }
    debouncedSave();
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
    debouncedSave();
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
    debouncedSave();
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
    debouncedSave();
  },

  deleteScene: (sceneId) => {
    // A deck that is complete right now (every outline has a scene) stays
    // complete after a deletion. Capture that BEFORE removing the scene so the
    // completion (end) page and resume-suppression survive even for decks whose
    // generationComplete flag was never recorded — e.g. generated before the
    // flag existed, or edited without a reload so loadFromStorage's self-heal
    // never ran. Without this, the deletion breaks the scenes===outlines count
    // and the "Course complete" page disappears.
    const wasComplete =
      !get().generationComplete &&
      get().outlines.length > 0 &&
      get().failedOutlines.length === 0 &&
      get().outlines.every((o) => get().scenes.some((s) => s.order === o.order));

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

    debouncedSave();
  },

  setCurrentSceneId: (sceneId) => {
    set({ currentSceneId: sceneId });
    debouncedSave();
  },

  setChats: (chats) => {
    set({ chats });
    debouncedSave();
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
    debouncedSave();
    debouncedSaveAgents();
  },

  setGeneratingOutlines: (generatingOutlines) => set({ generatingOutlines }),

  setOutlines: (outlines) => {
    set({ outlines });
    // Persist outlines to IndexedDB. Carry generationComplete so writing
    // outlines never clobbers a previously-recorded completion flag.
    const stageId = get().stage?.id;
    if (stageId) {
      const generationComplete = get().generationComplete;
      import('@/lib/utils/database').then(({ db }) => {
        db.stageOutlines.put({
          stageId,
          outlines,
          generationComplete,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      });
    }
  },

  setGenerationComplete: (generationComplete) => {
    set({ generationComplete });
    // Persist alongside the outlines record so resume-on-mount can read it.
    const stageId = get().stage?.id;
    if (stageId) {
      const outlines = get().outlines;
      // Flush the current scenes BEFORE recording completion, and only record
      // it once that flush is verified. Scenes save through a 500ms debounce,
      // so writing the flag eagerly could let a reload see
      // generationComplete=true with the final slide still unsaved — which
      // would then be suppressed (not pending) and lost. If the scene flush
      // fails, skip the flag: the deck stays resumable and recovers on reload.
      void get()
        .saveToStorage()
        .then((saved) => {
          if (!saved) return;
          return import('@/lib/utils/database').then(({ db }) => {
            db.stageOutlines.put({
              stageId,
              outlines,
              generationComplete,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          });
        });
    }
  },

  markGenerationCompleteIfDone: () => {
    const { outlines, scenes, failedOutlines, generationComplete } = get();
    if (generationComplete) return;
    const done =
      outlines.length > 0 &&
      failedOutlines.length === 0 &&
      outlines.every((o) => scenes.some((s) => s.order === o.order));
    if (done) get().setGenerationComplete(true);
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
    const { stage, scenes, currentSceneId, chats } = get();
    if (!stage?.id) {
      log.warn('Cannot save: stage.id is required');
      return false;
    }

    try {
      const { saveStageData } = await import('@/lib/utils/stage-storage');
      await saveStageData(stage.id, {
        stage,
        scenes,
        currentSceneId,
        chats,
      });

      return true;
    } catch (error) {
      log.error('Failed to save to storage:', error);
      return false;
    }
  },

  loadFromStorage: async (stageId: string) => {
    try {
      // Skip IndexedDB load if the store already has this stage with scenes
      // (e.g. navigated from generation-preview with fresh in-memory data)
      const currentState = get();
      if (currentState.stage?.id === stageId && currentState.scenes.length > 0) {
        log.info('Stage already loaded in memory, skipping IndexedDB load:', stageId);
        return;
      }

      const { loadStageData } = await import('@/lib/utils/stage-storage');
      const data = await loadStageData(stageId);

      // Load outlines for resume-on-refresh
      const { db } = await import('@/lib/utils/database');
      const outlinesRecord = await db.stageOutlines.get(stageId);
      const outlines = outlinesRecord?.outlines || [];
      const persistedComplete = outlinesRecord?.generationComplete ?? false;

      if (data) {
        // Normalize legacy slide content (missing schemaVersion) at the load
        // boundary, same as setScenes/addScene — IndexedDB snapshots predate
        // the schema field, so they must be migrated on the way in.
        const migrated = data.scenes.map(migrateScene);

        // Self-heal decks generated before generationComplete was tracked: if
        // every outline already has a matching scene, generation must have
        // finished, so treat the deck as complete and persist the flag. This
        // prevents a pre-existing finished deck from regenerating a slide the
        // user deletes before the flag was ever recorded.
        //
        // Matching is by `order`, consistent with the rest of the resume
        // pipeline. For a never-edited deck order is a faithful key; the only
        // way it diverges is Pro-mode insert/reorder, which is blocked while
        // outlines are still pending (see stage-mode edit gating), so an
        // interrupted deck cannot be edited into a false "all materialized".
        const allMaterialized =
          outlines.length > 0 && outlines.every((o) => migrated.some((s) => s.order === o.order));
        const generationComplete = persistedComplete || allMaterialized;
        if (generationComplete && !persistedComplete) {
          db.stageOutlines.put({
            stageId,
            outlines,
            generationComplete: true,
            createdAt: outlinesRecord?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          });
        }

        set({
          stage: data.stage,
          scenes: migrated,
          currentSceneId: data.currentSceneId,
          chats: data.chats,
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
    set((s) => ({
      stage: null,
      scenes: [],
      currentSceneId: null,
      chats: [],
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

/**
 * Debounced version of saveToStorage to prevent excessive writes
 * Waits 500ms after the last change before saving
 */
const debouncedSave = debounce(() => {
  useStageStore.getState().saveToStorage();
}, 500);

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
