/** Shared contract for frozen interactive HTML in video export. */

/** Maximum wall-clock wait for one packaged iframe to load and freeze. */
export const INTERACTIVE_READY_TIMEOUT_MS = 8_000;

/** Quiet period after resources are ready, before timers/animations are frozen. */
export const INTERACTIVE_SETTLE_MS = 250;

/** postMessage discriminator shared by the packaged child page and parent composition. */
export const INTERACTIVE_STATIC_MESSAGE_FLAG = '__openmaicInteractiveStatic';

/** Stable preparation failures recorded by the browser-side adapter. */
export type InteractiveHtmlFailure =
  | 'missing-html'
  | 'packaging-failed'
  | 'unresolved-resource'
  | 'too-large';
