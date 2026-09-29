/**
 * Posting the browser's model settings to the owner the browser is bound to
 * (lib/legacy-browser-import/model-settings-import.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { LEDGER_KEY, loadLedger } from '@/lib/legacy-browser-import/ledger';
import {
  MODEL_SETTINGS_IMPORT_ENDPOINT,
  MODEL_SETTINGS_IMPORT_KEY,
} from '@/lib/legacy-browser-import/model-settings';
import { runModelSettingsImport } from '@/lib/legacy-browser-import/model-settings-import';
import { BINDING_ENDPOINT, LEGACY_IMPORT_HEADER } from '@/lib/legacy-browser-import/protocol';

import { MemoryStorage } from './harness';

const SECRET = 'sk-browser-secret-0123456789';
const consoleSpies: Mock[] = [];

beforeEach(() => {
  for (const method of ['warn', 'error', 'log', 'info', 'debug'] as const) {
    consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => {}) as unknown as Mock);
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  consoleSpies.length = 0;
});

function consoleOutput(): string {
  return JSON.stringify(
    consoleSpies.flatMap((spy) => spy.mock.calls),
    (_key, value) => (value instanceof Error ? `${value.name}: ${value.message}` : value),
  );
}

function waiting() {
  const storage = new MemoryStorage();
  storage.setItem(
    MODEL_SETTINGS_IMPORT_KEY,
    JSON.stringify({ providers: { openai: { preset: 'openai', apiKey: SECRET } } }),
  );
  return storage;
}

/** A server: the binding answers `bound`, the import answers `importStatus`. */
function server(options: {
  bound?: boolean;
  bindStatus?: number;
  importStatus?: number;
  importBody?: unknown;
}) {
  return vi.fn(async (input: string) => {
    if (input === BINDING_ENDPOINT) {
      const status = options.bindStatus ?? 200;
      return status === 200
        ? Response.json({ bound: options.bound ?? true })
        : Response.json({ error: { code: 'OWNER_NOT_ESTABLISHED' } }, { status });
    }
    if (input === MODEL_SETTINGS_IMPORT_ENDPOINT) {
      return Response.json(options.importBody ?? { imported: ['openai'], skipped: [] }, {
        status: options.importStatus ?? 200,
      });
    }
    throw new Error(`unexpected request to ${input}`);
  });
}

describe('runModelSettingsImport', () => {
  it('does nothing when no proposal is waiting', async () => {
    const fetch = vi.fn();
    expect(await runModelSettingsImport({ fetch, storage: new MemoryStorage() })).toBe('none');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('binds the browser, posts the proposal fenced by its id, and clears it on success', async () => {
    const storage = waiting();
    const fetch = server({
      importBody: { imported: [], skipped: [{ item: 'openai', reason: `exists ${SECRET}` }] },
    });
    expect(await runModelSettingsImport({ fetch, storage })).toBe('imported');

    const browserId = loadLedger(storage)!.browserId;
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      BINDING_ENDPOINT,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ browserId }) }),
    );
    const [, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ [LEGACY_IMPORT_HEADER]: browserId });
    expect(JSON.parse(String(init.body))).toEqual({
      providers: { openai: { preset: 'openai', apiKey: SECRET } },
    });
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
    // Only the skipped item's id is logged, never a reason.
    expect(consoleOutput()).toContain('openai');
    expect(consoleOutput()).not.toContain(SECRET);
  });

  it('keeps its completion apart from the course import', async () => {
    const storage = waiting();
    await runModelSettingsImport({ fetch: server({}), storage });
    expect(loadLedger(storage)?.completedAt).toBeUndefined();
    expect(storage.getItem(LEDGER_KEY)).not.toBeNull();
  });

  it('keeps the proposal and sends nothing when another owner holds the browser', async () => {
    const storage = waiting();
    const fetch = server({ bound: false });
    expect(await runModelSettingsImport({ fetch, storage })).toBe('kept');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).not.toBeNull();
  });

  it('keeps the proposal when the binding cannot be asked for yet', async () => {
    const storage = waiting();
    const fetch = server({ bindStatus: 409 });
    expect(await runModelSettingsImport({ fetch, storage })).toBe('kept');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).not.toBeNull();
  });

  it('keeps the proposal when the owner no longer holds the binding (409)', async () => {
    const storage = waiting();
    const fetch = server({
      importStatus: 409,
      importBody: { error: { code: 'LEGACY_IMPORT_NOT_BOUND' } },
    });
    expect(await runModelSettingsImport({ fetch, storage })).toBe('kept');
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).not.toBeNull();
  });

  it.each([401, 404, 500, 503])('keeps the proposal on HTTP %i', async (status) => {
    const storage = waiting();
    expect(await runModelSettingsImport({ fetch: server({ importStatus: status }), storage })).toBe(
      'kept',
    );
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).not.toBeNull();
  });

  it('keeps the proposal on a network error, without logging its message', async () => {
    const storage = waiting();
    const fetch = vi.fn(async (input: string) => {
      if (input === BINDING_ENDPOINT) return Response.json({ bound: true });
      throw new TypeError(`network failure sending ${SECRET}`);
    });
    expect(await runModelSettingsImport({ fetch, storage })).toBe('kept');
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).not.toBeNull();
    expect(consoleOutput()).not.toContain(SECRET);
  });

  it('drops a proposal the server refuses (400)', async () => {
    const storage = waiting();
    expect(await runModelSettingsImport({ fetch: server({ importStatus: 400 }), storage })).toBe(
      'dropped',
    );
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
  });

  it('drops an unreadable proposal without sending it or logging its text', async () => {
    const storage = new MemoryStorage();
    storage.setItem(MODEL_SETTINGS_IMPORT_KEY, `{"providers":{"openai":{"apiKey":"${SECRET}"`);
    const fetch = vi.fn();
    expect(await runModelSettingsImport({ fetch, storage })).toBe('dropped');
    expect(fetch).not.toHaveBeenCalled();
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
    expect(consoleOutput()).not.toContain(SECRET);
    expect(consoleOutput()).toContain('[legacy-browser-import]');
  });
});
