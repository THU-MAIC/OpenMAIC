'use client';

import { useEffect, useState } from 'react';
import { ScreenElement } from '@/components/slide-renderer/Editor/ScreenElement';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { useStageStore } from '@/lib/store/stage';
import type { PPTElement } from '@/lib/types/slides';

const EVAL_STAGE_ID = '__eval_stage__';
const EVAL_SCENE_ID = '__eval_scene__';
const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 563;

function WhiteboardCanvas() {
  const [elements, setElements] = useState<PPTElement[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Bootstrap store with a synthetic stage + scene
    const store = useStageStore.getState();
    store.setStage({
      id: EVAL_STAGE_ID,
      name: 'eval',
      createdAt: 0,
      updatedAt: 0,
    });
    store.setScenes([
      {
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
            elements: [],
          },
        },
      },
    ]);
    store.setCurrentSceneId(EVAL_SCENE_ID);

    // Expose setter for Playwright
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setElements = (incoming: PPTElement[]) => {
      setElements(incoming);
      // Also update the store so SceneProvider/ScreenElement reads the theme
      useStageStore.getState().updateScene(EVAL_SCENE_ID, {
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

    // Signal readiness
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__evalReady = true;
    // Defer setReady to avoid cascading render warning
    queueMicrotask(() => setReady(true));
  }, []);

  if (!ready) return null;

  return (
    <SceneProvider>
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
    </SceneProvider>
  );
}

export default function EvalWhiteboardPage() {
  return <WhiteboardCanvas />;
}
