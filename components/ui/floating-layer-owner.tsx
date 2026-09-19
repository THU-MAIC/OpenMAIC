'use client';

import { createContext, useContext, type ReactNode } from 'react';

export const FLOATING_LAYER_OWNER_ATTRIBUTE = 'data-floating-layer-owner';

const FloatingLayerOwnerContext = createContext<string | null>(null);

/**
 * Associates portalled UI opened by a floating surface with that surface.
 * React context crosses portals even though DOM containment does not.
 */
export function FloatingLayerOwner({
  ownerId,
  children,
}: {
  readonly ownerId: string;
  readonly children?: ReactNode;
}) {
  return (
    <FloatingLayerOwnerContext.Provider value={ownerId}>
      {children}
    </FloatingLayerOwnerContext.Provider>
  );
}

/** Props for the concrete DOM node rendered inside a UI portal. */
export function useFloatingLayerOwnerProps(): Record<string, string> {
  const ownerId = useContext(FloatingLayerOwnerContext);
  return ownerId ? { [FLOATING_LAYER_OWNER_ATTRIBUTE]: ownerId } : {};
}

type EventWithPath = Pick<Event, 'composedPath' | 'target'>;

type ContainmentRoot = {
  contains(node: Node | null): boolean;
};

type FloatingLayerDismissOptions = {
  readonly ownerId: string;
  readonly roots: () => readonly (ContainmentRoot | null)[];
  readonly onDismiss: (refocus: boolean) => void;
};

/**
 * DOM containment plus logical containment for descendants rendered in a
 * portal. Capture-phase outside listeners cannot rely on React propagation.
 */
export function isEventInsideFloatingLayer(
  event: EventWithPath,
  ownerId: string,
  roots: readonly (ContainmentRoot | null)[],
): boolean {
  const target = event.target;
  if (target instanceof Node && roots.some((root) => root?.contains(target))) return true;

  return event.composedPath().some((node) => {
    if (!node || typeof node !== 'object' || !('getAttribute' in node)) return false;
    const getAttribute = (node as { getAttribute?: unknown }).getAttribute;
    return (
      typeof getAttribute === 'function' &&
      getAttribute.call(node, FLOATING_LAYER_OWNER_ATTRIBUTE) === ownerId
    );
  });
}

/**
 * Installs the window-level dismissal behavior shared by floating surfaces.
 * Child Radix layers prevent their handled Escape event, so the owning
 * surface stays open until a later Escape reaches it unhandled.
 */
export function installFloatingLayerDismissListeners({
  ownerId,
  roots,
  onDismiss,
}: FloatingLayerDismissOptions): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) onDismiss(true);
  };
  const dismissUnlessInside = (event: Event) => {
    if (!isEventInsideFloatingLayer(event, ownerId, roots())) onDismiss(false);
  };
  const onResize = () => onDismiss(false);

  // Keep this in bubble phase: Radix child layers handle Escape during
  // document capture and mark it prevented before it reaches this listener.
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('pointerdown', dismissUnlessInside, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', dismissUnlessInside, true);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('pointerdown', dismissUnlessInside, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', dismissUnlessInside, true);
  };
}
