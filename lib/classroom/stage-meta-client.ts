/**
 * Client for `GET /api/stage-meta/:stageId` — the per-viewer facts a document
 * does not carry (the reference's `stage-meta-client.ts`, ported onto this
 * branch's classroom).
 *
 * The document seam is tenant-agnostic on purpose: it holds the stage, its
 * scenes and its outline, and says nothing about who is asking. The classroom
 * branches on exactly that — `isOwner` decides editable vs read-only — so the
 * content comes from the document seam and these come from here.
 */

/** What the sidecar had to say — as THREE outcomes, not two. */
export type StageMetaResult =
  | { outcome: 'found'; meta: StageMetaView }
  | { outcome: 'absent' }
  | { outcome: 'unavailable' };

export interface StageMetaView {
  isOwner: boolean;
  isPublic: boolean;
  publishedAt: number | null;
  generationComplete: boolean;
  /** Which layer answered. Diagnostic only — nothing may branch on it. */
  source?: string;
}

/**
 * Fetch a course's viewer-scoped metadata.
 *
 * Never throws: transport failure is reported as `'unavailable'` so callers
 * decide what a silent sidecar costs them, rather than losing the classroom to
 * an exception. `'absent'` is an ANSWER (the endpoint replied 404, which it
 * does for a course that does not exist and for a tombstoned one alike);
 * `'unavailable'` is the ABSENCE of an answer (a 5xx, a network error, a
 * timeout).
 */
export async function fetchStageMeta(
  stageId: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<StageMetaResult> {
  try {
    const response = await fetchImpl(`/api/stage-meta/${encodeURIComponent(stageId)}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) {
      if (response.status === 404) return { outcome: 'absent' };
      console.warn(`Stage meta fetch failed for ${stageId}: HTTP ${response.status}`);
      return { outcome: 'unavailable' };
    }
    const body = (await response.json()) as Partial<StageMetaView>;
    return {
      outcome: 'found',
      meta: {
        isOwner: body.isOwner === true,
        isPublic: body.isPublic === true,
        publishedAt: typeof body.publishedAt === 'number' ? body.publishedAt : null,
        generationComplete: body.generationComplete === true,
        ...(typeof body.source === 'string' ? { source: body.source } : {}),
      },
    };
  } catch (error) {
    // A 2xx whose body is not JSON lands here too, which is the right bucket:
    // the endpoint answered nothing this client can act on.
    console.warn(`Stage meta fetch failed for ${stageId}`, error);
    return { outcome: 'unavailable' };
  }
}
