import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryWhiteboardVisibility } from '@/lib/chat/pi/whiteboard-visibility';

function request(
  body: unknown,
  headers: Record<string, string> = {
    authorization: 'Bearer test-token',
    'x-learner-key': 'learner-1',
  },
): NextRequest {
  return new Request('http://localhost/api/chat/pi/whiteboard-visibility', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe('whiteboard visibility callback route', () => {
  beforeEach(() => vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'test-token'));
  afterEach(() => vi.unstubAllEnvs());

  it('does not let malformed, unauthenticated, or mismatched callbacks settle the owner', async () => {
    let queryId = '';
    const pending = queryWhiteboardVisibility({
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      timeoutMs: 1_000,
      dispatch: async (id) => {
        queryId = id;
      },
    });
    await vi.waitFor(() => expect(queryId).not.toBe(''));
    const { POST } = await import('@/app/api/chat/pi/whiteboard-visibility/route');

    expect(
      (
        await POST(
          request(
            { queryId, stageId: 'stage-1', visibility: 'closed' },
            { authorization: 'Bearer wrong', 'x-learner-key': 'learner-1' },
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (await POST(request({ queryId, stageId: 'wrong-stage', visibility: 'closed' }))).status,
    ).toBe(404);
    expect(
      (await POST(request({ queryId, stageId: 'stage-1', visibility: 'closed', extra: true })))
        .status,
    ).toBe(400);

    expect((await POST(request({ queryId, stageId: 'stage-1', visibility: 'open' }))).status).toBe(
      204,
    );
    await expect(pending).resolves.toBe('open');
  });
});
