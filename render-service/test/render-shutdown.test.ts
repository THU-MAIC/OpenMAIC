import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { expect, it, vi } from 'vitest';

async function freePort(): Promise<number> {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  const closed = once(probe, 'close');
  probe.close();
  await closed;
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
  return address.port;
}

it('sends the last reserved upload its rejection and cleans up before exiting on SIGTERM', async () => {
  const port = await freePort();
  const scratch = await mkdtemp(join(tmpdir(), 'render-shutdown-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      RENDER_SERVICE_NO_LISTEN: 'false',
      RENDER_RESOURCE_PROFILE: 'low-memory',
      RENDER_MAX_QUEUE: '1',
      PRODUCER_TMP_PROJECT_DIR: scratch,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });
  const uploadAbort = new AbortController();

  try {
    await vi.waitFor(() => expect(logs).toContain(`listening on :${port}`), { timeout: 90_000 });
    const healthUrl = `http://127.0.0.1:${port}/health`;
    const health = async () =>
      (await fetch(healthUrl, { signal: AbortSignal.timeout(1000) })).json();
    expect(await health()).toMatchObject({ accepting: true });

    const boundary = 'shutdown-test';
    const upload = request({
      host: '127.0.0.1',
      port,
      path: '/owner-bound/render',
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'x-openmaic-render-owner': 'owner-a',
        'x-openmaic-client': 'client-a',
      },
      signal: AbortSignal.any([uploadAbort.signal, AbortSignal.timeout(5000)]),
    });
    // Observe the full HTTP response, including its body, rather than measuring
    // when the app handler resolves or when headers first arrive.
    const reply = once(upload, 'response').then(async ([response]) => {
      let body = '';
      for await (const chunk of response) body += chunk.toString();
      return { status: response.statusCode, body: JSON.parse(body) };
    });
    void reply.catch(() => {});
    upload.write(
      `--${boundary}\r\nContent-Disposition: form-data; name="project"; filename="project.zip"\r\n` +
        'Content-Type: application/zip\r\n\r\n',
    );
    // Capacity is one, so this transition proves the unfinished upload has
    // acquired the sole reservation before the signal is sent.
    await vi.waitFor(async () => expect(await health()).toMatchObject({ accepting: false }));
    expect(await readdir(scratch)).toEqual([]);
    expect(child.kill('SIGTERM')).toBe(true);

    // Wait for the signal handler to close admission before completing the ZIP.
    // Before SIGTERM the same probe returns queue_full.
    await vi.waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/owner-bound/render`, {
        method: 'POST',
        headers: {
          'x-openmaic-render-owner': 'owner-a',
          'x-openmaic-client': 'client-a',
        },
        signal: AbortSignal.timeout(1000),
      });
      expect(await response.json()).toMatchObject({ reason: 'shutting_down' });
    });
    upload.write(zipSync({ 'index.html': strToU8('<!doctype html><p>Export</p>') }));
    upload.end(`\r\n--${boundary}--\r\n`);

    expect(await reply).toMatchObject({ status: 429, body: { reason: 'shutting_down' } });
    expect(await readdir(scratch)).toEqual([]);
    await vi.waitFor(() => expect(child.exitCode).toBe(0));
    expect(await exited).toEqual([0, null]);
  } finally {
    uploadAbort.abort();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(scratch, { recursive: true, force: true });
  }
}, 100_000);
