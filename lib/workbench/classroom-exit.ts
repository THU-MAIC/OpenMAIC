export type ClassroomExitDecision =
  | { readonly kind: 'push'; readonly href: '/workspace' | '/' }
  | { readonly kind: 'back' };

interface ClassroomExitContext {
  readonly searchParams: Pick<URLSearchParams, 'get'>;
  readonly historyLength: number;
}

interface ClassroomExitRouter {
  readonly push: (href: string) => void;
  readonly back: () => void;
}

/**
 * Resolve where a standalone classroom should exit without depending on
 * browser globals, so direct links and SSR callers get the same safe default.
 */
export function resolveClassroomExit({
  searchParams,
  historyLength,
}: ClassroomExitContext): ClassroomExitDecision {
  // An explicit source wins over history: classroom state changes may push
  // intermediate entries onto the stack, while `from` survives refreshes and
  // does not depend on browser-specific history behaviour.
  if (searchParams.get('from') === 'workspace') {
    return { kind: 'push', href: '/workspace' };
  }
  // Leaving Pro playback opens the ordinary classroom with an explicit home
  // return contract. Browser history still contains the Pro workspace, so the
  // generic `back()` fallback would otherwise contradict the home arrow.
  if (searchParams.get('returnTo') === 'home') {
    return { kind: 'push', href: '/' };
  }
  if (historyLength > 1) return { kind: 'back' };
  return { kind: 'push', href: '/' };
}

/** Resolve against the current browser, then perform the selected exit. */
export function exitClassroom(
  router: ClassroomExitRouter,
  searchParams: Pick<URLSearchParams, 'get'>,
): void {
  const historyLength = typeof window === 'undefined' ? 0 : window.history.length;
  const decision = resolveClassroomExit({ searchParams, historyLength });
  if (decision.kind === 'back') {
    router.back();
    return;
  }
  router.push(decision.href);
}

export function classroomExitLabelKey(
  searchParams: Pick<URLSearchParams, 'get'>,
): 'workbench.common.backToWorkspace' | 'generation.backToHome' {
  return searchParams.get('from') === 'workspace'
    ? 'workbench.common.backToWorkspace'
    : 'generation.backToHome';
}

export function classroomEntryHref(stageId: string, discoverOnly: boolean): string {
  const href = `/classroom/${stageId}`;
  return discoverOnly ? `${href}?from=workspace` : href;
}
