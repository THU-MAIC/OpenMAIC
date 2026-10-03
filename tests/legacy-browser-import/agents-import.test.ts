/**
 * Moving the custom agents of the old browser agent registry to the owner the
 * browser is bound to (lib/legacy-browser-import/agents-import.ts): once per
 * browser, ledgered, fenced, and never touching the legacy key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENTS_IMPORT_ENDPOINT,
  importBatches,
  LEGACY_AGENT_REGISTRY_KEY,
  readLegacyCustomAgents,
  runAgentsImport,
} from '@/lib/legacy-browser-import/agents-import';
import { LEDGER_KEY, loadLedger } from '@/lib/legacy-browser-import/ledger';
import { BINDING_ENDPOINT, LEGACY_IMPORT_HEADER } from '@/lib/legacy-browser-import/protocol';
import { clearLocalStorageKeepingImportState } from '@/lib/device-storage/clear-local-cache';
import {
  customAgentSchema,
  MAX_IMPORT_BATCH_AGENTS,
  MAX_IMPORT_BODY_BYTES,
} from '@/lib/orchestration/registry/schema';

import { MemoryStorage } from './harness';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const custom = {
  id: 'tutor',
  name: 'My tutor',
  role: 'assistant',
  persona: 'Patient.',
  avatar: '/avatars/assist.png',
  color: '#10b981',
  allowedActions: ['wb_open'],
  priority: 7,
  voiceConfig: { providerId: 'openai-tts', voiceId: 'alloy' },
  isDefault: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

/** The old registry as zustand `persist` wrote it. */
function legacyRegistry() {
  const storage = new MemoryStorage();
  const snapshot = JSON.stringify({
    state: {
      agents: {
        'default-1': { id: 'default-1', name: 'stale teacher', isDefault: true },
        tutor: custom,
        'gen-old': { ...custom, id: 'gen-old', isGenerated: true, boundStageId: 's' },
      },
    },
    version: 11,
  });
  storage.setItem(LEGACY_AGENT_REGISTRY_KEY, snapshot);
  return { storage, snapshot };
}

function server(options: { bound?: boolean; importStatus?: number } = {}) {
  return vi.fn(async (input: string, _init?: RequestInit) => {
    if (input === BINDING_ENDPOINT) return Response.json({ bound: options.bound ?? true });
    if (input === AGENTS_IMPORT_ENDPOINT) {
      const status = options.importStatus ?? 200;
      return status === 200
        ? Response.json({ imported: ['tutor'], skipped: [] })
        : Response.json({ error: { code: 'X' } }, { status });
    }
    throw new Error(`unexpected request ${input}`);
  });
}

/**
 * The import route's rules over a fake owner: invalid agents and agents past
 * `capacity` are skipped, ids it holds are kept.
 */
function ownerServer(capacity: number) {
  const held = new Map<string, unknown>();
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    if (input === BINDING_ENDPOINT) return Response.json({ bound: true });
    const imported: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const agent of JSON.parse(init!.body as string).agents) {
      const parsed = customAgentSchema.safeParse(agent);
      if (!parsed.success) skipped.push({ id: agent.id, reason: 'invalid: x' });
      else if (held.has(agent.id)) skipped.push({ id: agent.id, reason: 'exists' });
      else if (held.size >= capacity) skipped.push({ id: agent.id, reason: 'limit' });
      else {
        held.set(agent.id, parsed.data);
        imported.push(agent.id);
      }
    }
    return Response.json({ imported, skipped });
  });
  return {
    fetch,
    held,
    setCapacity(next: number) {
      capacity = next;
    },
  };
}

function registryOf(agents: Record<string, unknown>[]) {
  const storage = new MemoryStorage();
  storage.setItem(
    LEGACY_AGENT_REGISTRY_KEY,
    JSON.stringify({ state: { agents: Object.fromEntries(agents.map((a) => [a.id, a])) } }),
  );
  return storage;
}

describe('the custom agents import', () => {
  it('reads only the custom agents, as stored fields', () => {
    const { storage } = legacyRegistry();
    expect(readLegacyCustomAgents(storage)).toEqual([
      {
        id: 'tutor',
        name: 'My tutor',
        role: 'assistant',
        persona: 'Patient.',
        avatar: '/avatars/assist.png',
        color: '#10b981',
        allowedActions: ['wb_open'],
        priority: 7,
        voiceConfig: { providerId: 'openai-tts', voiceId: 'alloy' },
      },
    ]);
    const unreadable = new MemoryStorage();
    unreadable.setItem(LEGACY_AGENT_REGISTRY_KEY, '{not json');
    expect(readLegacyCustomAgents(unreadable)).toEqual([]);
  });

  it('sends them once, fenced, and records the import in the ledger', async () => {
    const { storage, snapshot } = legacyRegistry();
    const fetch = server();

    await expect(runAgentsImport({ fetch, storage })).resolves.toEqual({
      outcome: 'imported',
      imported: 1,
      pending: [],
    });
    const [, init] = fetch.mock.calls.find(([url]) => url === AGENTS_IMPORT_ENDPOINT)!;
    const ledger = loadLedger(storage)!;
    expect((init!.headers as Record<string, string>)[LEGACY_IMPORT_HEADER]).toBe(ledger.browserId);
    expect(JSON.parse(init!.body as string).agents.map((a: { id: string }) => a.id)).toEqual([
      'tutor',
    ]);
    expect(ledger.agents).toBe('done');
    // The legacy key is read, never written.
    expect(storage.getItem(LEGACY_AGENT_REGISTRY_KEY)).toBe(snapshot);

    fetch.mockClear();
    await expect(runAgentsImport({ fetch, storage })).resolves.toMatchObject({ outcome: 'none' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the agents for a later load when the browser is not this owner’s', async () => {
    const { storage } = legacyRegistry();
    const fetch = server({ bound: false });
    await expect(runAgentsImport({ fetch, storage })).resolves.toMatchObject({
      outcome: 'kept',
      pending: [{ id: 'tutor', reason: 'not bound to this owner' }],
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([BINDING_ENDPOINT]);
    expect(loadLedger(storage)!.agents).toBeUndefined();
  });

  it.each([400, 401, 409, 413, 503])('keeps them after HTTP %s', async (status) => {
    const { storage } = legacyRegistry();
    await expect(
      runAgentsImport({ fetch: server({ importStatus: status }), storage }),
    ).resolves.toMatchObject({ outcome: 'kept', pending: [{ id: 'tutor' }] });
    expect(loadLedger(storage)!.agents).toBeUndefined();
  });

  it('creates no ledger for a browser with nothing to import', async () => {
    const storage = new MemoryStorage();
    const fetch = server();
    await expect(runAgentsImport({ fetch, storage })).resolves.toMatchObject({ outcome: 'none' });
    expect(storage.getItem(LEDGER_KEY)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('survives Clear Local Cache until the agents are imported', async () => {
    const { storage, snapshot } = legacyRegistry();
    storage.setItem('unrelated', 'x');
    clearLocalStorageKeepingImportState(storage);
    expect(storage.getItem(LEGACY_AGENT_REGISTRY_KEY)).toBe(snapshot);
    expect(storage.getItem('unrelated')).toBeNull();

    await runAgentsImport({ fetch: server(), storage });
    clearLocalStorageKeepingImportState(storage);
    expect(storage.getItem(LEGACY_AGENT_REGISTRY_KEY)).toBeNull();
    expect(loadLedger(storage)!.agents).toBe('done');
  });

  it('keeps a partial import open through Clear Local Cache, and finishes it once there is room', async () => {
    const valid = (id: string) => ({ ...custom, id });
    const storage = registryOf([
      valid('a'),
      valid('b'),
      valid('c'),
      { ...custom, id: 'broken', priority: 'high' },
    ]);
    const owner = ownerServer(2);

    const first = await runAgentsImport({ fetch: owner.fetch, storage });
    expect(first).toEqual({
      outcome: 'partial',
      imported: 2,
      pending: [
        { id: 'c', reason: 'limit' },
        { id: 'broken', reason: 'invalid: x' },
      ],
    });
    expect(loadLedger(storage)!.agents).toBeUndefined();

    clearLocalStorageKeepingImportState(storage);
    expect(readLegacyCustomAgents(storage).map((agent) => agent.id)).toEqual([
      'a',
      'b',
      'c',
      'broken',
    ]);

    owner.setCapacity(10);
    const second = await runAgentsImport({ fetch: owner.fetch, storage });
    expect(second).toMatchObject({ outcome: 'partial', imported: 1 });
    expect([...owner.held.keys()]).toEqual(['a', 'b', 'c']);
    // Still open for the record the server refuses; nothing is imported twice.
    expect(loadLedger(storage)!.agents).toBeUndefined();
    const third = await runAgentsImport({ fetch: owner.fetch, storage });
    expect(third).toMatchObject({ outcome: 'partial', imported: 0 });
    expect(owner.held.size).toBe(3);
  });

  it('records the import once every agent is on the server', async () => {
    const storage = registryOf([
      { ...custom, id: 'a' },
      { ...custom, id: 'b' },
    ]);
    const owner = ownerServer(1);
    await expect(runAgentsImport({ fetch: owner.fetch, storage })).resolves.toMatchObject({
      outcome: 'partial',
    });
    owner.setCapacity(5);
    await expect(runAgentsImport({ fetch: owner.fetch, storage })).resolves.toEqual({
      outcome: 'imported',
      imported: 1,
      pending: [],
    });
    expect(loadLedger(storage)!.agents).toBe('done');
    clearLocalStorageKeepingImportState(storage);
    expect(storage.getItem(LEGACY_AGENT_REGISTRY_KEY)).toBeNull();
  });

  it('leaves out empty optional fields of old records, so they are not refused', async () => {
    const storage = registryOf([
      {
        ...custom,
        id: 'empty-model',
        voiceConfig: { providerId: 'openai-tts', modelId: '', voiceId: 'alloy' },
      },
      { ...custom, id: 'no-voice', voiceConfig: { providerId: '', voiceId: '' } },
      { ...custom, id: 'half-design', voiceDesign: { identity: 'warm' } },
    ]);
    const agents = readLegacyCustomAgents(storage);
    expect(agents.map((agent) => [agent.id, agent.voiceConfig, agent.voiceDesign])).toEqual([
      ['empty-model', { providerId: 'openai-tts', voiceId: 'alloy' }, undefined],
      ['no-voice', undefined, undefined],
      ['half-design', { providerId: 'openai-tts', voiceId: 'alloy' }, undefined],
    ]);
    const owner = ownerServer(10);
    await expect(runAgentsImport({ fetch: owner.fetch, storage })).resolves.toMatchObject({
      outcome: 'imported',
      imported: 3,
    });
  });

  it('never recreates an agent the user deleted on the server after it arrived', async () => {
    const storage = registryOf([
      { ...custom, id: 'a' },
      { ...custom, id: 'b' },
    ]);
    const owner = ownerServer(1);
    await expect(runAgentsImport({ fetch: owner.fetch, storage })).resolves.toMatchObject({
      outcome: 'partial',
      imported: 1,
      pending: [{ id: 'b', reason: 'limit' }],
    });
    expect(loadLedger(storage)!.agentsSettled).toEqual(['a']);

    // The user deletes "a" on the server; there is room again.
    owner.held.delete('a');
    owner.setCapacity(5);
    clearLocalStorageKeepingImportState(storage);
    await expect(runAgentsImport({ fetch: owner.fetch, storage })).resolves.toEqual({
      outcome: 'imported',
      imported: 1,
      pending: [],
    });
    const sent = owner.fetch.mock.calls
      .filter(([url]) => url === AGENTS_IMPORT_ENDPOINT)
      .map(([, init]) => JSON.parse(init!.body as string).agents.map((a: { id: string }) => a.id));
    expect(sent).toEqual([['a', 'b'], ['b']]);
    expect([...owner.held.keys()]).toEqual(['b']);
    expect(loadLedger(storage)!.agents).toBe('done');
  });

  it('sends agents in batches that fit the import route', async () => {
    const big = (id: string) => ({ ...custom, id, persona: '\u0000'.repeat(32_000) });
    const { batches, tooLarge } = importBatches(
      Array.from({ length: 250 }, (_, index) => big(`a-${index}`)),
    );
    expect(tooLarge).toEqual([]);
    expect(batches.flat()).toHaveLength(250);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_IMPORT_BATCH_AGENTS);
      expect(
        new TextEncoder().encode(JSON.stringify({ agents: batch })).length,
      ).toBeLessThanOrEqual(MAX_IMPORT_BODY_BYTES);
    }
    expect(batches.length).toBeGreaterThan(1);
  });

  it('serializes tabs: a tab that waited reads what is settled after the lock', async () => {
    // One Web Lock manager shared by two tabs of the same browser.
    let held = false;
    const locks = {
      request: async (
        _name: string,
        _options: { ifAvailable: boolean },
        work: (lock: object | null) => Promise<unknown>,
      ) => {
        if (held) return work(null);
        held = true;
        try {
          return await work({});
        } finally {
          held = false;
        }
      },
    } as unknown as LockManager;
    const storage = registryOf([{ ...custom, id: 'a' }]);
    const owner = ownerServer(5);
    const answer = deferred<void>();
    const slow = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === AGENTS_IMPORT_ENDPOINT) await answer.promise;
      return owner.fetch(input, init);
    });

    const tabA = runAgentsImport({ fetch: slow, storage, locks });
    await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(2));
    const tabB = vi.fn((input: string, init?: RequestInit) => owner.fetch(input, init));
    await expect(runAgentsImport({ fetch: tabB, storage, locks })).resolves.toMatchObject({
      outcome: 'kept',
      pending: [{ id: 'a', reason: 'importing in another tab' }],
    });
    expect(tabB).not.toHaveBeenCalled();

    answer.resolve();
    await expect(tabA).resolves.toMatchObject({ outcome: 'imported', imported: 1 });
    owner.held.delete('a');
    // Tab B's next attempt finds the import done and sends nothing.
    await expect(runAgentsImport({ fetch: tabB, storage, locks })).resolves.toMatchObject({
      outcome: 'none',
    });
    expect(tabB).not.toHaveBeenCalled();
    expect(owner.held.has('a')).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}
