import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';

import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';

// Under `allowUserKeys: false` users choose only among the deployment's
// providers: the forms of the provider helper routes that carry a caller's
// own key or endpoint are refused, as the verify routes refuse theirs.
const ROUTES = {
  'verify-pdf-provider': async () => (await import('@/app/api/verify-pdf-provider/route')).POST,
  'probe-models': async () => (await import('@/app/api/provider/probe-models/route')).POST,
  'azure-voices': async () => (await import('@/app/api/azure-voices/route')).POST,
} as const;

/** A raw form with nothing usable in it: refused by the gate, else by the route's own checks. */
const RAW_BODY = { 'verify-pdf-provider': {}, 'probe-models': {}, 'azure-voices': {} } as const;

function post(body: unknown) {
  return new NextRequest('http://localhost/api/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deployment(allowUserKeys: boolean | undefined) {
  setDeploymentConfigForTests({
    layer: {
      source: 'deployment',
      config: allowUserKeys === undefined ? {} : { allowUserKeys },
    },
    legacy: false,
    notices: [],
  });
}

afterEach(() => setDeploymentConfigForTests());

describe('raw key forms of the provider helper routes', () => {
  it.each(Object.keys(ROUTES) as (keyof typeof ROUTES)[])(
    '%s refuses a caller key under allowUserKeys: false',
    async (name) => {
      deployment(false);
      const response = await (await ROUTES[name]())(post(RAW_BODY[name]));
      expect(response.status).toBe(403);
      expect((await response.json()).errorCode).toBe('PROVIDER_DISABLED');
    },
  );

  it.each(Object.keys(ROUTES) as (keyof typeof ROUTES)[])(
    '%s takes it to its own checks while user keys are allowed',
    async (name) => {
      deployment(undefined);
      const response = await (await ROUTES[name]())(post(RAW_BODY[name]));
      expect(response.status).toBe(400);
    },
  );
});
