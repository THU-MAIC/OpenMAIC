'use client';

import type { AlignmentLineProps } from '@/lib/types/edit';

export interface AlignmentLineComponentProps extends AlignmentLineProps {
  canvasScale: number;
}

/**
 * Alignment line component
 * Displays visual alignment guides during element dragging
 */
export function AlignmentLine({ type, axis, length, canvasScale }: AlignmentLineComponentProps) {
  // Alignment line position
  const left = axis.x * canvasScale;
  const top = axis.y * canvasScale;

  // Alignment line length
  const sizeStyle =
    type === 'vertical'
      ? { height: `${length * canvasScale}px` }
      : { width: `${length * canvasScale}px` };

  return (
    <div
      className="alignment-line absolute z-42"
      style={{
        left: `${left}px`,
        top: `${top}px`,
      }}
    >
      <div
        className={`line ${type === 'vertical' ? 'border-l border-dashed border-primary -translate-x-0.5' : 'border-t border-dashed border-primary -translate-y-0.5'}`}
        style={sizeStyle}
      />
    </div>
  );
}
