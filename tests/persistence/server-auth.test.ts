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
    ).resolves.toEqual({ key: 'shared', learnerKey: 'anon:learner-1' });
  });

  it('shares one asset principal across learner keys, like the global documents', async () => {
    const first = await authenticatePersistenceRequest(
      request({ authorization: 'Bearer shared-secret', 'x-learner-key': 'anon:a' }),
    );
    const second = await authenticatePersistenceRequest(
      request({ authorization: 'Bearer shared-secret', 'x-learner-key': 'anon:b' }),
    );
    expect(first?.key).toBe('shared');
    expect(second?.key).toBe('shared');
    expect(first?.learnerKey).not.toBe(second?.learnerKey);
  });

  it('issues the shared asset principal even without a learner key', async () => {
    await expect(
      authenticatePersistenceRequest(request({ authorization: 'Bearer shared-secret' })),
    ).resolves.toEqual({ key: 'shared' });
  });

  it('rejects missing and incorrect bearer tokens', async () => {
    await expect(authenticatePersistenceRequest(request({}))).resolves.toBeUndefined();
    await expect(
      authenticatePersistenceRequest(request({ authorization: 'Bearer shared-secreu' })),
    ).resolves.toBeUndefined();
  });
});

describe('embedded persistence development authentication — production gate', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'shared-secret');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PERSISTENCE_ALLOW_INSECURE_DEV_AUTH', '');
  });

  it('refuses the development authenticator in production without the explicit opt-in', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(
      authenticatePersistenceRequest(
        request({ authorization: 'Bearer shared-secret', 'x-learner-key': 'anon:learner-1' }),
      ),
    ).resolves.toBeUndefined();
  });

  it('serves in production when the insecure-opt-in is explicitly set', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PERSISTENCE_ALLOW_INSECURE_DEV_AUTH', 'true');
    await expect(
      authenticatePersistenceRequest(
        request({ authorization: 'Bearer shared-secret', 'x-learner-key': 'anon:learner-1' }),
      ),
    ).resolves.toEqual({ key: 'shared', learnerKey: 'anon:learner-1' });
  });

  it('keeps unchanged behaviour outside production regardless of the opt-in flag', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PERSISTENCE_ALLOW_INSECURE_DEV_AUTH', 'true');
    await expect(
      authenticatePersistenceRequest(
        request({ authorization: 'Bearer shared-secret', 'x-learner-key': 'anon:dev-1' }),
      ),
    ).resolves.toEqual({ key: 'shared', learnerKey: 'anon:dev-1' });

    vi.stubEnv('PERSISTENCE_ALLOW_INSECURE_DEV_AUTH', '');
    await expect(
      authenticatePersistenceRequest(
        request({ authorization: 'Bearer shared-secret', 'x-learner-key': 'anon:dev-2' }),
      ),
    ).resolves.toEqual({ key: 'shared', learnerKey: 'anon:dev-2' });
  });
});
