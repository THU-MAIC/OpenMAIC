import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { GET as getCapabilities } from '@/app/api/generate-classroom/capabilities/route';
import { GET as getHealth } from '@/app/api/health/route';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import { WORKBENCH_MATERIAL_MIME_TYPES } from '@/lib/workbench/material-upload-policy';
import { middleware } from '@/middleware';

vi.mock('@/lib/server/provider-config', () => ({
  getServerWebSearchProviders: () => ({ tavily: { disabled: false } }),
  getServerImageProviders: () => ({ image: { disabled: true } }),
  getServerVideoProviders: () => ({}),
  getServerTTSProviders: () => ({ tts: { disabled: false } }),
}));

afterEach(() => vi.unstubAllEnvs());

describe('GET /api/generate-classroom/capabilities', () => {
  it('reports the server capabilities and the material upload policy', async () => {
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
        maxDocumentBytes: Math.min(
          agentRuntimeConfig.maxDocumentBytes,
          agentRuntimeConfig.maxUploadBytes,
        ),
        maxMediaBytes: agentRuntimeConfig.maxUploadBytes,
      },
    });
    // The advertised formats are the upload gate's own whitelist.
    expect(body.materials.formats.map((format: { mime: string }) => format.mime)).toEqual(
      WORKBENCH_MATERIAL_MIME_TYPES,
    );
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
