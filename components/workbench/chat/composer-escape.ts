'use client';

import { useEffect, useState } from 'react';

/** How long the first Escape stays armed. */
export const DOUBLE_ESCAPE_WINDOW_MS = 600;

export type EscapeStopIntent = 'ignore' | 'arm' | 'stop';

export function resolveEscapeStopIntent(input: {
  generating: boolean;
  overlayOwnsEscape: boolean;
  armedAt: number | null;
  now: number;
  windowMs?: number;
}): EscapeStopIntent {
  const { generating, overlayOwnsEscape, armedAt, now, windowMs = DOUBLE_ESCAPE_WINDOW_MS } = input;
  if (overlayOwnsEscape) return 'ignore';
  if (!generating) return 'ignore';
  if (armedAt !== null && now - armedAt >= 0 && now - armedAt <= windowMs) return 'stop';
  return 'arm';
}

export function overlayOwnsEscape(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector('[data-esc-owner]') !== null;
}

export function useDoubleEscapeStop({
  generating,
  onStop,
  windowMs = DOUBLE_ESCAPE_WINDOW_MS,
}: {
  generating: boolean;
  onStop: () => void;
  windowMs?: number;
}): { armed: boolean } {
  const [armedAt, setArmedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!generating) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const intent = resolveEscapeStopIntent({
        generating,
        overlayOwnsEscape: overlayOwnsEscape(),
        armedAt,
        now: Date.now(),
        windowMs,
      });
      if (intent === 'ignore') return;
      if (intent === 'arm') {
        setArmedAt(Date.now());
        return;
      }
      setArmedAt(null);
      onStop();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [armedAt, generating, onStop, windowMs]);

  useEffect(() => {
    if (armedAt === null) return;
    const timer = setTimeout(() => setArmedAt(null), windowMs);
    return () => clearTimeout(timer);
  }, [armedAt, windowMs]);

  return { armed: generating && armedAt !== null };
}
