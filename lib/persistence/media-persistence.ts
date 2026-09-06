/**
 * Is generated media durable beyond the browser that produced it?
 *
 * Browser-only mode keeps document and media in one lifetime: the document
 * holds `gen_img_*` / `gen_vid_*` placeholders and the bytes sit in this
 * browser's local tables. Nothing outside this browser ever reads either, so
 * the placeholder is a complete address.
 *
 * Server-backed persistence breaks that pairing. The document is durable and
 * shared while the bytes are not, so a placeholder is an address only the
 * producing browser can follow: every other browser sees an unresolved
 * reference and regenerates it, and never converges because the generated
 * address is never written back. Under this mode the generation chain
 * therefore stores bytes in the asset pool and writes the allocated id into
 * the document.
 *
 * The answer is the asset-pool seam's own ownership scope rather than a second
 * reading of the environment: the bootstrap configures document, runtime and
 * asset seams together, so `serverBacked` is true exactly when the document
 * store is the HTTP one. Importing the bootstrap here is what guarantees the
 * seam is configured before the question is asked — reading the mode seals the
 * configuration, so an unconfigured read would permanently answer "no".
 */
import '@/lib/persistence/bootstrap';

import { isAssetPoolServerBacked } from '@/lib/media/asset-pool-config';

export function isServerBackedMediaPersistence(): boolean {
  return isAssetPoolServerBacked();
}
