/**
 * What the one-time model settings import could not move to the server stays
 * in the browser with its keys (lib/legacy-browser-import/model-settings-unimported.ts),
 * is announced once, and is never sent again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    warning: vi.fn((message: unknown) => toasts.push(message)),
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

import { settledUnimported } from '@/components/settings/unimported-settings-notice';
import { announceUnimportedModelSettings } from '@/components/model-settings-init';
import {
  MODEL_SETTINGS_IMPORT_ENDPOINT,
  MODEL_SETTINGS_IMPORT_KEY,
  planModelSettingsImport,
  type LegacyModelSettingsState,
} from '@/lib/legacy-browser-import/model-settings';
import { runModelSettingsImport } from '@/lib/legacy-browser-import/model-settings-import';
import {
  discardUnimported,
  forgetUnimported,
  keepUnimported,
  MODEL_SETTINGS_UNIMPORTED_KEY,
  readUnimported,
  takeUnimportedNotice,
  unimportedKey,
  type UnimportedModelSetting,
} from '@/lib/legacy-browser-import/model-settings-unimported';
import { BINDING_ENDPOINT } from '@/lib/legacy-browser-import/protocol';
import type { ModelSettingsView } from '@/lib/model-settings/client';
import { clearLocalStorageKeepingImportState } from '@/lib/device-storage/clear-local-cache';

import { MemoryStorage } from './harness';

const AZURE_KEY = 'azure-browser-key-0123456789';
const OPENAI_KEY = 'sk-openai-browser-0123456789';
const AZURE_ENDPOINT = 'https://westeurope.tts.speech.microsoft.com';

beforeEach(() => {
  toasts.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const PROPOSAL = {
  providers: {
    openai: { preset: 'openai', apiKey: OPENAI_KEY },
    'azure-tts': { preset: 'azure-tts', apiKey: AZURE_KEY, baseUrl: AZURE_ENDPOINT },
  },
  slots: { llm: 'openai:gpt-5.6', tts: 'azure-tts' },
};

function waiting(proposal: unknown = PROPOSAL) {
  const storage = new MemoryStorage();
  storage.setItem(MODEL_SETTINGS_IMPORT_KEY, JSON.stringify(proposal));
  return storage;
}

function server(importBody: unknown, init: { status?: number; raw?: string } = {}) {
  return vi.fn(async (input: string, _init?: RequestInit) => {
    if (input === BINDING_ENDPOINT) return Response.json({ bound: true });
    if (input === MODEL_SETTINGS_IMPORT_ENDPOINT) {
      return init.raw !== undefined
        ? new Response(init.raw, { status: init.status ?? 200 })
        : Response.json(importBody, { status: init.status ?? 200 });
    }
    throw new Error(`unexpected request to ${input}`);
  });
}

type ViewKey = { set: boolean; mask?: string; unreadable?: boolean };
const view = (
  providers: Array<{ id: string; preset: string; key?: ViewKey }>,
  slots: string[] = [],
) =>
  ({
    revision: 2,
    allowUserKeys: true,
    presets: [],
    providers: providers.map((provider) => ({
      source: 'workspace',
      capabilities: {},
      key: { set: true },
      ...provider,
    })),
    slots: slots.map((slot) => ({ slot, assignment: 'x' })),
  }) as unknown as ModelSettingsView;

describe('an import with skipped items', () => {
  it('keeps only the skipped items, with their keys, and drops the imported ones', async () => {
    const storage = waiting();
    const fetch = server({
      imported: [
        { kind: 'provider', id: 'openai' },
        { kind: 'slot', id: 'llm' },
      ],
      skipped: [
        {
          kind: 'provider',
          id: 'azure-tts',
          code: 'INVALID_PROVIDER',
          reason: 'A custom endpoint for Azure TTS can only be configured by the deployment',
        },
        {
          kind: 'slot',
          id: 'tts',
          code: 'INVALID_ASSIGNMENT',
          reason: 'tts: the provider is not declared',
        },
      ],
      view: view([{ id: 'openai', preset: 'openai' }]),
    });
    expect(await runModelSettingsImport({ fetch, storage })).toBe('imported');

    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
    const kept = readUnimported(storage);
    expect(kept.items.map((item) => item.id)).toEqual(['azure-tts', 'tts']);
    expect(kept.items[0]).toMatchObject({
      kind: 'provider',
      capability: 'tts',
      name: 'Azure TTS',
      preset: 'azure-tts',
      reason: 'refused',
      detail: expect.stringContaining('custom endpoint'),
      knownProviders: ['openai'],
      settings: { preset: 'azure-tts', apiKey: AZURE_KEY, baseUrl: AZURE_ENDPOINT },
    });
    expect(kept.items[1]).toMatchObject({
      kind: 'slot',
      reason: 'refused',
      settings: { assignment: 'azure-tts' },
    });
    // The imported key is gone from the browser.
    expect(JSON.stringify([...storage.values.values()])).not.toContain(OPENAI_KEY);
  });

  it('keeps nothing the workspace already holds or the deployment locks', async () => {
    const storage = waiting();
    const fetch = server({
      imported: [],
      skipped: [
        { kind: 'provider', id: 'openai', code: 'EXISTS_SAME', reason: 'held' },
        { kind: 'provider', id: 'azure-tts', code: 'EXISTS_SAME', reason: 'held' },
        { kind: 'slot', id: 'llm', code: 'EXISTS', reason: 'The workspace already sets this slot' },
        { kind: 'slot', id: 'tts', code: 'SLOT_LOCKED', reason: 'tts is set by the deployment' },
      ],
    });
    expect(await runModelSettingsImport({ fetch, storage })).toBe('imported');
    expect(storage.getItem(MODEL_SETTINGS_UNIMPORTED_KEY)).toBeNull();
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
  });

  it('keeps a provider whose id the deployment declares', async () => {
    const storage = waiting({ providers: { openai: { preset: 'openai', apiKey: OPENAI_KEY } } });
    const fetch = server({
      imported: [],
      skipped: [{ kind: 'provider', id: 'openai', code: 'PROVIDER_RESERVED', reason: 'reserved' }],
    });
    await runModelSettingsImport({ fetch, storage });
    expect(readUnimported(storage).items).toEqual([
      expect.objectContaining({
        id: 'openai',
        reason: 'reserved',
        settings: expect.objectContaining({ apiKey: OPENAI_KEY }),
      }),
    ]);
  });

  it('keeps everything when the answer cannot be read', async () => {
    const storage = waiting();
    expect(
      await runModelSettingsImport({ fetch: server(null, { raw: 'not json' }), storage }),
    ).toBe('imported');
    expect(readUnimported(storage).items.map((item) => [item.id, item.reason])).toEqual([
      ['openai', 'unconfirmed'],
      ['azure-tts', 'unconfirmed'],
      ['llm', 'unconfirmed'],
      ['tts', 'unconfirmed'],
    ]);
  });

  it('keeps the proposal when what was skipped cannot be kept elsewhere', async () => {
    const storage = waiting();
    const setItem = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (key === MODEL_SETTINGS_UNIMPORTED_KEY)
        throw new DOMException('full', 'QuotaExceededError');
      setItem(key, value);
    });
    const fetch = server({
      imported: [{ kind: 'provider', id: 'openai' }],
      skipped: [{ kind: 'provider', id: 'azure-tts', code: 'INVALID_PROVIDER', reason: 'no' }],
    });
    expect(await runModelSettingsImport({ fetch, storage })).toBe('kept');
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).not.toBeNull();
  });

  it('does not import again, and never sends what it kept', async () => {
    const storage = waiting();
    const fetch = server({
      imported: [
        { kind: 'provider', id: 'openai' },
        { kind: 'slot', id: 'llm' },
      ],
      skipped: [{ kind: 'provider', id: 'azure-tts', code: 'INVALID_PROVIDER', reason: 'no' }],
    });
    await runModelSettingsImport({ fetch, storage });
    expect(fetch).toHaveBeenCalledTimes(2);
    // Later loads: nothing is waiting, nothing is sent.
    for (let load = 0; load < 3; load++) {
      expect(await runModelSettingsImport({ fetch, storage })).toBe('none');
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    const bodies = fetch.mock.calls.map(([, init]) => String(init?.body ?? ''));
    expect(bodies.filter((body) => body.includes(AZURE_KEY))).toHaveLength(1);
    expect(readUnimported(storage).items).toHaveLength(2);
  });
});

describe('an import that meets settings already in the workspace', () => {
  it('keeps a provider whose id the workspace holds with another key', async () => {
    // The workspace's `openai` holds another key: the server keeps it and says so.
    const storage = waiting({ providers: { openai: { preset: 'openai', apiKey: OPENAI_KEY } } });
    const fetch = server({
      imported: [],
      skipped: [
        {
          kind: 'provider',
          id: 'openai',
          code: 'EXISTS_DIFFERENT',
          reason: 'A provider with this id already exists with other settings',
        },
      ],
    });
    expect(await runModelSettingsImport({ fetch, storage })).toBe('imported');
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
    expect(readUnimported(storage).items).toEqual([
      expect.objectContaining({
        id: 'openai',
        kind: 'provider',
        reason: 'refused',
        detail: expect.stringContaining('other settings'),
        settings: expect.objectContaining({ apiKey: OPENAI_KEY }),
      }),
    ]);
  });

  it('keeps a provider the answer reports with the plain EXISTS of a slot', async () => {
    // Only EXISTS_SAME confirms a provider; anything else keeps it.
    const storage = waiting({ providers: { openai: { preset: 'openai', apiKey: OPENAI_KEY } } });
    const fetch = server({
      imported: [],
      skipped: [{ kind: 'provider', id: 'openai', code: 'EXISTS', reason: 'exists' }],
    });
    await runModelSettingsImport({ fetch, storage });
    expect(JSON.stringify(readUnimported(storage))).toContain(OPENAI_KEY);
  });
});

describe('an answer that contradicts itself', () => {
  it('keeps a provider listed as both imported and skipped', async () => {
    const storage = waiting({ providers: { openai: { preset: 'openai', apiKey: OPENAI_KEY } } });
    const fetch = server({
      imported: [{ kind: 'provider', id: 'openai' }],
      skipped: [{ kind: 'provider', id: 'openai', code: 'EXISTS_DIFFERENT', reason: 'other' }],
    });
    expect(await runModelSettingsImport({ fetch, storage })).toBe('imported');
    expect(readUnimported(storage).items).toEqual([
      expect.objectContaining({
        id: 'openai',
        kind: 'provider',
        reason: 'unconfirmed',
        settings: expect.objectContaining({ apiKey: OPENAI_KEY }),
      }),
    ]);
  });

  it('keeps an item skipped twice with different codes, one of them settling', async () => {
    const storage = waiting({
      providers: { openai: { preset: 'openai', apiKey: OPENAI_KEY } },
      slots: { llm: 'openai:gpt-5.6' },
    });
    const fetch = server({
      imported: [],
      skipped: [
        { kind: 'provider', id: 'openai', code: 'EXISTS_DIFFERENT', reason: 'other' },
        { kind: 'provider', id: 'openai', code: 'EXISTS_SAME', reason: 'held' },
        // Repeated with the same outcome: no contradiction.
        { kind: 'slot', id: 'llm', code: 'EXISTS', reason: 'set' },
        { kind: 'slot', id: 'llm', code: 'EXISTS', reason: 'set' },
      ],
    });
    await runModelSettingsImport({ fetch, storage });
    expect(readUnimported(storage).items.map((item) => [item.kind, item.id, item.reason])).toEqual([
      ['provider', 'openai', 'unconfirmed'],
    ]);
  });
});

describe('a provider and a slot of the same id', () => {
  const proposal = {
    providers: { tts: { preset: 'azure-tts', apiKey: AZURE_KEY, baseUrl: 'https://evil.com' } },
    slots: { tts: null },
  };

  it('keeps the refused provider when the slot of its id is imported', async () => {
    const storage = waiting(proposal);
    const fetch = server({
      imported: [{ kind: 'slot', id: 'tts' }],
      skipped: [
        { kind: 'provider', id: 'tts', code: 'INVALID_PROVIDER', reason: 'custom endpoint' },
      ],
    });
    expect(await runModelSettingsImport({ fetch, storage })).toBe('imported');
    expect(readUnimported(storage).items).toEqual([
      expect.objectContaining({
        id: 'tts',
        kind: 'provider',
        reason: 'refused',
        settings: expect.objectContaining({ apiKey: AZURE_KEY }),
      }),
    ]);
  });

  it('keeps the refused slot when the provider of its id is imported', async () => {
    const storage = waiting(proposal);
    const fetch = server({
      imported: [{ kind: 'provider', id: 'tts' }],
      skipped: [{ kind: 'slot', id: 'tts', code: 'INVALID_ASSIGNMENT', reason: 'no' }],
    });
    await runModelSettingsImport({ fetch, storage });
    expect(readUnimported(storage).items).toEqual([
      expect.objectContaining({
        id: 'tts',
        kind: 'slot',
        settings: { preset: '', assignment: null },
      }),
    ]);
    expect(JSON.stringify(readUnimported(storage))).not.toContain(AZURE_KEY);
  });

  it('confirms nothing by an id without its kind', async () => {
    const storage = waiting(proposal);
    const fetch = server({ imported: ['tts', { id: 'tts' }], skipped: [] });
    await runModelSettingsImport({ fetch, storage });
    expect(readUnimported(storage).items.map((item) => [item.kind, item.reason])).toEqual([
      ['provider', 'unconfirmed'],
      ['slot', 'unconfirmed'],
    ]);
  });

  it('keeps and forgets each on its own', () => {
    const storage = new MemoryStorage();
    keepUnimported([item('tts'), item('tts', { kind: 'slot', preset: undefined })], storage);
    keepUnimported(
      [item('tts', { kind: 'slot', preset: undefined, reason: 'unconfirmed' })],
      storage,
    );
    expect(readUnimported(storage).items.map(unimportedKey)).toEqual(['provider:tts', 'slot:tts']);
    forgetUnimported(['slot:tts'], storage);
    expect(readUnimported(storage).items).toEqual([
      expect.objectContaining({
        id: 'tts',
        kind: 'provider',
        settings: expect.objectContaining({ apiKey: AZURE_KEY }),
      }),
    ]);
  });
});

describe('the settings the builder cannot propose', () => {
  it('keeps custom speech services, key pairs and inexpressible custom chat providers', () => {
    const state: LegacyModelSettingsState = {
      providersConfig: {
        'custom-x': {
          name: 'My gateway',
          type: 'openai',
          apiKey: 'sk-no-endpoint',
          isBuiltIn: false,
        },
        'custom-y': {
          name: 'Odd',
          type: 'mystery',
          apiKey: 'sk-odd',
          baseUrl: 'https://odd.example.com',
          isBuiltIn: false,
        },
      },
      ttsProvidersConfig: {
        'custom-tts-1': {
          apiKey: 'sk-custom-tts',
          baseUrl: '',
          customName: 'My voice',
          customDefaultBaseUrl: 'https://tts.example.com',
          modelId: 'v1',
        },
      },
      asrProvidersConfig: { 'custom-asr-1': { apiKey: '', baseUrl: 'https://asr.example.com' } },
      pdfProvidersConfig: {
        alidocmind: { apiKey: '', baseUrl: '', accessKeyId: 'ak-id', accessKeySecret: 'ak-secret' },
      },
    };
    const { proposal, unimportable } = planModelSettingsImport(state);
    expect(proposal).toBeUndefined();
    expect(unimportable).toEqual([
      expect.objectContaining({
        id: 'chat:custom-x',
        name: 'My gateway',
        reason: 'unsupported',
        settings: expect.objectContaining({ apiKey: 'sk-no-endpoint' }),
      }),
      expect.objectContaining({
        id: 'chat:custom-y',
        reason: 'unsupported',
        settings: expect.objectContaining({ apiKey: 'sk-odd', baseUrl: 'https://odd.example.com' }),
      }),
      expect.objectContaining({
        id: 'tts:custom-tts-1',
        capability: 'tts',
        name: 'My voice',
        reason: 'custom-service',
        settings: expect.objectContaining({
          apiKey: 'sk-custom-tts',
          baseUrl: 'https://tts.example.com',
          modelId: 'v1',
        }),
      }),
      expect.objectContaining({ id: 'asr:custom-asr-1', reason: 'custom-service' }),
      expect.objectContaining({
        id: 'document:alidocmind',
        reason: 'key-pair',
        settings: expect.objectContaining({ accessKeyId: 'ak-id', accessKeySecret: 'ak-secret' }),
      }),
    ]);
  });

  it('proposes an Azure Speech provider with its regional endpoint', () => {
    const { proposal, unimportable } = planModelSettingsImport({
      ttsEnabled: true,
      ttsProviderId: 'azure-tts',
      ttsProvidersConfig: { 'azure-tts': { apiKey: AZURE_KEY, baseUrl: AZURE_ENDPOINT } },
    });
    expect(unimportable).toEqual([]);
    expect(proposal).toEqual({
      providers: {
        'azure-tts': { preset: 'azure-tts', apiKey: AZURE_KEY, baseUrl: AZURE_ENDPOINT },
      },
      slots: { tts: 'azure-tts' },
    });
  });
});

const item = (id: string, extra: Partial<UnimportedModelSetting> = {}): UnimportedModelSetting => ({
  id,
  kind: 'provider',
  name: id,
  preset: 'azure-tts',
  reason: 'refused',
  settings: { preset: 'azure-tts', apiKey: AZURE_KEY },
  ...extra,
});

describe('the notice', () => {
  it('is announced once, and again only for new items', () => {
    const storage = new MemoryStorage();
    expect(takeUnimportedNotice(storage)).toBeUndefined();
    keepUnimported([item('a')], storage);
    expect(takeUnimportedNotice(storage)?.map((kept) => kept.id)).toEqual(['a']);
    expect(takeUnimportedNotice(storage)).toBeUndefined();
    // The same item kept again (a second staging) is not news.
    keepUnimported([item('a')], storage);
    expect(takeUnimportedNotice(storage)).toBeUndefined();
    keepUnimported([item('b')], storage);
    expect(takeUnimportedNotice(storage)?.map((kept) => kept.id)).toEqual(['a', 'b']);
  });

  it('raises one toast after the import', () => {
    const storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    try {
      announceUnimportedModelSettings();
      expect(toasts).toHaveLength(0);
      keepUnimported([item('a')], storage);
      announceUnimportedModelSettings();
      announceUnimportedModelSettings();
      expect(toasts).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('drops what was set up again, and nothing else', () => {
    const keyless = (id: string, extra: Partial<UnimportedModelSetting> = {}) =>
      item(id, { settings: { preset: extra.preset ?? 'azure-tts' }, ...extra });
    const items = [
      keyless('azure-tts', { knownProviders: ['openai'] }),
      keyless('kept', { preset: 'qwen-tts', knownProviders: [] }),
      item('tts', { kind: 'slot', preset: undefined, settings: { preset: '', assignment: 'x' } }),
      keyless('tts:custom-tts-1', { preset: undefined, reason: 'custom-service' }),
    ];
    // Nothing new yet: the workspace's providers were known when they were kept.
    expect(settledUnimported(items, view([{ id: 'openai', preset: 'openai' }]))).toEqual([]);
    // A new Azure provider and the slot set: those two leave.
    expect(
      settledUnimported(
        items,
        view(
          [
            { id: 'openai', preset: 'openai' },
            { id: 'azure-tts-2', preset: 'azure-tts', key: { set: false } },
          ],
          ['tts'],
        ),
      ),
    ).toEqual(['provider:azure-tts', 'slot:tts']);
  });

  it('never drops a kept key by itself: only the user discards it', () => {
    // Kept because its endpoint was refused; the user then adds an Azure
    // provider with the regional endpoint, with no key, another key, or one
    // that looks like the kept key. None of these confirms the key.
    const kept = [item('azure-tts', { knownProviders: [] })];
    for (const key of [
      { set: false },
      { set: true, mask: '…0000' },
      { set: true, unreadable: true },
      { set: true, mask: '…6789' },
    ] satisfies ViewKey[]) {
      expect(
        settledUnimported(kept, view([{ id: 'azure-tts-2', preset: 'azure-tts', key }])),
      ).toEqual([]);
    }
    const pair = item('document:alidocmind', {
      preset: 'alidocmind',
      reason: 'key-pair',
      settings: { preset: 'alidocmind', accessKeyId: 'id', accessKeySecret: 'secret' },
    });
    expect(settledUnimported([pair], view([{ id: 'docmind', preset: 'alidocmind' }]))).toEqual([]);
  });

  it('is discarded by the user, and survives clearing the cache until then', () => {
    const storage = new MemoryStorage();
    keepUnimported([item('a')], storage);
    storage.setItem('something-else', '1');
    clearLocalStorageKeepingImportState(storage);
    expect(readUnimported(storage).items).toHaveLength(1);
    discardUnimported(storage);
    expect(storage.getItem(MODEL_SETTINGS_UNIMPORTED_KEY)).toBeNull();
  });
});
