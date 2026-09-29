// @vitest-environment jsdom
/** The view the one-time import answered wins over an older read still in flight. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { importLegacyModelSettings } from '@/components/model-settings-init';
import { MODEL_SETTINGS_IMPORT_KEY } from '@/lib/legacy-browser-import/model-settings';
import { BINDING_ENDPOINT } from '@/lib/legacy-browser-import/protocol';
import { adoptNewerView } from '@/lib/model-settings/adopt-newer-view';
import { createModelSettingsClient } from '@/lib/model-settings/client';

import { modelSettingsViewFor } from '../helpers/model-settings-view';

const before = () => modelSettingsViewFor({}); // revision null: nothing stored yet
const imported = () => {
  const view = modelSettingsViewFor({ llm: { registryId: 'openai', modelId: 'gpt-5' } });
  view.revision = 1;
  return view;
};

/** A client whose first read is held until `release()`; later reads answer `later`. */
function clientWithSlowFirstRead(later = imported()) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const fetch = vi.fn(async () => {
    reads += 1;
    if (reads === 1) {
      await held;
      return Response.json(before());
    }
    return Response.json(later);
  });
  return { client: createModelSettingsClient(fetch), release, fetch };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('adoptNewerView', () => {
  it('keeps the adopted view when an older read lands after it', async () => {
    const { client, release } = clientWithSlowFirstRead();
    const firstRead = client.load();
    const settling = adoptNewerView(client, imported());
    release();
    await Promise.all([firstRead, settling]);
    expect(client.getState().view?.revision).toBe(1);
    expect(
      client.getState().view?.slots.find((slot) => slot.slot === 'llm')?.effective,
    ).toMatchObject({ status: 'assigned', modelId: 'gpt-5' });
  });

  it('keeps a newer read over the adopted view', async () => {
    const newer = imported();
    newer.revision = 2;
    const client = createModelSettingsClient(async () => Response.json(newer));
    await adoptNewerView(client, imported());
    expect(client.getState().view?.revision).toBe(2);
  });
});

describe('importLegacyModelSettings', () => {
  it("shows the import's view even while the page's first read is still in flight", async () => {
    localStorage.setItem(
      MODEL_SETTINGS_IMPORT_KEY,
      JSON.stringify({ providers: { openai: { preset: 'openai', apiKey: 'sk' } } }),
    );
    const view = imported();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input === BINDING_ENDPOINT) return Response.json({ bound: true });
        return Response.json({ imported: ['openai'], skipped: [], view });
      }),
    );
    const { client, release } = clientWithSlowFirstRead(before());
    const firstRead = client.load();
    const importing = importLegacyModelSettings(client);
    // The import finishes while the first read is held, then the read lands.
    await vi.waitFor(() => expect(localStorage.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull());
    release();
    await Promise.all([firstRead, importing]);
    expect(client.getState().view?.revision).toBe(1);
  });
});
