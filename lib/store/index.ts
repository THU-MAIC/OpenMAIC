// Core stores
import { useCanvasStore } from './canvas';
import { useSnapshotStore } from './snapshot';
import { useKeyboardStore } from './keyboard';
import { useStageStore } from './stage';
import { useSettingsStore } from './settings';

export {
  // New architecture
  useCanvasStore,
  useStageStore,
  useSnapshotStore,
  useKeyboardStore,
  useSettingsStore,
};

// Scene Context API (for extensible scene types)
export { SceneProvider, useSceneData, useSceneSelector } from '@/lib/contexts/scene-context';
