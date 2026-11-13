// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import enUS from '@/lib/i18n/locales/en-US.json';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  toastError: vi.fn(),
  setTTSVoice: vi.fn(),
  deleteVoice: vi.fn(),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    locale: 'en-US',
    t: (key: string) =>
      enUS.settings[key.replace('settings.', '') as keyof typeof enUS.settings] ?? key,
  }),
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      ttsVoiceProviderId: 'qwen-tts',
      ttsVoice: 'cosyvoice-v3.5-plus-teacher',
      ttsSpeed: 1,
      setTTSVoice: mocks.setTTSVoice,
    }),
}));
vi.mock('@/lib/audio/voxcpm-voices', () => ({
  useQwenVoiceProfiles: () => ({
    profiles: [
      { id: 'cosyvoice-v3.5-plus-teacher', name: 'Teacher', referenceAudioName: 'teacher.wav' },
      { id: 'cosyvoice-v3-plus-assistant', name: 'Assistant', referenceAudioName: 'assistant.wav' },
    ],
    deleteVoice: mocks.deleteVoice,
  }),
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

import { QwenVoiceCloneManager } from '@/components/settings/tts-voice-managers';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
const guidance =
  'This saved voice is incompatible with the current cloning model. Upload its reference audio again to re-clone it.';
const rejected = (code = 'QWEN_VC_RECLONE_REQUIRED') =>
  new Response(
    JSON.stringify({
      error: guidance,
      errorCode: code,
    }),
    { status: 409 },
  );
const success = () => new Response(JSON.stringify({ base64: 'AQI=', format: 'wav' }));

class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(async () => {});
  pause = vi.fn();
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:preview');
      static revokeObjectURL = vi.fn();
    },
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QwenVoiceCloneManager)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function row(name: string): HTMLElement {
  const label = [...host.querySelectorAll('span')].find((node) => node.textContent === name);
  expect(label).toBeDefined();
  return label!.closest('.group') as HTMLElement;
}
async function preview(name: string) {
  await act(async () => {
    const button = row(name).querySelector('button')!;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

it('keeps the server re-clone instruction on only the affected saved voice', async () => {
  expect(host.querySelector('[role="status"]')).toBeNull();
  mocks.fetch.mockResolvedValueOnce(rejected());
  await preview('Teacher');
  expect(row('Teacher').querySelector('[role="status"]')?.textContent).toBe(guidance);
  expect(row('Teacher').textContent).toContain('teacher.wav');
  expect(row('Assistant').querySelector('[role="status"]')).toBeNull();
  expect(mocks.setTTSVoice).not.toHaveBeenCalled();
  expect(mocks.deleteVoice).not.toHaveBeenCalled();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it('does not infer incompatibility from a prefix, message text or an unrelated failure', async () => {
  mocks.fetch.mockResolvedValueOnce(rejected('MODEL_NOT_AUTHORIZED'));
  await preview('Teacher');
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(mocks.toastError).toHaveBeenCalledWith(guidance);
});

it('clears the notice after the same voice previews successfully', async () => {
  mocks.fetch.mockResolvedValueOnce(rejected());
  await preview('Teacher');
  expect(row('Teacher').querySelector('[role="status"]')).not.toBeNull();
  mocks.fetch.mockResolvedValueOnce(success());
  await preview('Teacher');
  expect(row('Teacher').querySelector('[role="status"]')).toBeNull();
  expect(mocks.setTTSVoice).not.toHaveBeenCalled();
});

it('ignores an incompatible response from a preview superseded by another voice', async () => {
  let finish!: (response: Response) => void;
  mocks.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await preview('Teacher');
  mocks.fetch.mockResolvedValueOnce(success());
  await preview('Assistant');
  await act(async () => finish(rejected()));
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(mocks.toastError).not.toHaveBeenCalled();
});

it('keeps a confirmed warning when the user cancels a retry before its response', async () => {
  mocks.fetch.mockResolvedValueOnce(rejected());
  await preview('Teacher');
  let finish!: (response: Response) => void;
  mocks.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await preview('Teacher');
  await preview('Teacher');
  await act(async () => finish(success()));
  expect(row('Teacher').querySelector('[role="status"]')?.textContent).toBe(guidance);
});
