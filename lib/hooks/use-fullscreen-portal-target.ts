'use client';

import { useEffect, useState } from 'react';

export function observeFullscreenPortalTarget(onTarget: (target: Element) => void) {
  const sync = () => onTarget(document.fullscreenElement ?? document.body);
  sync();
  document.addEventListener('fullscreenchange', sync);
  return () => document.removeEventListener('fullscreenchange', sync);
}

export function useFullscreenPortalTarget(container?: HTMLElement | null) {
  const [target, setTarget] = useState<Element | null>(null);

  useEffect(
    () =>
      observeFullscreenPortalTarget((target) => {
        setTarget(target === document.body && container !== undefined ? container : target);
      }),
    [container],
  );

  return target;
}
