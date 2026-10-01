/**
 * Moving the custom agents of the old browser agent registry to the owner the
 * browser is bound to (lib/legacy-browser-import/agents-import.ts): once per
 * browser, ledgered, fenced, and never touching the legacy key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENTS_IMPORT_ENDPOINT,
  LEGACY_AGENT_REGISTRY_KEY,
  readLegacyCustomAgents,
  runAgentsImport,
} from '@/lib/legacy-browser-import/agents-import';
import { LEDGER_KEY, loadLedger } from '@/lib/legacy-browser-import/ledger';
import { BINDING_ENDPOINT, LEGACY_IMPORT_HEADER } from '@/lib/legacy-browser-import/protocol';
import { clearLocalStorageKeepingImportState } from '@/lib/device-storage/clear-local-cache';

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

    await expect(runAgentsImport({ fetch, storage })).resolves.toBe('imported');
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
    await expect(runAgentsImport({ fetch, storage })).resolves.toBe('none');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the agents for a later load when the browser is not this owner’s', async () => {
    const { storage } = legacyRegistry();
    const fetch = server({ bound: false });
    await expect(runAgentsImport({ fetch, storage })).resolves.toBe('kept');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([BINDING_ENDPOINT]);
    expect(loadLedger(storage)!.agents).toBeUndefined();
  });

  it.each([409, 503, 401])('keeps them after HTTP %s', async (status) => {
    const { storage } = legacyRegistry();
    await expect(
      runAgentsImport({ fetch: server({ importStatus: status }), storage }),
    ).resolves.toBe('kept');
    expect(loadLedger(storage)!.agents).toBeUndefined();
  });

  it('records a refusal for good (400) so it is not sent again', async () => {
    const { storage } = legacyRegistry();
    await expect(runAgentsImport({ fetch: server({ importStatus: 400 }), storage })).resolves.toBe(
      'dropped',
    );
    expect(loadLedger(storage)!.agents).toBe('done');
  });

  it('creates no ledger for a browser with nothing to import', async () => {
    const storage = new MemoryStorage();
    const fetch = server();
    await expect(runAgentsImport({ fetch, storage })).resolves.toBe('none');
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
});
