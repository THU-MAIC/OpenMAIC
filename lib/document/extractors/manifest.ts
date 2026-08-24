/**
 * Browser-safe extractor manifest (RFC #1153 part 1).
 *
 * Every document and media extractor's METADATA as plain data only. The two
 * client pages (`app/page.tsx`, `app/generation-preview/page.tsx`) need the
 * expected-extractor identity and version for the derivation cache
 * (`resolveExpectedExtractor` / `extractorVersionFor` in
 * `lib/document/extraction-cache.ts`) — they must NOT drag the provider
 * IMPLEMENTATIONS (and their server-only dependency chains: `sharp`,
 * `@alicloud/*`, `child_process`, `fs`, `net`) into the client bundle.
 *
 * The provider implementation modules (`text.ts`, `pdf.ts`, `media.ts`) spread
 * their own entry from this manifest (`...entry, extract: ...`), so the
 * metadata the client reads is the SAME metadata the server registry serves —
 * one authoritative definition, and drift is impossible by construction. The
 * sync test in `tests/document/extractor-registry.test.ts` still pins both
 * directions: every registered provider has an exact manifest entry and the
 * manifest declares no orphan entries.
 *
 * BROWSER-SAFE BY CONSTRUCTION: imports only plain-data/type modules
 * (`../mime`, `../types`). No imports from provider implementation files, no
 * Node-only imports, no transitive heaviness — `tests/document/extractor-manifest.test.ts`
 * guards this contract against future edits.
 */
import {
  ALIDOCMIND_MEDIA_MIMES,
  ALIDOCMIND_MIMES,
  DOCUMENT_MIME_TYPES,
  MINERU_CLOUD_MIMES,
  MINERU_SELFHOST_MIMES,
  PLAIN_TEXT_MIMES,
} from '../mime';
import type { DocumentExtractorCapabilities, MediaExtractorCapabilities } from '../types';

/** One document extractor's metadata, exactly as the server registry serves it. */
export interface DocumentExtractorManifestEntry {
  id: string;
  displayName: string;
  version: string;
  supportedMimeTypes: readonly string[];
  capabilities: DocumentExtractorCapabilities;
}

/** One media extractor's metadata, exactly as the server registry serves it. */
export interface MediaExtractorManifestEntry {
  id: string;
  displayName: string;
  version: string;
  supportedMimeTypes: readonly string[];
  capabilities: MediaExtractorCapabilities;
}

/**
 * Document extractor metadata. Insertion order IS the auto-selection order and
 * must stay identical to the registry's provider order (`text.ts` first, then
 * `pdf.ts` in `PDF_PROVIDERS` key order) so client-side expected-extractor
 * resolution picks the same provider the server would.
 */
const DOCUMENT_EXTRACTOR_MANIFEST: Record<string, DocumentExtractorManifestEntry> = {
  'plain-text': {
    id: 'plain-text',
    displayName: 'Plain Text',
    version: '1',
    supportedMimeTypes: PLAIN_TEXT_MIMES,
    capabilities: {
      text: true,
      images: false,
      tables: false,
      formulas: false,
      layout: false,
      ocr: false,
      async: false,
    },
  },
  unpdf: {
    id: 'unpdf',
    displayName: 'unpdf',
    version: '1',
    supportedMimeTypes: [DOCUMENT_MIME_TYPES.pdf],
    capabilities: {
      text: true,
      images: true,
      tables: false,
      formulas: false,
      layout: false,
      ocr: false,
      async: false,
    },
  },
  mineru: {
    id: 'mineru',
    displayName: 'MinerU',
    version: '1',
    supportedMimeTypes: MINERU_SELFHOST_MIMES,
    capabilities: {
      text: true,
      images: true,
      tables: true,
      formulas: true,
      layout: true,
      ocr: true,
      async: false,
    },
  },
  'mineru-cloud': {
    id: 'mineru-cloud',
    displayName: 'MinerU (Cloud)',
    version: '1',
    supportedMimeTypes: MINERU_CLOUD_MIMES,
    capabilities: {
      text: true,
      images: true,
      tables: true,
      formulas: true,
      layout: true,
      ocr: true,
      async: true,
    },
  },
  alidocmind: {
    id: 'alidocmind',
    displayName: 'AliDocMind',
    version: '1',
    supportedMimeTypes: ALIDOCMIND_MIMES,
    capabilities: {
      text: true,
      images: true,
      tables: true,
      formulas: true,
      layout: true,
      ocr: true,
      async: true,
    },
  },
};

/** Media extractor metadata (audio/video path). */
const MEDIA_EXTRACTOR_MANIFEST: Record<string, MediaExtractorManifestEntry> = {
  alidocmind: {
    id: 'alidocmind',
    displayName: 'AliDocMind',
    version: '1',
    supportedMimeTypes: ALIDOCMIND_MEDIA_MIMES,
    capabilities: {
      transcript: true,
      keyframes: true,
      synopsis: true,
      ocr: true,
      async: true,
    },
  },
};

export function getDocumentExtractorManifestEntries(): DocumentExtractorManifestEntry[] {
  return Object.values(DOCUMENT_EXTRACTOR_MANIFEST);
}

export function getDocumentExtractorManifestEntry(
  providerId: string,
): DocumentExtractorManifestEntry | undefined {
  return DOCUMENT_EXTRACTOR_MANIFEST[providerId];
}

export function getMediaExtractorManifestEntries(): MediaExtractorManifestEntry[] {
  return Object.values(MEDIA_EXTRACTOR_MANIFEST);
}

export function getMediaExtractorManifestEntry(
  providerId: string,
): MediaExtractorManifestEntry | undefined {
  return MEDIA_EXTRACTOR_MANIFEST[providerId];
}

/**
 * Client-safe mirror of `selectDocumentExtractorProvider` in
 * `lib/document/extractors/registry.ts`, operating on manifest entries only so
 * the derivation cache can resolve the expected extractor without importing
 * the provider implementations. Behavior is pinned identical to the registry's
 * selection by the sync test in `tests/document/extractor-registry.test.ts`.
 */
export function selectDocumentExtractorManifestEntry(options: {
  mimeType: string;
  preferredProviderId?: string;
  requiredCapabilities?: Partial<DocumentExtractorCapabilities>;
}): DocumentExtractorManifestEntry {
  const normalizedMimeType = options.mimeType.toLowerCase();
  const supportsRequest = (entry: DocumentExtractorManifestEntry) =>
    entry.supportedMimeTypes.includes(normalizedMimeType) &&
    Object.entries(options.requiredCapabilities ?? {}).every(
      ([capability, required]) =>
        !required || entry.capabilities[capability as keyof DocumentExtractorCapabilities],
    );

  if (options.preferredProviderId) {
    const preferred = getDocumentExtractorManifestEntry(options.preferredProviderId);
    if (!preferred) {
      throw new Error(`Unknown document extractor provider: ${options.preferredProviderId}`);
    }
    if (!supportsRequest(preferred)) {
      throw new Error(
        `Document extractor "${preferred.id}" does not support MIME type "${options.mimeType}" with the requested capabilities`,
      );
    }
    return preferred;
  }

  const entry = getDocumentExtractorManifestEntries().find(supportsRequest);
  if (!entry) {
    throw new Error(
      `No document extractor supports MIME type "${options.mimeType}" with the requested capabilities`,
    );
  }
  return entry;
}

/**
 * Client-safe mirror of `selectMediaExtractorProvider` in
 * `lib/document/extractors/media-registry.ts` (see
 * `selectDocumentExtractorManifestEntry` for why this exists).
 */
export function selectMediaExtractorManifestEntry(options: {
  mimeType: string;
  preferredProviderId?: string;
  requiredCapabilities?: Partial<MediaExtractorCapabilities>;
}): MediaExtractorManifestEntry {
  const normalizedMimeType = options.mimeType.toLowerCase();
  const supportsRequest = (entry: MediaExtractorManifestEntry) =>
    entry.supportedMimeTypes.includes(normalizedMimeType) &&
    Object.entries(options.requiredCapabilities ?? {}).every(
      ([capability, required]) =>
        !required || entry.capabilities[capability as keyof MediaExtractorCapabilities],
    );

  if (options.preferredProviderId) {
    const preferred = getMediaExtractorManifestEntry(options.preferredProviderId);
    if (!preferred) {
      throw new Error(`Unknown media extractor provider: ${options.preferredProviderId}`);
    }
    if (!supportsRequest(preferred)) {
      throw new Error(
        `Media extractor "${preferred.id}" does not support MIME type "${options.mimeType}" with the requested capabilities`,
      );
    }
    return preferred;
  }

  const entry = getMediaExtractorManifestEntries().find(supportsRequest);
  if (!entry) {
    throw new Error(
      `No media extractor supports MIME type "${options.mimeType}" with the requested capabilities`,
    );
  }
  return entry;
}
