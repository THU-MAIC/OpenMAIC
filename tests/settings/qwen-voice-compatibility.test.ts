// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import enUS from '@/lib/i18n/locales/en-US.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  toastError: vi.fn(),
  setTTSVoice: vi.fn(),
  deleteVoice: vi.fn(),
  profiles: [] as { id: string; name: string; referenceAudioName: string }[],
  messages: {} as Record<string, unknown>,
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    locale: 'en-US',
    t: (key: string) => mocks.messages[key.replace('settings.', '')] ?? key,
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
  useQwenVoiceProfiles: () => ({ profiles: mocks.profiles, deleteVoice: mocks.deleteVoice }),
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

import { QwenVoiceCloneManager } from '@/components/settings/tts-voice-managers';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
const target = 'cosyvoice-v3.5-plus';
const teacher = { id: `${target}-teacher`, name: 'Teacher', referenceAudioName: 'teacher.wav' };
const assistant = {
  id: `${target}-assistant`,
  name: 'Assistant',
  referenceAudioName: 'assistant.wav',
};
const previousAssistant = { ...assistant, id: 'cosyvoice-v3-plus-assistant' };
const instruction = enUS.settings.qwenCloneRecloneRequired;
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

beforeEach(() => {
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
  mocks.messages = enUS.settings;
  // Both voices match the server's target: only a preview can find one stale.
  mocks.profiles = [teacher, assistant];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(props: { cloneTarget?: string } = { cloneTarget: target }) {
  await act(async () => root.render(createElement(QwenVoiceCloneManager, props)));
}
function row(name: string): HTMLElement {
  const label = [...host.querySelectorAll('span')].find((node) => node.textContent === name);
  expect(label).toBeDefined();
  return label!.closest('.group') as HTMLElement;
}
const notice = (name: string) => row(name).querySelector('[role="status"]');
async function preview(name: string) {
  await act(async () => {
    const button = row(name).querySelector('button')!;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

it('leaves saved voices cloned for the current target unmarked', async () => {
  await render();
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it('marks a voice cloned for a previous target on mount, without a preview', async () => {
  mocks.profiles = [teacher, previousAssistant];
  await render();
  expect(notice('Assistant')?.textContent).toBe(instruction);
  expect(row('Assistant').textContent).toContain('assistant.wav');
  expect(notice('Teacher')).toBeNull();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.setTTSVoice).not.toHaveBeenCalled();
  expect(mocks.deleteVoice).not.toHaveBeenCalled();
});

it('marks nothing on mount without a server target, or for one that binds no clone IDs', async () => {
  mocks.profiles = [teacher, previousAssistant];
  await render({});
  expect(host.querySelector('[role="status"]')).toBeNull();
  await render({ cloneTarget: 'qwen3-tts-vc-operator-model' });
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it('clears a mount-time mark once the server plays the voice', async () => {
  mocks.profiles = [teacher, previousAssistant];
  await render();
  expect(notice('Assistant')).not.toBeNull();
  mocks.fetch.mockResolvedValueOnce(success());
  await preview('Assistant');
  expect(notice('Assistant')).toBeNull();
  expect(mocks.setTTSVoice).not.toHaveBeenCalled();
});

it('keeps the re-clone instruction on only the voice a preview finds stale', async () => {
  await render();
  mocks.fetch.mockResolvedValueOnce(rejected());
  await preview('Teacher');
  expect(notice('Teacher')?.textContent).toBe(instruction);
  expect(row('Teacher').textContent).toContain('teacher.wav');
  expect(notice('Assistant')).toBeNull();
  expect(mocks.setTTSVoice).not.toHaveBeenCalled();
  expect(mocks.deleteVoice).not.toHaveBeenCalled();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it('shows the instruction in the interface language, not the server message', async () => {
  mocks.messages = zhCN.settings;
  mocks.profiles = [teacher, previousAssistant];
  await render();
  mocks.fetch.mockResolvedValueOnce(rejected());
  await preview('Teacher');
  expect(notice('Teacher')?.textContent).toBe(zhCN.settings.qwenCloneRecloneRequired);
  expect(notice('Assistant')?.textContent).toBe(zhCN.settings.qwenCloneRecloneRequired);
  expect(mocks.toastError).toHaveBeenCalledWith(guidance);
});

it('does not infer incompatibility from a prefix, message text or an unrelated failure', async () => {
  await render();
  mocks.fetch.mockResolvedValueOnce(rejected('MODEL_NOT_AUTHORIZED'));
  await preview('Teacher');
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(mocks.toastError).toHaveBeenCalledWith(guidance);
});

it('clears the notice after the same voice previews successfully', async () => {
  await render();
  mocks.fetch.mockResolvedValueOnce(rejected());
  await preview('Teacher');
  expect(notice('Teacher')).not.toBeNull();
  mocks.fetch.mockResolvedValueOnce(success());
  await preview('Teacher');
  expect(notice('Teacher')).toBeNull();
  expect(mocks.setTTSVoice).not.toHaveBeenCalled();
});

it('ignores an incompatible response from a preview superseded by another voice', async () => {
  await render();
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
  await render();
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
  expect(notice('Teacher')?.textContent).toBe(instruction);
});
