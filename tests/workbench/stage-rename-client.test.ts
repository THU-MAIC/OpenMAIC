// @vitest-environment jsdom

/**
 * The client half of the course rename: `PATCH /api/stages/:id`.
 *
 * The route owns the rule (owner gate, validation, the document write) and is
 * tested against it in `tests/server/stage-rename-route.test.ts`. What is
 * pinned here is the wire the rail speaks over it — the method, the body, and
 * the mapping from each refusal status onto a reason the UI can put into a
 * sentence. A 403 that arrives as a generic failure is a rename that tells the
 * user nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRenameStage, StageRenameError, STAGE_NAME_MAX_LENGTH } from '@/lib/live/server-api';

function respond(status: number, body: unknown = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('apiRenameStage', () => {
  it('PATCHes the name and returns what the server stored', async () => {
    respond(200, { success: true, name: '牛顿力学' });
    await expect(apiRenameStage('stage 1', '  牛顿力学  ')).resolves.toBe('牛顿力学');

    const fetchMock = vi.mocked(globalThis.fetch);
    const [url, init] = fetchMock.mock.calls[0]!;
    // Encoded: a stage id goes into the path, and the path is not a place to
    // trust raw input.
    expect(url).toBe('/api/stages/stage%201');
    expect(init?.method).toBe('PATCH');
    expect(init?.credentials).toBe('include');
    expect(JSON.parse(String(init?.body))).toEqual({ name: '  牛顿力学  ' });
  });

  it('falls back to the submitted name when the response omits one', async () => {
    respond(200, { success: true });
    await expect(apiRenameStage('s1', ' 补上 ')).resolves.toBe('补上');
  });

  it('maps each refusal onto the reason the UI messages', async () => {
    for (const [status, kind] of [
      [400, 'invalidName'],
      [403, 'forbidden'],
      [404, 'notFound'],
      [500, 'failed'],
    ] as const) {
      respond(status, { error: 'nope' });
      await expect(apiRenameStage('s1', 'x')).rejects.toMatchObject({
        name: 'StageRenameError',
        kind,
      });
      await expect(apiRenameStage('s1', 'x')).rejects.toBeInstanceOf(StageRenameError);
    }
  });

  it('states the same 120-character cap the route enforces', () => {
    expect(STAGE_NAME_MAX_LENGTH).toBe(120);
  });
});
