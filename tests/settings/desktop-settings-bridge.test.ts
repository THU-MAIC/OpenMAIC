import { describe, expect, it, vi } from 'vitest';

import { syncDesktopSettingsOnce } from '@/components/desktop-settings-bridge';

const ID = 'transfer-1';

function bodyOf(init?: RequestInit) {
  return JSON.parse(String(init?.body)) as { action: string; id: string };
}

describe('desktop settings bridge confirmation', () => {
  it('retries an apply response loss, then reads the saved revision before confirming', async () => {
    let applyCalls = 0;
    let confirmed = false;
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      if (!init?.method) {
        return confirmed
          ? new Response(null, { status: 204 })
          : Response.json({ version: 2, id: ID });
      }
      const body = bodyOf(init);
      if (body.action === 'register') return Response.json({ registered: true });
      if (body.action === 'apply') {
        applyCalls += 1;
        if (applyCalls === 1) throw new Error('response lost after save');
        return Response.json({ saved: true, revision: 8 });
      }
      confirmed = true;
      return Response.json({ confirmed: true });
    });
    const client = {
      load: vi.fn(async () => ({ phase: 'ready' as const, view: { revision: 8 } as never })),
    };

    expect(await syncDesktopSettingsOnce(fetchImpl, client)).toBe('retry');
    expect(client.load).not.toHaveBeenCalled();
    expect(await syncDesktopSettingsOnce(fetchImpl, client)).toBe('confirmed');
    expect(client.load).toHaveBeenCalledWith({ fresh: true });
    expect(applyCalls).toBe(2);
    expect(confirmed).toBe(true);
  });

  it('leaves the transfer unconfirmed until a temporary reload error recovers', async () => {
    let confirmCalls = 0;
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      if (!init?.method) return Response.json({ version: 2, id: ID });
      const body = bodyOf(init);
      if (body.action === 'register') return Response.json({ registered: true });
      if (body.action === 'apply') return Response.json({ saved: true, revision: 4 });
      confirmCalls += 1;
      return Response.json({ confirmed: true });
    });
    const client = {
      load: vi
        .fn()
        .mockResolvedValueOnce({ phase: 'error', view: null, error: 'temporary' })
        .mockResolvedValueOnce({ phase: 'ready', view: { revision: 4 } }),
    };

    expect(await syncDesktopSettingsOnce(fetchImpl, client as never)).toBe('retry');
    expect(confirmCalls).toBe(0);
    expect(await syncDesktopSettingsOnce(fetchImpl, client as never)).toBe('confirmed');
    expect(confirmCalls).toBe(1);
  });
});
