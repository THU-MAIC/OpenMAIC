import { describe, expect, it, vi } from 'vitest';

import type { DocumentExtractorProvider, MediaExtractorProvider } from '@/lib/document';

vi.mock('@/lib/server/provider-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/provider-config')>()),
  resolveServerMediaExtractorConfig: () => ({ providerId: '', allowEnvFallback: false }),
}));

import { resolveExtractableMimeTypes } from '@/lib/server/material-extraction/availability';

function documentProvider(
  id: string,
  supportedMimeTypes: string[],
  requiresServiceConfig: boolean,
): DocumentExtractorProvider {
  return {
    id,
    displayName: id,
    version: '1',
    supportedMimeTypes,
    requiresServiceConfig,
    capabilities: {
      text: true,
      images: false,
      tables: false,
      formulas: false,
      layout: false,
      ocr: false,
      async: false,
    },
    extract: vi.fn(),
  };
}

function mediaProvider(id: string, supportedMimeTypes: string[], available: boolean) {
  return {
    id,
    displayName: id,
    version: '1',
    supportedMimeTypes,
    capabilities: { transcript: true, keyframes: false, synopsis: false, ocr: false, async: false },
    availability: vi.fn(async () => ({ available })),
    extract: vi.fn(),
  } as MediaExtractorProvider;
}

describe('resolveExtractableMimeTypes', () => {
  it('counts self-contained and configured document extractors and available media extractors', async () => {
    const mimes = await resolveExtractableMimeTypes({
      providers: () => [
        documentProvider('local', ['application/pdf'], false),
        documentProvider('service-on', ['Application/Vnd.Docx'], true),
        documentProvider('service-off', ['image/png'], true),
      ],
      configuredProviderIds: () => ['service-on'],
      mediaProviders: () => [
        mediaProvider('media-on', ['audio/mpeg'], true),
        mediaProvider('media-off', ['video/mp4'], false),
      ],
    });

    expect([...mimes].sort()).toEqual(['application/pdf', 'application/vnd.docx', 'audio/mpeg']);
  });

  it('counts audio for an ASR-backed media extractor only when a server ASR provider exists', async () => {
    const local = {
      ...mediaProvider('local', ['video/mp4', 'audio/mpeg'], true),
      requiresServerASR: true,
    };
    const run = (serverASRConfigured: boolean) =>
      resolveExtractableMimeTypes({
        providers: () => [],
        configuredProviderIds: () => [],
        mediaProviders: () => [local],
        serverASRConfigured: () => serverASRConfigured,
      });

    expect([...(await run(false))]).toEqual(['video/mp4']);
    expect([...(await run(true))].sort()).toEqual(['audio/mpeg', 'video/mp4']);
  });
});
