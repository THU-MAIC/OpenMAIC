'use client';

import type { PPTElement } from '@openmaic/dsl';
import type { HighlightEffectOptions } from '../types/effects';

export interface HighlightOverlayProps {
  element: PPTElement;
  options?: HighlightEffectOptions;
}

export function HighlightOverlay({ element, options }: HighlightOverlayProps) {
  if (element.type === 'line') return null;

  const color = options?.color ?? '#ff6b6b';
  const opacity = options?.opacity ?? 0.3;
  const borderWidth = options?.borderWidth ?? 3;
  const animated = options?.animated ?? true;

  const height = 'height' in element ? element.height : 0;
  const rotate = 'rotate' in element ? element.rotate : 0;

  return (
    <div
      className="highlight-overlay"
      style={{
        position: 'absolute',
        pointerEvents: 'none',
        left: `${element.left}px`,
        top: `${element.top}px`,
        width: `${element.width}px`,
        height: `${height}px`,
        transform: `rotate(${rotate || 0}deg)`,
        transformOrigin: 'center',
        zIndex: 999,
        transition: 'all 0.3s ease-in-out',
      }}
    >
      <div
        className={animated ? 'slide-renderer-pulse' : undefined}
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '4px',
          border: `${borderWidth}px solid ${color}`,
          boxShadow: `0 0 ${borderWidth * 3}px ${color}, inset 0 0 ${borderWidth * 2}px rgba(255,255,255,${opacity * 0.5})`,
          backgroundColor: `${color}${Math.round(opacity * 255)
            .toString(16)
            .padStart(2, '0')}`,
        }}
      />
      {animated && (
        <div
          className="slide-renderer-ping"
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '4px',
            border: `${borderWidth}px solid ${color}`,
            opacity: 0.5,
            animationDuration: '2s',
          }}
        />
      )}
    </div>
  );
}
