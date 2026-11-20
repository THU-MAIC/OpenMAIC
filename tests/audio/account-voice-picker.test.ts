// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useSlotTTSProvidersConfig, useTTSSelection } from '@/lib/audio/use-tts-selection';
import { ttsSelection } from '@/lib/audio/tts-selection';
import { useAccountVoices } from '@/lib/audio/use-account-voices';
import { voiceAccountFor } from '@/lib/audio/voice-account';
import { getSelectableProvidersWithVoices } from '@/lib/audio/voice-resolver';
import type { VoiceProfileRecord } from '@/lib/device-storage/database';
import { modelSettingsClient } from '@/lib/model-settings/client';
import { useSettingsStore } from '@/lib/store/settings';
import { modelSettingsViewFor } from '../helpers/model-settings-view';

const owner = vi.hoisted(() => ({ key: 'test-owner-A' }));
const readProfile = vi.hoisted(() =>
  vi.fn<(id: string) => Promise<VoiceProfileRecord | undefined>>(),
);
vi.mock('@/lib/device-storage/database', () => ({ db: { voiceProfiles: { get: readProfile } } }));
vi.mock('@/lib/device-storage/owner-key', () => ({
  deviceOwnerKey: () => Promise.resolve(owner.key),
  knownDeviceOwnerKey: () => owner.key,
}));

const url =
  '/api/generate/voice?providerId=minimax-tts&expectedServiceId=narration&expectedRevision=1';
const clone = 'openmaic-12345678-1234-4123-8123-0123456789ab';
let root: Root | undefined;

function settings(
  revision: number,
  { managed = false, configured = false, key = true, serviceId = 'narration' } = {},
) {
  const view = modelSettingsViewFor({ tts: { registryId: 'minimax-tts', providerId: serviceId } });
  view.revision = revision;
  const tts = view.slots.find((slot) => slot.slot === 'tts')!.effective;
  if (tts.status !== 'assigned') throw new Error('expected tts');
  tts.providerSource = managed ? 'deployment' : 'workspace';
  if (configured) tts.voices = [{ id: 'curated', name: 'Curated' }];
  view.providers.push({
    id: serviceId,
    preset: 'minimax-tts',
    presetName: 'MiniMax',
    presetKind: 'single',
    source: tts.providerSource,
    key: { set: key },
    capabilities: { tts: { models: [] } },
  });
  return view;
}

function Pickers() {
  const config = useSlotTTSProvidersConfig();
  const selection = useTTSSelection();
  const account = useAccountVoices();
  const [provider] = getSelectableProvidersWithVoices(config);
  return createElement(
    'div',
    {
      'data-voice': selection?.voice,
      'data-delete': account.canDeleteRemote,
      'data-account': account.voices.map((voice) => voice.id).join(','),
    },
    provider?.voices.map((voice) => voice.id).join(','),
  );
}

function mount(
  content: ReactNode = createElement('div', null, createElement(Pickers), createElement(Pickers)),
) {
  const host = document.createElement('div');
  const mounted = createRoot(host);
  root = mounted;
  act(() => mounted.render(content));
  return host;
}

function json(body: unknown): Response {
  return Object.assign(new Response(), { json: async () => body });
}

function reply(id: string) {
  return json({
    success: true,
    voices: [{ id, name: id, kind: 'clone' }],
    canDeleteRemote: true,
  });
}

function savedClone(accountScope: string): VoiceProfileRecord {
  return {
    id: clone,
    name: 'Saved clone',
    providerId: 'minimax-tts',
    accountScope,
    kind: 'clone',
    createdAt: 0,
    updatedAt: 0,
  };
}

beforeEach(() => {
  owner.key = 'test-owner-A';
  readProfile.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  modelSettingsClient.adopt(null);
  useSettingsStore.getState().setTTSVoice('default', '');
  vi.unstubAllGlobals();
});

it('shares an account list across pickers, keeps the default, and drops late responses after a key change', async () => {
  const answers: Array<(response: Response) => void> = [];
  const fetch = vi.fn(
    (_input: string) => new Promise<Response>((resolve) => answers.push(resolve)),
  );
  vi.stubGlobal('fetch', fetch);
  modelSettingsClient.adopt(settings(1));
  const host = mount();
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([url]);
  act(() => modelSettingsClient.adopt(settings(2)));
  expect(answers).toHaveLength(2);
  await act(async () => answers[1](reply('new-account')));
  expect(host.textContent).toContain('new-account');
  expect(host.querySelector('[data-voice]')?.getAttribute('data-voice')).toBe('female-yujie');
  await act(async () => answers[0](reply('old-account')));
  expect(host.textContent).not.toContain('old-account');
  expect(host.textContent).toContain('new-account');
});

it.each([
  { status: 200, visible: 'refreshed-voice' },
  { status: 503, visible: 'playing-voice' },
  { status: 403, visible: '' },
  { status: 409, visible: '' },
])(
  'keeps playback controls while refreshing and reconciles the catalogue on HTTP $status',
  async ({ status, visible }) => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(reply('playing-voice'));
    fetch.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    vi.stubGlobal('fetch', fetch);
    modelSettingsClient.adopt(settings(1));
    function VoiceList() {
      const { voices, refresh } = useAccountVoices();
      return createElement(
        'button',
        { onClick: () => void refresh() },
        voices.map((v) => v.id).join(','),
      );
    }
    const host = mount(createElement(VoiceList));
    await act(async () => {});
    expect(host.textContent).toBe('playing-voice');
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toBe('playing-voice');
    const response = status === 200 ? reply('refreshed-voice') : new Response(null, { status });
    await act(async () => finish(response));
    expect(host.textContent).toBe(visible);
  },
);

it('forgets voices on sign-in even when the incoming owner uses the same provider and revision', async () => {
  const view = settings(1);
  modelSettingsClient.adopt(view);
  let finish!: (response: Response) => void;
  let owner = 'previous-owner';
  const fetch = vi.fn((input: string) => {
    if (input !== url) return Promise.resolve(json(view));
    if (owner === 'previous-owner') return Promise.resolve(reply(owner));
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  vi.stubGlobal('fetch', fetch);
  const host = mount();
  await act(async () => {});
  expect(host.textContent).toContain('previous-owner');
  owner = 'new-owner';
  await act(async () => {
    window.dispatchEvent(new Event('auth-change'));
  });
  expect(host.textContent).not.toContain('previous-owner');
  await act(async () => finish(reply(owner)));
  expect(host.textContent).toContain('new-owner');
});

it('asks only for the new service when an old preview refreshes after a switch', async () => {
  const fetch = vi.fn(async (_input: string) => reply('studio'));
  vi.stubGlobal('fetch', fetch);
  modelSettingsClient.adopt(settings(1));
  function SwitchService() {
    const { refresh } = useAccountVoices();
    return createElement('button', {
      onClick() {
        modelSettingsClient.adopt(settings(1, { serviceId: 'personal' }));
        void refresh();
      },
    });
  }
  const host = mount(createElement(SwitchService));
  await act(async () => host.querySelector('button')!.click());
  expect(fetch.mock.calls.map(([input]) => input)).toEqual([
    url,
    '/api/generate/voice?providerId=minimax-tts&expectedServiceId=personal&expectedRevision=1',
  ]);
});

it('keeps a private preference with its MiniMax service while compatible presets follow the slot', () => {
  const first = settings(1);
  const other = settings(2, { serviceId: 'other-service' });
  const pick = (voice: string) => useSettingsStore.getState().setTTSVoice(voice, 'minimax-tts');
  modelSettingsClient.adopt(first);
  pick('private-studio');
  expect(ttsSelection()?.voice).toBe('private-studio');
  modelSettingsClient.adopt(other);
  expect(ttsSelection()?.voice).toBe('female-yujie');
  modelSettingsClient.adopt(first);
  expect(ttsSelection()?.voice).toBe('private-studio');
  pick('female-shaonv');
  modelSettingsClient.adopt(other);
  expect(ttsSelection()?.voice).toBe('female-shaonv');
});

it('falls back for a missing discovered voice after a key change, preserving a pending local clone', async () => {
  const fetch = vi.fn(async () => reply('old-studio'));
  vi.stubGlobal('fetch', fetch);
  modelSettingsClient.adopt(settings(1));
  const host = mount();
  await act(async () => {});
  act(() => {
    useSettingsStore.getState().setTTSVoice('old-studio', 'minimax-tts');
  });
  fetch.mockImplementation(async () => reply('new-studio'));
  await act(async () => modelSettingsClient.adopt(settings(2)));
  expect(host.querySelector('[data-voice]')?.getAttribute('data-voice')).toBe('female-yujie');
  expect(ttsSelection()?.voice).toBe('female-yujie');
  expect(useSettingsStore.getState().ttsVoice).toBe('old-studio');
  fetch.mockImplementation(async () => reply('old-studio'));
  await act(async () => modelSettingsClient.adopt(settings(3)));
  expect(ttsSelection()?.voice).toBe('old-studio');

  act(() => {
    useSettingsStore.getState().setTTSVoice(clone, 'minimax-tts');
  });
  readProfile.mockResolvedValue(savedClone(useSettingsStore.getState().ttsVoiceAccount!));
  await act(async () => modelSettingsClient.adopt(settings(4)));
  expect(readProfile).toHaveBeenCalledWith(clone);
  expect(ttsSelection()?.voice).toBe(clone);
});

it.each(['cloud only', 'another owner', 'another service'] as const)(
  'falls back when a removed OpenMAIC clone was saved for %s',
  async (location) => {
    const current = settings(1);
    modelSettingsClient.adopt(current);
    const fetch = vi.fn(async () => reply(clone));
    vi.stubGlobal('fetch', fetch);
    const host = mount();
    await act(async () => {});
    act(() => useSettingsStore.getState().setTTSVoice(clone, 'minimax-tts'));
    expect(ttsSelection()?.voice).toBe(clone);
    if (location !== 'cloud only') {
      const other = settings(1, {
        serviceId: location === 'another service' ? 'other' : 'narration',
      });
      owner.key = location === 'another owner' ? 'test-owner-B' : 'test-owner-A';
      readProfile.mockResolvedValue(savedClone(voiceAccountFor(other)!.scope!));
      owner.key = 'test-owner-A';
    }
    fetch.mockImplementation(async () => reply('still-available'));
    await act(async () => modelSettingsClient.adopt(settings(2)));
    expect(host.querySelector('[data-voice]')?.getAttribute('data-voice')).toBe('female-yujie');
    expect(ttsSelection()?.voice).toBe('female-yujie');
  },
);

it('discards a pending local profile read after the user changes services', async () => {
  const previous = settings(1);
  modelSettingsClient.adopt(previous);
  useSettingsStore.getState().setTTSVoice(clone, 'minimax-tts');
  let complete!: (row: VoiceProfileRecord | undefined) => void;
  readProfile.mockImplementationOnce(() => new Promise((resolve) => (complete = resolve)));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => reply(input === url ? 'previous' : 'new')),
  );
  const host = mount();
  await act(async () => {});
  expect(readProfile).toHaveBeenCalledWith(clone);
  await act(async () => modelSettingsClient.adopt(settings(2, { serviceId: 'other' })));
  await act(async () => complete(undefined));
  expect(voiceAccountFor(previous)?.missingVoice).toBeUndefined();
  expect(host.querySelector('[data-account]')?.getAttribute('data-account')).toBe('new');
});

it('exposes personal deletion permission alongside an explicit catalogue without exposing discovered rows', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply('remote-voice')),
  );
  modelSettingsClient.adopt(settings(1, { configured: true }));
  const host = mount();
  await act(async () => {});
  expect(host.querySelector('[data-delete=true]')?.getAttribute('data-account')).toBe('');
  expect(host.textContent).toContain('curated');
  expect(host.textContent).not.toContain('remote-voice');
});

it.each([{ managed: true }, { key: false }])(
  'leaves enumeration off for an ineligible provider (%j)',
  (options) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    modelSettingsClient.adopt(settings(1, options));
    const host = mount();
    expect(fetch).not.toHaveBeenCalled();
    expect(host.textContent).toContain('female-yujie');
  },
);

it('does not look up the active account while showing another service', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  modelSettingsClient.adopt(settings(1));
  function InactiveService() {
    useAccountVoices(false);
    return null;
  }
  mount(createElement('div', null, createElement(InactiveService)));
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps watching sign-in while an inactive settings panel unmounts', async () => {
  const view = settings(1);
  modelSettingsClient.adopt(view);
  let id = 'before-sign-in';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => (input === url ? reply(id) : json(view))),
  );
  function InactiveReader() {
    useAccountVoices(false);
    return null;
  }
  const host = mount(
    createElement('div', null, createElement(Pickers), createElement(InactiveReader)),
  );
  await act(async () => {});
  act(() => root!.render(createElement('div', null, createElement(Pickers))));
  id = 'after-sign-in';
  await act(async () => {
    window.dispatchEvent(new Event('auth-change'));
  });
  expect(host.textContent).toContain('after-sign-in');
  expect(host.textContent).not.toContain('before-sign-in');
});

it('does not apply another signed-in owner’s pending local preference on the same shared service', async () => {
  const view = settings(1, { managed: true });
  modelSettingsClient.adopt(view);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(view)),
  );
  const host = mount();
  const pending = 'openmaic-12345678-1234-4123-8123-0123456789ab';
  act(() => {
    useSettingsStore.getState().setTTSVoice(pending, 'minimax-tts');
  });
  expect(ttsSelection()?.voice).toBe(pending);
  owner.key = 'test-owner-B';
  await act(async () => {
    window.dispatchEvent(new Event('auth-change'));
  });
  expect(ttsSelection()?.voice).toBe('female-yujie');
  expect(host.querySelector('[data-voice]')?.getAttribute('data-voice')).toBe('female-yujie');
  expect(useSettingsStore.getState().ttsVoice).toBe(pending);
});
