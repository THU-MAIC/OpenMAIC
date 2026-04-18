'use client';

import type { PercentageGeometry } from '@/lib/types/action';

interface LaserOverlayProps {
  geometry: PercentageGeometry;
  color?: string;
  /** @deprecated Kept for API compatibility; laser is always visible immediately */
  duration?: number;
}

/**
 * Laser pointer — percentage position (0–100) in the slide viewport.
 * Rendered at the target immediately (no fly-in) so playback and video export
 * see the dot on the first frame.
 */
export function LaserOverlay({
  geometry,
  color = '#ff3b30',
}: LaserOverlayProps) {
  const { centerX, centerY } = geometry;

  return (
    <div
      key={`laser-${centerX}-${centerY}`}
      className="absolute z-[101] pointer-events-none -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${centerX}%`, top: `${centerY}%` }}
    >
      <div className="relative">
        {/* Expanding ring — pure CSS so snapshots / html2canvas see a stable dot */}
        <span
          className="absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 opacity-50 motion-safe:animate-ping"
          style={{ borderColor: color }}
          aria-hidden
        />
        <div
          className="absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            backgroundColor: color,
            boxShadow: `0 0 10px 3px ${color}99`,
          }}
        />
      </div>
    </div>
  );
}
