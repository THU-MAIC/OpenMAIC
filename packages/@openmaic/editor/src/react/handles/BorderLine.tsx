import type { CSSProperties } from 'react';

/**
 * Presentational selection border rect. Pure props-driven: no store, no
 * document knowledge. `width`/`height` are already resolved to px (the
 * caller applies canvas scale before passing them in). `style` lets a caller
 * (e.g. `SelectionOverlay`) layer on positioning without this component
 * needing to know about elements or scale.
 */
export interface BorderLineProps {
  width: number;
  height: number;
  className?: string;
  style?: CSSProperties;
}

export function BorderLine({ width, height, className, style }: BorderLineProps) {
  return (
    <div
      data-selection-border=""
      className={className}
      style={{
        position: 'absolute',
        width: `${width}px`,
        height: `${height}px`,
        outline: '1px solid #3b82f6',
        outlineOffset: '-1px',
        boxSizing: 'border-box',
        pointerEvents: 'none',
        ...style,
      }}
    />
  );
}
