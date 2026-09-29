/**
 * A workspace's media provider runs under the strict public policy even when
 * the operator opted into local networks for their own backends; the
 * deprecated per-request path keeps the operator's opt-in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mediaNetworkPolicy, mediaTransports } from '@/lib/server/media-provider-fetch';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';
import { closeLoopbackServers, startLoopback } from '@/tests/helpers/loopback-servers';

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeLoopbackServers();
  await destroyAudioProviderDispatchersForTests();
});

describe('media network policy', () => {
  it('names the policy of each connection', () => {
    expect(mediaNetworkPolicy({ managed: true, origin: 'configuration' })).toBe('managed');
    expect(mediaNetworkPolicy({ managed: false, origin: 'configuration' })).toBe('public');
    expect(mediaNetworkPolicy({ managed: false, origin: 'request' })).toBe('operator');
  });

  it('refuses a local endpoint for a workspace provider despite ALLOW_LOCAL_NETWORKS', async () => {
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    const server = await startLoopback((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const url = `http://127.0.0.1:${server.port}/v1/images`;

    const operator = mediaTransports('operator');
    expect((await operator.fetchImpl(url, { method: 'POST', body: '{}' })).status).toBe(200);

    const workspace = mediaTransports('public');
    await expect(workspace.fetchImpl(url, { method: 'POST', body: '{}' })).rejects.toThrow();
    await expect(workspace.downloadFetchImpl(url, {})).rejects.toThrow();
    expect(server.requests()).toBe(1);
  });
});
