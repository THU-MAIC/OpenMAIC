'use client';

import { useEffect } from 'react';
import { SpotlightOverlay } from '@/components/slide-renderer/Editor/SpotlightOverlay';
import { LaserPointerOverlay } from '@/components/slide-renderer/Editor/LaserPointerOverlay';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { useCanvasStore } from '@/lib/store/canvas';
import { ElementPickLayer } from './ElementPickLayer';
import { ElementRefPinLayer } from './ElementRefPinLayer';
import { EDITABLE_ELEMENT_ID_PREFIX } from './renderer-element-dom';
import { useSlideCanvasController } from './use-slide-surface';
import { RendererEditorCanvas } from './RendererEditorCanvas';

export function SlideCanvas() {
  const { controller } = useSlideCanvasController();

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const canvas = useCanvasStore.getState();
      if (canvas.creatingElement) canvas.setCreatingElement(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="relative h-full w-full">
      <SceneProvider controller={controller}>
        <RendererEditorCanvas />
        <SpotlightOverlay domIdPrefix={EDITABLE_ELEMENT_ID_PREFIX} />
        <LaserPointerOverlay domIdPrefix={EDITABLE_ELEMENT_ID_PREFIX} />
      </SceneProvider>
      <ElementRefPinLayer />
      <ElementPickLayer />
    </div>
  );
}
