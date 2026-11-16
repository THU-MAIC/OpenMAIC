'use client';

/**
 * A prompt handed to the home composer from outside it (the first-run tour's
 * example prompts), applied ONCE.
 *
 * A seed is an event, not state: the composer takes it, tells the host it did
 * (`consume`), and the host drops it. Two guards make "once" hold even when the
 * host does not drop it: keys are unique for the page's lifetime, and a key the
 * composer has taken is remembered here, outside any component, so a remount
 * (Home entered again) or StrictMode's second effect run finds it already taken.
 */

import { useCallback, useState } from 'react';

export interface PromptSeed {
  readonly key: number;
  readonly text: string;
  /** Send it at once, as Enter would. */
  readonly send?: boolean;
}

let lastKey = 0;
const taken = new Set<number>();

export function nextPromptSeedKey(): number {
  lastKey += 1;
  return lastKey;
}

/** True the first time a key is taken, false every time after. */
export function takePromptSeed(key: number): boolean {
  if (taken.has(key)) return false;
  taken.add(key);
  return true;
}

/** The host's half: hold at most one seed until the composer takes it. */
export function usePromptSeed() {
  const [seed, setSeed] = useState<PromptSeed | null>(null);
  const send = useCallback((text: string) => {
    setSeed({ key: nextPromptSeedKey(), text, send: true });
  }, []);
  const consume = useCallback((key: number) => {
    setSeed((current) => (current?.key === key ? null : current));
  }, []);
  const clear = useCallback(() => setSeed(null), []);
  return { seed, send, consume, clear };
}
