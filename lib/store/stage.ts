import { create } from 'zustand';
import type { Stage, Scene, StageMode } from '@/lib/types/stage';
import { createSelectors } from '@/lib/utils/create-selectors';
import type { ChatSession } from '@/lib/types/chat';
import type { SceneOutline } from '@/lib/types/generation';
import { createLogger } from '@/lib/logger';

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

  // Transient generation tracking (not persisted)
  generationEpoch: number;
  generationStatus: 'idle' | 'generating' | 'paused' | 'completed' | 'error';
  currentGeneratingOrder: number;
  failedOutlines: SceneOutline[];

  // Actions
  setStage: (stage: Stage) => void;
  setScenes: (scenes: Scene[]) => void;
  addScene: (scene: Scene) => void;
  updateScene: (sceneId: string, updates: Partial<Scene>) => void;
  deleteScene: (sceneId: string) => void;
  setCurrentSceneId: (sceneId: string | null) => void;
  setChats: (chats: ChatSession[]) => void;
  setMode: (mode: StageMode) => void;
  setToolbarState: (state: ToolbarState) => void;
  setGeneratingOutlines: (outlines: SceneOutline[]) => void;
  setOutlines: (outlines: SceneOutline[]) => void;
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
  saveToStorage: () => Promise<void>;
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
      generationEpoch: s.generationEpoch + 1,
    }));
    debouncedSave();
  },

  setScenes: (scenes) => {
    set({ scenes });
    // Auto-select first scene if no current scene
    if (!get().currentSceneId && scenes.length > 0) {
      set({ currentSceneId: scenes[0].id });
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
    const scenes = [...get().scenes, scene];
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

  updateScene: (sceneId, updates) => {
    const scenes = get().scenes.map((scene) =>
      scene.id === sceneId ? { ...scene, ...updates } : scene,
    );
    set({ scenes });
    debouncedSave();
  },

  deleteScene: (sceneId) => {
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

  setMode: (mode) => set({ mode }),

  setToolbarState: (toolbarState) => set({ toolbarState }),

  setGeneratingOutlines: (generatingOutlines) => set({ generatingOutlines }),

  setOutlines: (outlines) => {
    set({ outlines });
    // Persist outlines to IndexedDB
    const stageId = get().stage?.id;
    if (stageId) {
      import('@/lib/utils/database').then(({ db }) => {
        db.stageOutlines.put({
          stageId,
          outlines,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      });
    }
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

  // Storage methods
  saveToStorage: async () => {
    const { stage, scenes, currentSceneId, chats } = get();
    if (!stage?.id) {
      log.warn('Cannot save: stage.id is required');
      return;
    }

    try {
      const { saveStageData } = await import('@/lib/utils/stage-storage');
      await saveStageData(stage.id, {
        stage,
        scenes,
        currentSceneId,
        chats,
      });
    } catch (error) {
      log.error('Failed to save to storage:', error);
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

      if (data) {
        set({
          stage: data.stage,
          scenes: data.scenes,
          currentSceneId: data.currentSceneId,
          chats: data.chats,
          outlines,
          // Compute generatingOutlines from persisted outlines minus completed scenes
          generatingOutlines: outlines.filter((o) => !data.scenes.some((s) => s.order === o.order)),
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
