import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { GET } from '@/app/api/health/route';
import { middleware } from '@/middleware';

/** The deployment's slots behind the capabilities these tests expect. */
async function configureSlots(slots: Record<string, unknown>) {
  (await import('@/lib/server/model-config/runtime')).setDeploymentConfigForTests({
    layer: {
      source: 'deployment',
      config: {
        providers: {
          tv: { preset: 'tavily', apiKey: 'k' },
          mm: { preset: 'minimax-tts', apiKey: 'k' },
        },
        slots,
      } as never,
    },
    defaults: null,
    notices: [],
  });
}

afterEach(() => vi.unstubAllEnvs());

describe('health access-code configuration', () => {
  it.each([undefined, '', 'health-route-test-secret', ' '])(
    'reports runtime configuration without exposing ACCESS_CODE=%j',
    async (code) => {
      vi.stubEnv('ACCESS_CODE', code);
      await configureSlots({ tts: 'mm', image: null });

      // Health remains available to deployment probes without an access cookie.
      const gate = await middleware(new NextRequest('http://localhost/api/health'));
      expect(gate.status).toBe(200);

      const response = await GET();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        success: true,
        status: 'ok',
        version: expect.any(String),
        accessCodeConfigured: Boolean(code),
        capabilities: {
          webSearch: false,
          imageGeneration: false,
          videoGeneration: false,
          tts: true,
        },
      });
      expect(JSON.stringify(body)).not.toContain('health-route-test-secret');

      // The new diagnostic must not change the local-first default or gate.
      const api = await middleware(new NextRequest('http://localhost/api/foo'));
      expect(api.status).toBe(code ? 401 : 200);
    },
  );
});
