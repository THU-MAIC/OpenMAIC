'use client';

import { useEffect } from 'react';

import type { Scene } from '@/lib/types/stage';
import { LearningTaskPanel } from './learning-task-panel';

interface LearningTaskBridgeProps {
  classroomId: string;
  scenes: Scene[];
  currentSceneId: string | null;
  onSelectScene: (sceneId: string) => void;
}

export function LearningTaskBridge({
  classroomId,
  scenes,
  currentSceneId,
  onSelectScene,
}: LearningTaskBridgeProps) {
  useEffect(() => {
    if (typeof window === 'undefined' || scenes.length === 0) return;
    const url = new URL(window.location.href);
    const requestedSceneId = url.searchParams.get('scene');
    if (!requestedSceneId) return;
    if (scenes.some((scene) => scene.id === requestedSceneId)) {
      onSelectScene(requestedSceneId);
    }
    url.searchParams.delete('scene');
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [classroomId, scenes, onSelectScene]);

  return (
    <LearningTaskPanel
      classroomId={classroomId}
      scenes={scenes}
      currentSceneId={currentSceneId}
      onSelectScene={onSelectScene}
    />
  );
}
