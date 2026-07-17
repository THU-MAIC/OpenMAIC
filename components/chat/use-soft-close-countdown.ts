'use client';

import { useEffect, useState } from 'react';

export function getSoftCloseRemainingSeconds(
  deadline: number | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!deadline) return undefined;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function useSoftCloseCountdown(deadline?: number): number | undefined {
  const [remaining, setRemaining] = useState<number | undefined>();

  useEffect(() => {
    const update = () => setRemaining(getSoftCloseRemainingSeconds(deadline));
    update();
    if (!deadline) return;
    const ticker = setInterval(update, 1000);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(ticker);
      document.removeEventListener('visibilitychange', update);
    };
  }, [deadline]);

  return remaining;
}
