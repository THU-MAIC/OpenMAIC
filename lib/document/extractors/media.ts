import { parseMedia } from '@/lib/media-parse';
import { MEDIA_PARSE_PROVIDERS } from '@/lib/media-parse/constants';
import type { MediaParseProviderId } from '@/lib/media-parse/types';
import type { MediaExtractorInput, MediaExtractorProvider } from '../types';
import { getMediaExtractorManifestEntry, type MediaExtractorManifestEntry } from './manifest';

/** The manifest entry backing a media provider, or a loud failure at module init. */
function mediaManifestEntry(id: MediaParseProviderId): MediaExtractorManifestEntry {
  const entry = getMediaExtractorManifestEntry(id);
  if (!entry) {
    throw new Error(`No media extractor manifest entry for provider "${id}"`);
  }
  return entry;
}

function createMediaBackedExtractor(id: MediaParseProviderId): MediaExtractorProvider {
  return {
    // Metadata comes from the browser-safe manifest — single source of truth
    // for the extractor identity (RFC #1153 part 1); the implementation is
    // attached here. `mediaManifestEntry` throws at module init if a
    // MEDIA_PARSE_PROVIDERS entry ever lacks a manifest entry, and the
    // registry sync test pins the reverse direction (no orphan entries).
    ...mediaManifestEntry(id),
    async extract(input: MediaExtractorInput) {
      return parseMedia({
        buffer: input.buffer,
        fileName: input.fileName ?? 'media',
        mimeType: input.mimeType,
        config: {
          providerId: id,
          apiKey: input.config.apiKey,
          baseUrl: input.config.baseUrl,
          accessKeyId: input.config.accessKeyId,
          accessKeySecret: input.config.accessKeySecret,
          allowEnvFallback: input.config.allowEnvFallback,
        },
      });
    },
  };
}

export const mediaBackedExtractorProviders: MediaExtractorProvider[] = Object.keys(
  MEDIA_PARSE_PROVIDERS,
).map((id) => createMediaBackedExtractor(id as MediaParseProviderId));
