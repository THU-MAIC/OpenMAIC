import { describe, expect, it, vi } from 'vitest';

import {
  createModelSettingsClient,
  isLlmConfigured,
  needsFirstRunSetup,
  type ModelSettingsView,
} from '@/lib/model-settings/client';

import { makeView, withSlots } from './fixtures';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('model settings client', () => {
  it('loads the view and notifies subscribers', async () => {
    const view = makeView({ revision: 3 });
    const fetchImpl = vi.fn(async () => json(view));
    const client = createModelSettingsClient(fetchImpl);
    const listener = vi.fn();
    client.subscribe(listener);

    const state = await client.load();

    expect(state).toEqual({ phase: 'ready', view });
    expect(client.getState().view).toEqual(state.view);
    expect(listener).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith('/api/model-config', { cache: 'no-store' });
  });

  it('shares one request between concurrent loads', async () => {
    const fetchImpl = vi.fn(async () => json(makeView()));
    const client = createModelSettingsClient(fetchImpl);
    await Promise.all([client.load(), client.load()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a server without persistence as unavailable', async () => {
    const client = createModelSettingsClient(
      async () => new Response('Not found', { status: 404 }),
    );
    expect((await client.load()).phase).toBe('unavailable');
    const result = await client.apply({ kind: 'slots', clear: ['llm'] });
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('keeps the last view when a reload fails', async () => {
    const view = makeView({ revision: 1 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(view))
      .mockRejectedValueOnce(new Error('offline'));
    const client = createModelSettingsClient(fetchImpl);
    await client.load();
    const state = await client.load();
    expect(state).toMatchObject({ phase: 'error', view, error: 'offline' });
  });

  it('writes against the revision it read and takes the answered view', async () => {
    const before = makeView({ revision: 4 });
    const after = makeView({ revision: 5 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(before))
      .mockResolvedValueOnce(json(after));
    const client = createModelSettingsClient(fetchImpl);
    await client.load();

    const change = { kind: 'slots', set: { llm: 'acme:acme-large' } } as const;
    const result = await client.apply(change);

    expect(result).toEqual({ ok: true, view: after });
    expect(client.getState().view?.revision).toBe(5);
    const [, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ revision: 4, change });
  });

  it('loads first when nothing was read yet', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(makeView({ revision: null })))
      .mockResolvedValueOnce(json(makeView({ revision: 1 })));
    const client = createModelSettingsClient(fetchImpl);
    const result = await client.apply({ kind: 'remove-provider', id: 'acme' });
    expect(result.ok).toBe(true);
    const [, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string).revision).toBeNull();
  });

  it('returns an unconfirmed outcome, reloaded, when the answer to a write is lost', async () => {
    const before = makeView({ revision: 1 });
    const after = makeView({ revision: 2 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(before))
      .mockResolvedValueOnce(new Response('{"revision":2,"pol', { status: 200 }))
      .mockResolvedValueOnce(json(after));
    const client = createModelSettingsClient(fetchImpl);
    await client.load();

    const result = await client.apply({ kind: 'slots', clear: ['tts'] });

    expect(result).toMatchObject({ ok: false, reason: 'unconfirmed', view: after });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(client.getState()).toMatchObject({ phase: 'ready', view: after });
  });

  it('reconciles a write whose request fails in transport: it may have been saved', async () => {
    const after = makeView({ revision: 2 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(makeView({ revision: 1 })))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json(after));
    const client = createModelSettingsClient(fetchImpl);
    await client.load();

    const result = await client.apply({ kind: 'remove-provider', id: 'acme' });

    expect(result).toEqual({
      ok: false,
      reason: 'unconfirmed',
      message: 'Failed to fetch',
      view: after,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('stays unconfirmed, without a view, when the reload fails too', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(makeView({ revision: 1 })))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const client = createModelSettingsClient(fetchImpl);
    await client.load();

    const result = await client.apply({ kind: 'slots', clear: ['tts'] });

    expect(result).toEqual({ ok: false, reason: 'unconfirmed', message: 'Failed to fetch' });
    expect(client.getState().phase).toBe('error');
  });

  it.each([
    [500, json({ error: { code: 'INTERNAL', message: 'Could not save' } }, 500)],
    [504, new Response('<html>Gateway Timeout</html>', { status: 504 })],
  ])('treats a %i answer to a write as unconfirmed: it may have committed', async (_, answer) => {
    const committed = makeView({ revision: 2 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(makeView({ revision: 1 })))
      .mockResolvedValueOnce(answer)
      .mockResolvedValueOnce(json(committed));
    const client = createModelSettingsClient(fetchImpl);
    await client.load();

    const result = await client.apply({ kind: 'provider', id: 'acme', preset: 'acme' });

    expect(result).toMatchObject({ ok: false, reason: 'unconfirmed', view: committed });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not reload after a refusal (4xx): nothing was saved', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(makeView({ revision: 1 })))
      .mockResolvedValueOnce(json({ error: { code: 'X', message: 'no' } }, 422));
    const client = createModelSettingsClient(fetchImpl);
    await client.load();
    expect(await client.apply({ kind: 'slots', clear: ['tts'] })).toMatchObject({
      ok: false,
      reason: 'failed',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reloads on a stale revision and says so', async () => {
    const stale = makeView({ revision: 1 });
    const fresh = makeView({ revision: 2 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(stale))
      .mockResolvedValueOnce(
        json({ error: { code: 'CONFLICT', message: 'The settings changed; reload them' } }, 409),
      )
      .mockResolvedValueOnce(json(fresh));
    const client = createModelSettingsClient(fetchImpl);
    await client.load();

    const result = await client.apply({ kind: 'slots', clear: ['tts'] });

    expect(result).toMatchObject({ ok: false, reason: 'conflict', code: 'CONFLICT' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(client.getState()).toMatchObject({ phase: 'ready', view: fresh });
  });

  it('reloads when the deployment has locked a slot meanwhile', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(makeView({ revision: 1 })))
      .mockResolvedValueOnce(
        json({ error: { code: 'SLOT_LOCKED', message: 'llm is set by the deployment' } }, 409),
      )
      .mockResolvedValueOnce(json(makeView({ revision: 1 })));
    const client = createModelSettingsClient(fetchImpl);
    await client.load();
    const result = await client.apply({ kind: 'slots', set: { llm: 'a:b' } });
    expect(result).toMatchObject({
      ok: false,
      reason: 'locked',
      message: 'llm is set by the deployment',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('passes a refused change through with the server message and keeps the view', async () => {
    const view = makeView({ revision: 1 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(view))
      .mockResolvedValueOnce(
        json({ error: { code: 'INVALID_PROVIDER', message: 'The preset needs a base URL' } }, 400),
      );
    const client = createModelSettingsClient(fetchImpl);
    await client.load();
    const result = await client.apply({ kind: 'provider', id: 'x', preset: 'openai-compatible' });
    expect(result).toEqual({
      ok: false,
      reason: 'invalid',
      code: 'INVALID_PROVIDER',
      message: 'The preset needs a base URL',
    });
    expect(client.getState().view).toEqual(view);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('language model helpers', () => {
  const assigned: ModelSettingsView['slots'][number]['effective'] = {
    status: 'assigned',
    resolvedAt: 'llm',
    source: 'workspace',
    requirements: [],
    providerId: 'acme',
    providerSource: 'workspace',
    presetId: 'acme',
    registryId: 'openai',
    modelId: 'acme-large',
  };

  it('knows whether a language model is configured', () => {
    expect(isLlmConfigured(null)).toBe(false);
    expect(isLlmConfigured(makeView())).toBe(false);
    expect(isLlmConfigured(withSlots(makeView(), { llm: { effective: assigned } }))).toBe(true);
  });

  it('offers the first-run setup only while llm is empty and not locked', () => {
    expect(needsFirstRunSetup(makeView())).toBe(true);
    expect(needsFirstRunSetup(withSlots(makeView(), { llm: { locked: true } }))).toBe(false);
    expect(needsFirstRunSetup(withSlots(makeView(), { llm: { effective: assigned } }))).toBe(false);
  });
});

describe('read ordering', () => {
  /** A fetch whose answers are released by hand, in any order. */
  function manualFetch() {
    const pending: { init?: RequestInit; resolve: (response: Response) => void }[] = [];
    const fetchImpl = vi.fn(
      (_input: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => pending.push({ init, resolve })),
    );
    return { fetchImpl, pending };
  }
  const tick = () => new Promise((settle) => setTimeout(settle, 0));

  it('never lets a read that started before a write answer replace it', async () => {
    const { fetchImpl, pending } = manualFetch();
    const client = createModelSettingsClient(fetchImpl);
    const first = client.load();
    pending[0].resolve(json(makeView({ revision: 4 })));
    await first;

    const write = client.apply({ kind: 'slots', clear: ['tts'] });
    await tick();
    const read = client.load({ fresh: true });
    await tick();
    pending[1].resolve(json(makeView({ revision: 5 })));
    await write;
    // The read began before the write's answer was adopted: dropped, even
    // though its revision is not older.
    pending[2].resolve(json(makeView({ revision: 5, presets: [] })));
    await read;

    expect(client.getState()).toMatchObject({ phase: 'ready', view: { revision: 5 } });
    expect(client.getState().view?.presets.length).toBeGreaterThan(0);
  });

  it('drops an older read that answers after a newer one', async () => {
    const { fetchImpl, pending } = manualFetch();
    const client = createModelSettingsClient(fetchImpl);
    const older = client.load();
    const newer = client.load({ fresh: true });
    pending[1].resolve(json(makeView({ revision: 7 })));
    await newer;
    pending[0].resolve(json(makeView({ revision: 6 })));
    await older;
    expect(client.getState()).toMatchObject({ phase: 'ready', view: { revision: 7 } });
  });

  it('drops an answer older than the view it holds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(makeView({ revision: 5 })))
      .mockResolvedValueOnce(json(makeView({ revision: 3 })));
    const client = createModelSettingsClient(fetchImpl);
    await client.load();
    await client.load();
    expect(client.getState()).toMatchObject({ phase: 'ready', view: { revision: 5 } });
  });

  it('keeps a newer read when an older write answer arrives after it', async () => {
    const { fetchImpl, pending } = manualFetch();
    const client = createModelSettingsClient(fetchImpl);
    const first = client.load();
    pending[0].resolve(json(makeView({ revision: 4 })));
    await first;

    const write = client.apply({ kind: 'slots', clear: ['tts'] });
    await tick();
    const read = client.load({ fresh: true });
    await tick();
    // The read answers first with a later revision (another change landed too) …
    pending[2].resolve(json(makeView({ revision: 6 })));
    await read;
    // … then the write's own answer, at revision 5, arrives late.
    pending[1].resolve(json(makeView({ revision: 5 })));
    const result = await write;

    expect(client.getState().view?.revision).toBe(6);
    expect(result).toMatchObject({ ok: true, view: { revision: 6 } });
  });

  it('takes a later revision from a read that began before an older write answer landed', async () => {
    const { fetchImpl, pending } = manualFetch();
    const client = createModelSettingsClient(fetchImpl);
    const first = client.load();
    pending[0].resolve(json(makeView({ revision: 4 })));
    await first;

    const write = client.apply({ kind: 'slots', clear: ['tts'] });
    await tick();
    const read = client.load({ fresh: true });
    await tick();
    pending[1].resolve(json(makeView({ revision: 5 })));
    await write;
    // The read began before revision 5 was adopted, but it carries revision 6.
    pending[2].resolve(json(makeView({ revision: 6 })));
    await read;

    expect(client.getState()).toMatchObject({ phase: 'ready', view: { revision: 6 } });
  });

  it('does not let a read begun before the view was forgotten bring it back', async () => {
    const { fetchImpl, pending } = manualFetch();
    const client = createModelSettingsClient(fetchImpl);
    const first = client.load();
    pending[0].resolve(json(makeView({ revision: 4 })));
    await first;

    const read = client.load({ fresh: true });
    client.adopt(null);
    pending[1].resolve(json(makeView({ revision: 4 })));
    await read;

    expect(client.getState().view).toBeNull();
    // A read begun after it is taken.
    const next = client.load();
    pending[2].resolve(json(makeView({ revision: 7 })));
    await next;
    expect(client.getState().view?.revision).toBe(7);
  });
});
