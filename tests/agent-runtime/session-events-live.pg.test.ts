/**
 * Live session SSE tail — PG contract.
 *
 * The acceptance criterion for token-by-token streaming, against a REAL
 * PostgreSQL, REAL store, REAL bus, and the REAL `/api/agent/sessions/:id/events`
 * route: a durable `message_update` append (the delta cadence the runner
 * writes at ~150ms) must reach the browser frame WITHOUT waiting for the 5s
 * fallback poll — the LISTEN/NOTIFY wakeup delivers it in the
 * hundreds-of-ms range.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const contractUrl = process.env.PG_CONTRACT_URL;

function databaseUrl(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let seen = '';
  while (!seen.includes(marker)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${marker}; received ${seen}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out waiting for ${marker}`)), remaining);
        }),
      ]);
      if (chunk.done) throw new Error(`stream ended waiting for ${marker}`);
      seen += new TextDecoder().decode(chunk.value);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return seen;
}

describe.skipIf(!contractUrl)('live session SSE tail', () => {
  const url = contractUrl!;
  const CONTRACT_DB = `openmaic_live_sse_${process.pid}`;
  const ownerId = `anon:${randomUUID()}`;
  let pool: Pool;
  let stopBus: () => Promise<void>;
  let store: Awaited<
    ReturnType<typeof import('@/lib/server/agent-runtime/store').getAgentSessionStore>
  >;
  let sessionGet: typeof import('@/app/api/agent/sessions/[id]/events/route').GET;
  const sessionId = `session-${randomUUID()}`;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: url, max: 2 });
    await admin.query(`DROP DATABASE IF EXISTS ${CONTRACT_DB}`);
    await admin.query(`CREATE DATABASE ${CONTRACT_DB}`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl(url, CONTRACT_DB), max: 4 });
    // Everything downstream (the store adapter, the bus, the route) reads
    // DATABASE_URL and the runtime gate: point the whole stack at this test's
    // database.
    process.env.DATABASE_URL = databaseUrl(url, CONTRACT_DB);
    process.env.OPENMAIC_AGENT_RUNTIME_ENABLED = 'true';

    const { startAgentEventNotifyBus } =
      await import('@/lib/server/agent-runtime/event-notify-bus');
    const handle = startAgentEventNotifyBus();
    stopBus = () => handle.stop();
    await handle.connecting;

    const storeModule = await import('@/lib/server/agent-runtime/store');
    store = await storeModule.getAgentSessionStore();
    await store.createSession({
      id: sessionId,
      ownerId,
      prompt: 'Build a lesson',
      stageId: 'stage-1',
    });
    sessionGet = (await import('@/app/api/agent/sessions/[id]/events/route')).GET;
  }, 120_000);

  afterAll(async () => {
    await stopBus?.();
    delete process.env.DATABASE_URL;
    delete process.env.OPENMAIC_AGENT_RUNTIME_ENABLED;
    // Close every connection to the test database BEFORE dropping it: the
    // store adapter pool and the SSE stream both hold live connections, and
    // DROP ... WITH (FORCE) would terminate them mid-flight (unhandled
    // 57P01 noise otherwise).
    try {
      const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
      const provider = await getServerPersistenceProvider(databaseUrl(url, CONTRACT_DB));
      await provider.pool.end();
    } catch {
      // The provider may never have been initialized for this database.
    }
    await pool?.end();
    const admin = new Pool({ connectionString: url, max: 2 });
    await admin.query(`DROP DATABASE IF EXISTS ${CONTRACT_DB} WITH (FORCE)`);
    await admin.end();
  }, 60_000);

  it('forwards a message_update delta on the NOTIFY wakeup, not the 5s poll', async () => {
    const response = await sessionGet(
      new NextRequest(`http://localhost/api/agent/sessions/${sessionId}/events`, {
        headers: { 'last-event-id': '0', cookie: `anonymous_id=${ownerId.slice(5)}` },
      }),
      { params: Promise.resolve({ id: sessionId }) },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      await readUntil(reader, 'event: caught_up');

      // Append ONE message_update — the exact frame the runner emits per
      // throttled delta. The wakeup must surface it in the hundreds-of-ms
      // range; the readUntil timeout of 2s is far below the 5s fallback poll,
      // so a poll-only route would fail this assertion.
      await store.appendControlEvent(sessionId, {
        ts: Date.now(),
        type: 'message_update',
        data: { message: { role: 'assistant', content: [{ type: 'text', text: 'first delta' }] } },
      });
      const frame = await readUntil(reader, 'event: message_update');
      expect(frame).toContain('"type":"message_update"');
      expect(frame).toContain('"phase":"live"');
    } finally {
      await reader.cancel();
    }
  });
});
