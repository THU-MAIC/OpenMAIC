/**
 * The mask a settings view shows for a stored key (RFC #1701): its last four
 * characters, or nothing for a key too short to show any of it.
 *
 * Shared by the server (the view) and the browser (telling whether a key kept
 * in the browser was entered again).
 */
export const UNINFORMATIVE_KEY_MASK = '…';

export function maskKey(key: string): string {
  return key.length >= 12 ? `…${key.slice(-4)}` : UNINFORMATIVE_KEY_MASK;
}
