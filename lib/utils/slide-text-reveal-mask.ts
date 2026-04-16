import type { CSSProperties } from 'react';

/** CSS mask so slide text appears progressively (horizontal or vertical writing mode). */
export function slideTextRevealMaskStyle(
  local: number | null,
  vertical: boolean | undefined,
): CSSProperties | undefined {
  if (local === null) return undefined;
  const p = Math.max(0, Math.min(1, local));
  const dir = vertical ? 'to bottom' : 'to right';
  const hard = p * 100;
  const softStart = Math.max(0, hard - 0.4);
  const g = `linear-gradient(${dir}, #000 0%, #000 ${softStart}%, transparent ${hard}%)`;
  return {
    WebkitMaskImage: g,
    WebkitMaskSize: '100% 100%',
    maskImage: g,
    maskSize: '100% 100%',
  };
}
