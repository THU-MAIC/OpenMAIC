/**
 * Pure scene-routing rules of the standalone player: which scene a URL hash
 * names, and which navigation a key press means. Kept free of React and the
 * DOM so the rules are unit-testable.
 */

export type NavigationAction = 'previous' | 'next' | 'first' | 'last';

export function clampSceneIndex(index: number, count: number): number {
  if (count <= 0 || !Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), count - 1);
}

/** `#scene-3` names the third scene (1-based, matching the visible counter). */
export function sceneHash(index: number): string {
  return `#scene-${index + 1}`;
}

/** The scene index a location hash names, or `0` for anything unrecognized. */
export function sceneIndexFromHash(hash: string, count: number): number {
  const match = /^#scene-(\d+)$/.exec(hash);
  return match ? clampSceneIndex(Number(match[1]) - 1, count) : 0;
}

export function applyNavigation(index: number, action: NavigationAction, count: number): number {
  switch (action) {
    case 'previous':
      return clampSceneIndex(index - 1, count);
    case 'next':
      return clampSceneIndex(index + 1, count);
    case 'first':
      return 0;
    case 'last':
      return clampSceneIndex(count - 1, count);
  }
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * The navigation a key press asks for, or `null`. Keys typed into a form
 * field (a quiz answer) or with a modifier held are never navigation.
 */
export function navigationActionForKey(event: {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}): NavigationAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const target = event.target;
  if (target && (EDITABLE_TAGS.has(target.tagName ?? '') || target.isContentEditable)) return null;
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
      return 'previous';
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
      return 'next';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    default:
      return null;
  }
}
