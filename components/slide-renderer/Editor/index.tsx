'use client';

import { RendererScreenCanvas } from './RendererScreenCanvas';

/** Classroom playback canvas for a slide scene. */
export function SlideEditor() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden">
        <RendererScreenCanvas />
      </div>
    </div>
  );
}
