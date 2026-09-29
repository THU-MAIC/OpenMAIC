import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { GET as getCapabilities } from '@/app/api/generate-classroom/capabilities/route';
import { GET as getHealth } from '@/app/api/health/route';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import { WORKBENCH_MATERIAL_MIME_TYPES } from '@/lib/workbench/material-upload-policy';
import { middleware } from '@/middleware';

const config = vi.hoisted(() => ({ pdf: {} as Record<string, object> }));

vi.mock('@/lib/server/provider-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/provider-config')>()),
  getServerWebSearchProviders: () => ({ tavily: { disabled: false } }),
  getServerImageProviders: () => ({ image: { disabled: true } }),
  getServerVideoProviders: () => ({}),
  getServerTTSProviders: () => ({ tts: { disabled: false } }),
  getServerPDFProviders: () => config.pdf,
  resolveServerMediaExtractorConfig: () => ({ providerId: '', allowEnvFallback: false }),
  resolveServerASRProviderId: () => undefined,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  config.pdf = {};
});

const mimesOf = (formats: Array<{ mime: string }>) => formats.map((format) => format.mime);

describe('GET /api/generate-classroom/capabilities', () => {
  it('reports the server capabilities and the extractable upload formats', async () => {
    const response = await getCapabilities();
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual({
      success: true,
      capabilities: {
        webSearch: true,
        imageGeneration: false,
        videoGeneration: false,
        tts: true,
      },
      materials: {
        formats: expect.any(Array),
        maxCount: 5,
        maxTotalBytes: 150 * 1024 * 1024,
        maxDocumentBytes: Math.min(
          agentRuntimeConfig.maxDocumentBytes,
          agentRuntimeConfig.maxUploadBytes,
        ),
        maxMediaBytes: agentRuntimeConfig.maxUploadBytes,
      },
    });
    // No extraction service configured (and no ASR for local media): only the
    // self-contained extractors' formats are advertised.
    expect(mimesOf(body.materials.formats)).toEqual([
      'application/pdf',
      'text/plain',
      'text/markdown',
    ]);
    expect(body.materials.formats).toContainEqual({
      id: 'pdf',
      mime: 'application/pdf',
      extensions: ['.pdf'],
    });
    expect(body.materials.formats).toContainEqual({
      id: 'markdown',
      mime: 'text/markdown',
      extensions: ['.md', '.markdown'],
    });
  });

  it('adds the formats of a configured extraction service, within the upload whitelist', async () => {
    config.pdf = { 'mineru-cloud': {} };
    const body = await (await getCapabilities()).json();
    const mimes = mimesOf(body.materials.formats);
    expect(mimes).toEqual(
      expect.arrayContaining([
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'image/png',
      ]),
    );
    for (const mime of mimes) expect(WORKBENCH_MATERIAL_MIME_TYPES).toContain(mime);
  });

  it('reports the same capabilities as /api/health', async () => {
    const [capabilities, health] = await Promise.all([
      getCapabilities().then((response) => response.json()),
      getHealth().then((response) => response.json()),
    ]);
    expect(capabilities.capabilities).toEqual(health.capabilities);
  });

  it('sits behind the access-code gate', async () => {
    vi.stubEnv('ACCESS_CODE', 'capabilities-test-secret');
    const gated = await middleware(
      new NextRequest('http://localhost/api/generate-classroom/capabilities'),
    );
    expect(gated.status).toBe(401);
  });
});
