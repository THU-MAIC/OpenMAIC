import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { createFakeDocumentStore } from './_fake-document-store';
import { FIXED_NOW, makeDocument, makeSlideScene } from './_stage-fixtures';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  fakeStore: null as ReturnType<typeof createFakeDocumentStore> | null,
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: async () => mocks.fakeStore!.store,
}));

import { GET, STAGE_FRESHNESS_POLL_INTERVAL_MS } from '@/app/api/stages/[id]/freshness/route';

const STAGE_ID = 'stage-1';

function call(id = STAGE_ID) {
  const req = new NextRequest(`http://localhost/api/stages/${id}/freshness`);
  return GET(req, { params: Promise.resolve({ id }) });
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string | null> {
  const chunk = await reader.read();
  return chunk.done ? null : new TextDecoder().decode(chunk.value);
}

/** Accumulate chunks until one carries a `stage_freshness` frame (or the stream closes). */
async function readUntilFreshness(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string | null> {
  let accumulated = '';
  for (;;) {
    const chunk = await readChunk(reader);
    if (chunk === null) return accumulated === '' ? null : accumulated;
    accumulated += chunk;
    if (accumulated.includes('stage_freshness')) return accumulated;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.runtimeConfigured = true;
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
  mocks.fakeStore = createFakeDocumentStore();
  mocks.fakeStore.docs.set(
    STAGE_ID,
    makeDocument(STAGE_ID, 'Course', [makeSlideScene('scene-1', STAGE_ID, 1)]),
  );
  mocks.fakeStore.stageRevs.set(STAGE_ID, FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/stages/[id]/freshness', () => {
  it('opens the stream with the retry hint and the current rev', async () => {
    const response = await call();
    const reader = response.body!.getReader();

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const received = await readUntilFreshness(reader);
    expect(received).toContain('retry: 3000');
    expect(received).toContain(
      `event: stage_freshness\ndata: ${JSON.stringify({
        type: 'stage_freshness',
        stageId: STAGE_ID,
        rev: FIXED_NOW,
      })}`,
    );
    await reader.cancel();
  });

  it('emits a frame when the stage rev moves', async () => {
    const response = await call();
    const reader = response.body!.getReader();
    await readUntilFreshness(reader);

    // An external writer (the DB trigger on a manual SQL UPDATE, say) moves
    // the stage revision; the stream notices on its next poll.
    mocks.fakeStore!.stageRevs.set(STAGE_ID, FIXED_NOW + 1);

    const pending = readUntilFreshness(reader);
    await vi.advanceTimersByTimeAsync(STAGE_FRESHNESS_POLL_INTERVAL_MS);
    const changed = await pending;
    expect(changed).not.toBeNull();
    expect(changed).toContain(
      `data: ${JSON.stringify({
        type: 'stage_freshness',
        stageId: STAGE_ID,
        rev: FIXED_NOW + 1,
      })}`,
    );
    await reader.cancel();
  });

  it('stays silent while the rev is unchanged (heartbeats aside)', async () => {
    const response = await call();
    const reader = response.body!.getReader();
    await readUntilFreshness(reader);

    let delivered = false;
    const pending = readUntilFreshness(reader).then((frame) => {
      delivered = frame !== null && frame.includes('stage_freshness');
      return frame;
    });
    await vi.advanceTimersByTimeAsync(STAGE_FRESHNESS_POLL_INTERVAL_MS * 3);
    expect(delivered).toBe(false);
    await reader.cancel();
    await pending;
  });

  it('answers 404 for a missing or foreign stage and still rides the owner cookie', async () => {
    mocks.resolveRequestOwnerId.mockImplementationOnce((_req, responseHeaders: Headers) => {
      responseHeaders.set('Set-Cookie', 'anonymous_id=anon-2; Path=/');
      return 'anon:anon-2';
    });
    const response = await call('stage-absent');
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=anon-2');
  });

  it('answers 404 when the agent runtime is not configured', async () => {
    mocks.runtimeConfigured = false;
    expect((await call()).status).toBe(404);
  });
});
