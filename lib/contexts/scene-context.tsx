'use client';

import React, {
  createContext,
  useContext,
  useMemo,
  useCallback,
  useSyncExternalStore,
  useRef,
  useEffect,
} from 'react';
import { useStageStore } from '@/lib/store/stage';
import type { Scene } from '@/lib/types/stage';
import { produce } from 'immer';

interface SceneContextValue<T = unknown> {
  sceneId: string;
  sceneType: Scene['type'];
  sceneData: T;
  updateSceneData: (updater: (draft: T) => void) => void;
  // Internal: subscribe to scene data changes
  subscribe: (callback: () => void) => () => void;
  getSnapshot: () => T;
}

const SceneContext = createContext<SceneContextValue | null>(null);

/**
 * Generic Scene Provider
 * Provides current scene data and update methods to child components
 * Automatically syncs changes back to stageStore
 *
 * Usage:
 * <SceneProvider>
 *   <SlideRenderer /> // Uses useSceneData<SlideContent>()
 * </SceneProvider>
 */
export function SceneProvider({ children }: { children: React.ReactNode }) {
  // Subscribe to current scene
  const currentScene = useStageStore((state) => {
    if (!state.currentSceneId) return null;
    return state.scenes.find((s) => s.id === state.currentSceneId) || null;
  });

  const updateScene = useStageStore((state) => state.updateScene);

  const sceneId = currentScene?.id || '';
  const sceneType = currentScene?.type || 'slide';
  const sceneData = currentScene?.content || null;

  // Listeners for scene data changes
  const listenersRef = useRef(new Set<() => void>());

  // Subscribe function for child components
  const subscribe = useCallback((callback: () => void) => {
    listenersRef.current.add(callback);
    return () => {
      listenersRef.current.delete(callback);
    };
  }, []);

  // Get current snapshot
  const getSnapshot = useCallback(() => {
    return sceneData;
  }, [sceneData]);

  // Notify all listeners when sceneData changes
  useEffect(() => {
    listenersRef.current.forEach((listener) => listener());
  }, [sceneData]);

  // Update scene data with Immer
  const updateSceneData = useCallback(
    (updater: (draft: unknown) => void) => {
      if (!currentScene) return;

      const newContent = produce(currentScene.content, updater);
      updateScene(currentScene.id, {
        content: newContent,
      });
    },
    [currentScene, updateScene],
  );

  const value = useMemo(
    () => ({
      sceneId,
      sceneType,
      sceneData,
      updateSceneData,
      subscribe,
      getSnapshot,
    }),
    [sceneId, sceneType, sceneData, updateSceneData, subscribe, getSnapshot],
  );

  // Don't render anything if there's no scene - let parent component handle this
  if (!currentScene) {
    return null;
  }

  return <SceneContext.Provider value={value}>{children}</SceneContext.Provider>;
}

/**
 * Hook to access current scene data
 * Type-safe with generics
 *
 * @example
 * // In SlideRenderer
 * const { sceneData, updateSceneData } = useSceneData<SlideContent>();
 * const Canvas = sceneData.Canvas;
 *
 * // Update Canvas background
 * updateSceneData(draft => {
 *   draft.Canvas.background = { type: 'solid', color: '#fff' };
 * });
 */
export function useSceneData<T = unknown>(): SceneContextValue<T> {
  const context = useContext(SceneContext);
  if (!context) {
    throw new Error('useSceneData must be used within SceneProvider');
  }
  return context as SceneContextValue<T>;
}

/**
 * Hook to subscribe to a specific part of scene data
 * **Precise subscription** - only re-renders when the selector return value changes
 *
 * How it works:
 * 1. Uses useSyncExternalStore to subscribe to an external data source
 * 2. Selector extracts the needed data slice
 * 3. React auto-performs shallow comparison, only triggering re-render when the return value changes
 *
 * @example
 * // Only subscribes to background; changes to elements won't trigger re-render
 * const background = useSceneSelector<SlideContent>(
 *   content => content.Canvas.background
 * );
 */
export function useSceneSelector<T = unknown, R = unknown>(selector: (data: T) => R): R {
  const context = useContext(SceneContext);
  if (!context) {
    throw new Error('useSceneSelector must be used within SceneProvider');
  }

  const { subscribe, getSnapshot } = context as SceneContextValue<T>;

  // Cache selector and previous result
  const selectorRef = useRef(selector);
  const snapshotRef = useRef<R | undefined>(undefined);

  // Update selector ref
  useEffect(() => {
    selectorRef.current = selector;
  }, [selector]);

  // Use useSyncExternalStore for precise subscription
  return useSyncExternalStore(
    subscribe,
    () => {
      const snapshot = getSnapshot();
      const newValue = selectorRef.current(snapshot);

      // Shallow comparison optimization: if value hasn't changed, return previous reference
      if (snapshotRef.current !== undefined && shallowEqual(snapshotRef.current, newValue)) {
        return snapshotRef.current;
      }

      snapshotRef.current = newValue;
      return newValue;
    },
    () => {
      // SSR fallback
      const snapshot = getSnapshot();
      return selectorRef.current(snapshot);
    },
  );
}

/**
 * Shallow comparison function
 * Used to optimize re-renders in useSceneSelector
 */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }

  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);

  if (keysA.length !== keysB.length) {
    return false;
  }

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key) || !Object.is(objA[key], objB[key])) {
      return false;
    }
  }

  return true;
}
