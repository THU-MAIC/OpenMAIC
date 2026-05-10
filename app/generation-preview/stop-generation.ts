/**
 * Stop-generation handler for the generation-preview page.
 *
 * Lives outside the page component so it can be unit-tested without
 * mounting React. The page passes its `abortControllerRef`, the
 * router, the i18n function, and a toast function; we wire the same
 * three side effects every press requires:
 *
 *   1. Abort the in-flight requests so we stop burning provider tokens.
 *   2. Tell the user we heard them (toast).
 *   3. Drop the saved session and route home — staying on this page
 *      with everything cancelled would be a confusing dead-end.
 */
export interface StopGenerationDeps {
  readonly abortControllerRef: { current: AbortController | null };
  readonly clearSession: () => void;
  readonly toast: (message: string) => void;
  readonly pushHome: () => void;
  readonly t: (key: string) => string;
}

export function runStopGeneration(deps: StopGenerationDeps): void {
  deps.abortControllerRef.current?.abort();
  deps.clearSession();
  deps.toast(deps.t('generation.stopGenerationToast'));
  deps.pushHome();
}
