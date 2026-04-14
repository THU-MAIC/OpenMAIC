'use client';

import { useEffect, useState } from 'react';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { ScreenElement } from '@/components/slide-renderer/Editor/ScreenElement';
import { useStageStore } from '@/lib/store/stage';
import type { PPTElement } from '@/lib/types/slides';
import type { Scene } from '@/lib/types/stage';

// Fixed IDs for the synthetic stage/scene used by this eval page
const EVAL_STAGE_ID = '__eval_stage__';
const EVAL_SCENE_ID = '__eval_scene__';

const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 562.5;

function buildEvalScene(elements: PPTElement[]): Scene {
  return {
    id: EVAL_SCENE_ID,
    stageId: EVAL_STAGE_ID,
    type: 'slide',
    title: 'eval',
    order: 0,
    content: {
      type: 'slide',
      canvas: {
        id: EVAL_SCENE_ID,
        viewportSize: CANVAS_WIDTH,
        viewportRatio: CANVAS_HEIGHT / CANVAS_WIDTH,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#5b9bd5'],
          fontColor: '#333333',
          fontName: 'Microsoft YaHei',
        },
        elements,
      },
    },
  };
}

function WhiteboardCanvas() {
  const [elements, setElements] = useState<PPTElement[]>([]);

  // Seed the store with the synthetic scene on mount
  const setStage = useStageStore((s) => s.setStage);
  const setScenes = useStageStore((s) => s.setScenes);
  const setCurrentSceneId = useStageStore((s) => s.setCurrentSceneId);
  const updateScene = useStageStore((s) => s.updateScene);

  useEffect(() => {
    // Bootstrap a minimal stage so SceneProvider can find the scene
    setStage({ id: EVAL_STAGE_ID, name: 'eval', createdAt: 0, updatedAt: 0 });
    setScenes([buildEvalScene([])]);
    setCurrentSceneId(EVAL_SCENE_ID);
  }, [setStage, setScenes, setCurrentSceneId]);

  useEffect(() => {
    // Expose setter for Playwright
    (window as unknown as Record<string, unknown>)['__setElements'] = (incoming: PPTElement[]) => {
      setElements(incoming);
      updateScene(EVAL_SCENE_ID, {
        content: {
          type: 'slide',
          canvas: {
            id: EVAL_SCENE_ID,
            viewportSize: CANVAS_WIDTH,
            viewportRatio: CANVAS_HEIGHT / CANVAS_WIDTH,
            theme: {
              backgroundColor: '#ffffff',
              themeColors: ['#5b9bd5'],
              fontColor: '#333333',
              fontName: 'Microsoft YaHei',
            },
            elements: incoming,
          },
        },
      });
    };

    // Signal that the page is ready for Playwright
    (window as unknown as Record<string, unknown>)['__evalReady'] = true;
  }, [updateScene]);

  return (
    <div
      style={{
        position: 'relative',
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        backgroundColor: '#ffffff',
        overflow: 'hidden',
      }}
    >
      {elements.map((element, index) => (
        <ScreenElement key={element.id} elementInfo={element} elementIndex={index} />
      ))}
    </div>
  );
}

export default function EvalWhiteboardPage() {
  return (
    <SceneProvider>
      <WhiteboardCanvas />
    </SceneProvider>
  );
}
