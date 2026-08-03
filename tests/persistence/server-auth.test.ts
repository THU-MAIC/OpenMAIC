import type { IncomingMessage } from 'node:http';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticatePersistenceRequest } from '@/lib/persistence/server-auth';

function request(headers: IncomingMessage['headers']): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe('embedded persistence development authentication', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'shared-secret');
  });

  it('accepts the configured bearer token and learner partition', async () => {
    await expect(
      authenticatePersistenceRequest(
        request({
          authorization: 'Bearer shared-secret',
          'x-learner-key': 'anon:learner-1',
        }),
      ),
    ).resolves.toEqual({ learnerKey: 'anon:learner-1' });
  });

  it('rejects missing and incorrect bearer tokens', async () => {
    await expect(authenticatePersistenceRequest(request({}))).resolves.toBeUndefined();
    await expect(
      authenticatePersistenceRequest(request({ authorization: 'Bearer shared-secreu' })),
    ).resolves.toBeUndefined();
  });
});
