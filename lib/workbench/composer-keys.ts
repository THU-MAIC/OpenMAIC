/**
 * The composer's Enter policy, as one rule the three composers share.
 *
 * Enter sends — the convention every chat surface already trained the hand for.
 * Shift+Enter is the newline. ⌘+Enter and Ctrl+Enter send too: they cost
 * nothing, they are what a hand arriving from an editor reaches for, and
 * accepting both means the app never has to announce which one it chose (no OS
 * sniffing, nothing platform-specific to survive server rendering).
 *
 * The reason this lives in one testable rule rather than inline in three
 * textareas is the IME: getting Enter right for Chinese/Japanese/Korean input
 * is the whole difficulty of the policy, and it must not be re-derived per
 * composer.
 *
 */

/**
 * The fields of a React keyboard event this rule reads. Typed structurally so a
 * `React.KeyboardEvent<HTMLTextAreaElement>` can be passed straight in, while a
 * test can pass a plain object.
 */
export interface ComposerKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly nativeEvent: {
    /** True for every keydown that belongs to an IME composition. */
    readonly isComposing?: boolean;
    /**
     * The legacy IME tell: 229 means "the IME is swallowing this key". Kept as
     * a second line of defence for engines that fire the composition-ending
     * Enter with `isComposing` already false.
     */
    readonly keyCode?: number;
  };
}

/**
 * Whether this keydown should send.
 *
 * The two IME guards are the load-bearing part. A Chinese/Japanese/Korean
 * composition ENDS with Enter, and that Enter must commit the candidate, never
 * post the message — so `isComposing` is checked, and keyCode 229 is checked
 * behind it for engines that fire the composition-ending Enter with
 * `isComposing` already false. Both run before anything else, so no modifier
 * combination can send mid-composition either.
 */
export function shouldSendComposerKey(event: ComposerKeyEvent): boolean {
  if (event.key !== 'Enter') return false;
  if (event.nativeEvent.isComposing) return false;
  if (event.nativeEvent.keyCode === 229) return false;
  // The one deliberate escape: Shift+Enter is the newline, modifier held or not.
  if (event.shiftKey) return false;
  return true;
}

/**
 * The send key for `aria-keyshortcuts`, whose grammar is a space-separated list
 * of `+`-joined key names (WAI-ARIA 1.2). Only the primary key is announced —
 * the modifier variants are conveniences, and reading three shortcuts out for
 * one action is noise.
 */
export const COMPOSER_SEND_ARIA_KEYSHORTCUTS = 'Enter';
