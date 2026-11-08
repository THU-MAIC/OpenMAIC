/**
 * The preview tab's closed intent.
 *
 * Closing the preview tab is about ONE request: the run goes on in the
 * conversation, and the tab must not come back for it — not on the next
 * event, not after a refresh. The next request of the same conversation opens
 * it again. So the intent is remembered per conversation as the key of the
 * request it was closed for. Browser memory, like the course tab set; an
 * unreadable store only costs the intent.
 */

export const CLOSED_PREVIEW_STORAGE_KEY = 'openmaic:workspace:closed-preview';
const MAX_REMEMBERED = 50;

type ClosedPreviews = Record<string, string>;

function readAll(): ClosedPreviews {
  try {
    const raw = localStorage.getItem(CLOSED_PREVIEW_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

/** The request of this conversation the preview tab was last closed for, if any. */
export function closedPreviewRequest(sessionId: string | null): string | null {
  if (!sessionId) return null;
  return readAll()[sessionId] ?? null;
}

/** Whether the preview tab was closed for this request of this conversation. */
export function isPreviewClosed(sessionId: string | null, requestKey: string): boolean {
  if (!sessionId) return false;
  return readAll()[sessionId] === requestKey;
}

/** Remember that the user closed the preview tab for this request. */
export function rememberPreviewClosed(sessionId: string | null, requestKey: string): void {
  if (!sessionId) return;
  const all = readAll();
  delete all[sessionId];
  const entries = [...Object.entries(all), [sessionId, requestKey] as const].slice(-MAX_REMEMBERED);
  try {
    localStorage.setItem(CLOSED_PREVIEW_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage can be denied; the tab then only stays closed for this visit.
  }
}
