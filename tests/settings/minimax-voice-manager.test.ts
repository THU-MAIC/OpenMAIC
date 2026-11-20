// @vitest-environment jsdom

import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '@/lib/device-storage/database';
import { modelSettingsClient } from '@/lib/model-settings/client';
import type { ServiceEntry } from '@/lib/model-settings/services';
import { useSettingsStore } from '@/lib/store/settings';
import { TTSSettings } from '@/components/settings/tts-settings';
import type { ConfiguredTTSVoice } from '@/lib/audio/types';
import { makeView, withSlots, workspaceProvider } from '../model-settings/fixtures';

const account = vi.hoisted(() => ({
  voices: [] as { id: string; name: string; kind: 'system' | 'clone' | 'designed' }[],
  canDeleteRemote: true,
  loading: false,
  error: null,
  refresh: vi.fn(),
}));
vi.mock('@/lib/audio/use-account-voices', () => ({ useAccountVoices: () => account }));
vi.mock('@/lib/hooks/use-i18n', () => {
  const t = (key: string, values?: Record<string, unknown>) =>
    values ? [key, ...Object.values(values)].join(' ') : key;
  return { useI18n: () => ({ t, locale: 'en-US' }) };
});

const providerId = 'minimax-tts';
const voiceId = 'openmaic-28b05b33-f6f7-49a9-b60c-06561006229a';
const friendlyName = 'Ms. Lin';
const deleteLabel = 'settings.minimaxDeleteRemote';
const unsaveLabel = 'settings.minimaxRemoveLocal';
const fetchRequest = vi.fn<typeof fetch>();
const play = vi.fn(async () => {});
let duration = 10;
let learnerKey = 'anonymous-owner-secret';
let host: HTMLDivElement;
let root: Root;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(async () => {
  duration = 10;
  learnerKey = 'anonymous-owner-secret';
  fetchRequest.mockReset();
  play.mockClear();
  account.voices = [];
  account.loading = false;
  account.canDeleteRemote = true;
  account.refresh.mockReset();
  useSettingsStore.getState().setTTSVoice('female-yujie', providerId);
  await db.voiceProfiles.clear();
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    input === '/api/persistence/learner-key'
      ? Promise.resolve(Response.json({ learnerKey }))
      : fetchRequest(input, init),
  );
  vi.stubGlobal(
    'AudioContext',
    class {
      async decodeAudioData() {
        const length = Math.round(duration * 48_000);
        return {
          duration,
          length,
          sampleRate: 48_000,
          numberOfChannels: 2,
          getChannelData: () => new Float32Array(length),
        };
      }
      async close() {}
    },
  );
  vi.stubGlobal(
    'Audio',
    class {
      play = play;
      pause() {}
    },
  );
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = () => 'blob:preview';
      static revokeObjectURL() {}
    },
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  modelSettingsClient.adopt(null);
  vi.unstubAllGlobals();
});

async function render({
  alias = 'my-minimax',
  active = true,
  keySet = true,
  revision = 1,
  configuredVoices,
}: {
  alias?: string;
  active?: boolean;
  keySet?: boolean;
  revision?: number;
  configuredVoices?: ConfiguredTTSVoice[];
} = {}) {
  const provider = {
    ...workspaceProvider(alias),
    preset: 'minimax',
    key: { set: keySet, mask: '…abcd' },
    voices: configuredVoices,
    capabilities: { tts: { registryId: providerId, models: [] } },
  };
  const entry: ServiceEntry = { id: alias, registryId: providerId, state: 'workspace', provider };
  const base = makeView({ providers: [provider], revision });
  const view = active
    ? withSlots(base, {
        tts: {
          effective: {
            status: 'assigned',
            resolvedAt: 'tts',
            source: 'workspace',
            requirements: [],
            providerSource: 'workspace',
            providerId: alias,
            presetId: 'minimax',
            registryId: providerId,
            voices: configuredVoices,
          },
        },
      })
    : base;
  await act(async () => {
    modelSettingsClient.adopt(view);
    root.render(createElement(TTSSettings, { entry, view, apply: vi.fn() }));
  });
}

const buttons = (scope: ParentNode = host) => [...scope.querySelectorAll('button')];
function button(label: string, scope: ParentNode = host) {
  const match = buttons(scope).find(
    (node) => node.getAttribute('aria-label') === label || node.textContent === label,
  );
  expect(match, label).toBeDefined();
  return match!;
}
function row(name: string) {
  const match = [...host.querySelectorAll('li')].find((node) => node.textContent?.includes(name));
  expect(match, name).toBeDefined();
  return match!;
}
async function click(label: string, scope: ParentNode = host) {
  await act(async () => button(label, scope).click());
}
async function openVoiceMenu(voiceRow: HTMLElement) {
  await act(async () => {
    button('settings.more', voiceRow).dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
    );
  });
  const menu = document.querySelector<HTMLElement>('[role=menu]');
  expect(menu).not.toBeNull();
  return menu!;
}
async function chooseVoiceAction(label: string, voiceRow: HTMLElement) {
  const menu = await openVoiceMenu(voiceRow);
  const item = [...menu.querySelectorAll<HTMLElement>('[role=menuitem]')].find(
    (element) => element.textContent === label,
  );
  expect(item, label).toBeDefined();
  await act(async () => item!.click());
}
async function waitForUI(check: () => void) {
  const deadline = Date.now() + 3000;
  while (true) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
  }
}
async function createVoice() {
  await waitForUI(() => {
    expect(host.querySelector<HTMLInputElement>('input[type=file]')?.disabled).toBe(false);
  });
  const file = host.querySelector<HTMLInputElement>('input[type=file]')!;
  const name = host.querySelector<HTMLInputElement>('#minimax-voice-name')!;
  await act(async () => {
    Object.defineProperty(file, 'files', {
      configurable: true,
      value: [new File(['clip'], 'class.m4a')],
    });
    file!.dispatchEvent(new Event('change', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      name,
      friendlyName,
    );
    name.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitForUI(() => expect(button('settings.voxcpmAddClone').disabled).toBe(false));
  await click('settings.voxcpmAddClone');
}
function registered() {
  return Response.json({ success: true, providerId, voiceId });
}
function dialog() {
  const element = document.querySelector<HTMLElement>('[role=alertdialog]');
  expect(element).not.toBeNull();
  return element!;
}

it('shows the manager only for the active configured MiniMax service and lists only custom voices', async () => {
  account.voices = [
    { id: 'public', name: 'Public system voice', kind: 'system' },
    { id: 'custom', name: 'Private designed voice', kind: 'designed' },
  ];
  await render({ active: false });
  expect(host.querySelector('input[type=file]')).toBeNull();
  await render({ keySet: false });
  expect(host.querySelector('input[type=file]')).toBeNull();
  await render();
  expect(host.querySelector('input[type=file]')).not.toBeNull();
  expect(host.textContent).not.toContain('Public system voice');
  expect(row('Private designed voice').textContent).toContain('Private designed voice');
  expect(fetchRequest).not.toHaveBeenCalled();
});

it('saves the returned ID with the typed name and previews it only when requested', async () => {
  fetchRequest.mockResolvedValueOnce(registered());
  await render();
  await createVoice();
  await waitForUI(() => row(friendlyName));
  const profile = await db.voiceProfiles.get(voiceId);
  expect(profile).toMatchObject({ id: voiceId, providerId, name: friendlyName, kind: 'clone' });
  expect(JSON.stringify(profile)).not.toContain('anonymous-owner-secret');
  const [path, init] = fetchRequest.mock.calls[0];
  expect(path).toBe('/api/generate/voice');
  const wire = JSON.parse(String(init?.body));
  expect(wire).toMatchObject({
    expectedProviderId: providerId,
    expectedServiceId: 'my-minimax',
    expectedRevision: 1,
  });
  const wav = Buffer.from(wire.referenceAudioBase64, 'base64');
  expect(wav.readUInt16LE(22)).toBe(1);
  expect(wav.readUInt32LE(24)).toBe(24_000);
  expect(wav.readUInt32LE(40)).toBe(10 * 24_000 * 2);
  expect(fetchRequest).toHaveBeenCalledTimes(1);
  expect(useSettingsStore.getState().ttsVoice).toBe('female-yujie');

  await click('settings.serverConfig.useForNarration', row(friendlyName));
  expect(useSettingsStore.getState().ttsVoice).toBe(voiceId);
  expect(fetchRequest).toHaveBeenCalledTimes(1);
  fetchRequest.mockResolvedValueOnce(Response.json({ base64: 'AQI=', format: 'mp3' }));
  account.refresh.mockImplementationOnce(() => {
    account.voices = [{ id: voiceId, name: 'Cloud name', kind: 'clone' }];
  });
  await click('settings.voxcpmPreviewVoice', row(friendlyName));
  expect(fetchRequest.mock.calls[1]?.[0]).toBe('/api/generate/tts');
  expect(JSON.parse(String(fetchRequest.mock.calls[1]?.[1]?.body))).toMatchObject({
    ttsVoice: voiceId,
  });

  await render();
  expect(host.querySelectorAll('li')).toHaveLength(1);
  await chooseVoiceAction(unsaveLabel, row(friendlyName));
  await waitForUI(() => row('Cloud name'));
  expect(await db.voiceProfiles.get(voiceId)).toBeUndefined();
  expect(useSettingsStore.getState().ttsVoice).toBe(voiceId);
  expect(fetchRequest).toHaveBeenCalledTimes(2);
  const cloudMenu = await openVoiceMenu(row('Cloud name'));
  expect(cloudMenu.textContent).not.toContain(unsaveLabel);
  expect(cloudMenu.textContent).toContain(deleteLabel);
});

it('rejects a sub-ten-second upload before enrollment', async () => {
  duration = 9.99;
  await render();
  await createVoice();
  await waitForUI(() => expect(host.querySelector('[role=alert]')?.textContent).toContain('10'));
  expect(fetchRequest).not.toHaveBeenCalled();
  expect(await db.voiceProfiles.count()).toBe(0);
});

it.each([
  {
    result: 'clears the preference for a pending clone',
    configuredVoices: undefined,
    expectedVoice: '',
  },
  {
    result: 'keeps a configured voice selected',
    configuredVoices: [
      { id: 'female-yujie', name: 'Default voice' },
      { id: voiceId, name: 'Classroom narrator' },
    ],
    expectedVoice: voiceId,
  },
])('removing a local label $result', async ({ configuredVoices, expectedVoice }) => {
  fetchRequest.mockResolvedValueOnce(registered());
  await render({ configuredVoices });
  await createVoice();
  await waitForUI(() => row(friendlyName));
  await click('settings.serverConfig.useForNarration', row(friendlyName));
  expect(useSettingsStore.getState().ttsVoice).toBe(voiceId);

  await chooseVoiceAction(unsaveLabel, row(friendlyName));
  await waitForUI(() => expect(host.textContent).not.toContain(friendlyName));
  expect(await db.voiceProfiles.get(voiceId)).toBeUndefined();
  expect(useSettingsStore.getState().ttsVoice).toBe(expectedVoice);
  expect(fetchRequest).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  'keeps a voice activated by another classroom when removing its local label (initial list loading: %s)',
  async (loading) => {
    fetchRequest.mockResolvedValueOnce(registered());
    await render();
    await createVoice();
    await waitForUI(() => row(friendlyName));
    await click('settings.serverConfig.useForNarration', row(friendlyName));
    expect(account.voices).toEqual([]);
    account.loading = loading;
    account.canDeleteRemote = !loading;
    await render();
    account.refresh.mockResolvedValueOnce([{ id: voiceId, name: 'Cloud narrator', kind: 'clone' }]);
    await chooseVoiceAction(unsaveLabel, row(friendlyName));
    await waitForUI(() => expect(host.textContent).not.toContain(friendlyName));
    expect(await db.voiceProfiles.get(voiceId)).toBeUndefined();
    expect(useSettingsStore.getState().ttsVoice).toBe(voiceId);
  },
);

it('confirms account deletion of a pending clone, keeps the local voice on refusal, and gates shared accounts', async () => {
  fetchRequest.mockResolvedValueOnce(registered());
  await render();
  await createVoice();
  await waitForUI(() => row(friendlyName));
  await click('settings.serverConfig.useForNarration', row(friendlyName));
  await chooseVoiceAction(deleteLabel, row(friendlyName));
  expect(dialog().textContent).toContain(friendlyName);
  await click('common.cancel', dialog());
  expect(fetchRequest).toHaveBeenCalledTimes(1);

  fetchRequest.mockResolvedValueOnce(
    Response.json({ error: 'MiniMax refused this deletion' }, { status: 403 }),
  );
  await chooseVoiceAction(deleteLabel, row(friendlyName));
  await click(deleteLabel, dialog());
  await waitForUI(() =>
    expect(host.querySelector('[role=alert]')?.textContent).toContain(
      'MiniMax refused this deletion',
    ),
  );
  expect(await db.voiceProfiles.get(voiceId)).toBeDefined();
  expect(useSettingsStore.getState().ttsVoice).toBe(voiceId);
  const [path, init] = fetchRequest.mock.calls[1];
  expect(path).toBe('/api/generate/voice');
  expect(init?.method).toBe('DELETE');
  expect(JSON.parse(String(init?.body))).toMatchObject({
    providerId,
    expectedServiceId: 'my-minimax',
    expectedRevision: 1,
    voiceId,
    kind: 'clone',
  });

  await chooseVoiceAction(deleteLabel, row(friendlyName));
  account.canDeleteRemote = false;
  await render({ revision: 2 });
  expect(document.querySelector('[role=alertdialog]')).toBeNull();
  await waitForUI(() => row(friendlyName));
  const sharedMenu = await openVoiceMenu(row(friendlyName));
  expect(sharedMenu.textContent).not.toContain(deleteLabel);
  expect(sharedMenu.textContent).toContain(unsaveLabel);
  expect(fetchRequest).toHaveBeenCalledTimes(2);
});

it('preserves a newer narration selection when deletion of a designed cloud voice finishes', async () => {
  account.voices = [{ id: 'designed-id', name: 'Narrator', kind: 'designed' }];
  await render();
  await click('settings.serverConfig.useForNarration', row('Narrator'));
  let finish!: (value: Response) => void;
  fetchRequest.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await chooseVoiceAction(deleteLabel, row('Narrator'));
  await click(deleteLabel, dialog());
  expect(JSON.parse(String(fetchRequest.mock.calls[0]?.[1]?.body))).toMatchObject({
    voiceId: 'designed-id',
    kind: 'designed',
  });
  await act(async () => {
    useSettingsStore.getState().setTTSVoice('second-choice', providerId);
    finish(Response.json({ success: true, vendorDeleted: true }));
  });
  expect(useSettingsStore.getState().ttsVoice).toBe('second-choice');
  expect(account.refresh).toHaveBeenCalled();
});

it('retains a pending clone until MiniMax confirms deletion, then clears its selected ID', async () => {
  fetchRequest.mockResolvedValueOnce(registered());
  await render();
  await createVoice();
  await waitForUI(() => row(friendlyName));
  await click('settings.serverConfig.useForNarration', row(friendlyName));
  fetchRequest.mockResolvedValueOnce(Response.json({ success: true, vendorDeleted: false }));
  await chooseVoiceAction(deleteLabel, row(friendlyName));
  await click(deleteLabel, dialog());
  await waitForUI(() =>
    expect(host.querySelector('[role=alert]')?.textContent).toContain(
      'settings.minimaxDeleteFailed',
    ),
  );
  expect(await db.voiceProfiles.get(voiceId)).toBeDefined();
  expect(useSettingsStore.getState().ttsVoice).toBe(voiceId);

  fetchRequest.mockResolvedValueOnce(Response.json({ success: true, vendorDeleted: true }));
  await chooseVoiceAction(deleteLabel, row(friendlyName));
  await click(deleteLabel, dialog());
  await waitForUI(() => expect(host.textContent).not.toContain(friendlyName));
  expect(await db.voiceProfiles.get(voiceId)).toBeUndefined();
  expect(useSettingsStore.getState().ttsVoice).not.toBe(voiceId);
});

it('keeps a late enrollment with the original account when the active MiniMax alias changes', async () => {
  let finish!: (value: Response) => void;
  fetchRequest.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await createVoice();
  await waitForUI(() => expect(fetchRequest).toHaveBeenCalledTimes(1));
  await render({ alias: 'second-minimax' });
  await act(async () => finish(registered()));
  await act(async () => {
    await vi.waitFor(async () => expect(await db.voiceProfiles.get(voiceId)).toBeDefined());
  });
  await render({ alias: 'second-minimax', revision: 2 });
  expect(host.textContent).not.toContain(friendlyName);
  expect(useSettingsStore.getState().ttsVoice).toBe('female-yujie');
  await render({ revision: 3 });
  await waitForUI(() => row(friendlyName));
});

it('hides saved voices and dismisses deletion when the browser signs into another owner with the same service', async () => {
  fetchRequest.mockResolvedValueOnce(registered());
  await render();
  await createVoice();
  await waitForUI(() => row(friendlyName));
  let finish!: (response: Response) => void;
  fetchRequest.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click('settings.voxcpmPreviewVoice', row(friendlyName));
  await chooseVoiceAction(deleteLabel, row(friendlyName));
  expect(dialog().textContent).toContain(friendlyName);

  learnerKey = 'second-owner';
  await act(async () => {
    window.dispatchEvent(new Event('auth-change'));
  });
  await waitForUI(() => expect(host.textContent).not.toContain(friendlyName));
  expect(document.querySelector('[role=alertdialog]')).toBeNull();
  expect(await db.voiceProfiles.get(voiceId)).toBeDefined();
  expect(fetchRequest).toHaveBeenCalledTimes(2);
  await act(async () => finish(Response.json({ base64: 'AQI=', format: 'mp3' })));
  expect(play).not.toHaveBeenCalled();

  learnerKey = 'anonymous-owner-secret';
  await act(async () => {
    window.dispatchEvent(new Event('auth-change'));
  });
  await waitForUI(() => row(friendlyName));
});
