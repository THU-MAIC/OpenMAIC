/**
 * Limits of the local media extractor that the page also states. No runtime
 * dependency, so the extractor (`lib/document/extractors/local-media.ts`) and
 * the client read the same number.
 */

/** The longest audio or video the local extractor takes; longer is `media_too_long`. */
export const MEDIA_MAX_DURATION_SEC = 90 * 60;
