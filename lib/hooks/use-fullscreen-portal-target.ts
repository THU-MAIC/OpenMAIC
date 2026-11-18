'use client';

import { useEffect, useState } from 'react';

export function observeFullscreenPortalTarget(onTarget: (target: Element) => void) {
  const sync = () => onTarget(document.fullscreenElement ?? document.body);
  sync();
  document.addEventListener('fullscreenchange', sync);
  return () => document.removeEventListener('fullscreenchange', sync);
}

export function useFullscreenPortalTarget() {
  const [target, setTarget] = useState<Element | null>(null);

  useEffect(() => observeFullscreenPortalTarget(setTarget), []);

  return target;
}
