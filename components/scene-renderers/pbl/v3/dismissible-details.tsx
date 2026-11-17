'use client';

import { useEffect, useRef, type ComponentProps } from 'react';

/** Transient workbench disclosures; in-flow content and file folders stay open. */
export function DismissibleDetails(props: ComponentProps<'details'>) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const details = ref.current;
    if (!details) return;
    const outside = (event: Event) => {
      if (details.open && !details.contains(event.target as Node)) details.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (details.open && event.key === 'Escape') {
        event.stopPropagation();
        details.open = false;
        details.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    // Safari may open a summary by mouse without moving keyboard focus into it.
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, []);
  return <details {...props} ref={ref} />;
}
