// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { db } from '@/lib/device-storage/database';
import { observeLegacySpeechAudio } from '@/lib/device-storage/observe-legacy-speech-audio';
import { useSceneIssues } from '@/lib/edit/use-scene-issues';
import type { Scene } from '@/lib/types/stage';
import { modelSettingsClient } from '@/lib/model-settings/client';
import { modelSettingsViewFor, setModelSettingsViewForTests } from '../helpers/model-settings-view';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
const root = createRoot(host);
const scene = (audioId?: string): Scene =>
  ({
    id: 's',
    stageId: 'c',
    type: 'slide',
    title: 'S',
    order: 1,
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: 'Arial' },
        elements: [],
      },
    },
    actions: [{ id: 'a', type: 'speech', text: 'Hello', audioId }],
  }) as Scene;
function Probe({ scene }: { scene: Scene }) {
  return createElement(
    'div',
    null,
    useSceneIssues(scene)
      .map((i) => i.kind)
      .join(','),
  );
}
beforeEach(() => setModelSettingsViewForTests({ tts: { registryId: 'openai-tts' } }));
afterEach(async () => {
  await act(async () => root.render(null));
  await db.audioFiles.clear();
  setModelSettingsViewForTests(null);
});
it('updates from current document and live legacy audio writes/deletes', async () => {
  const s = scene();
  await act(async () => root.render(createElement(Probe, { scene: s })));
  expect(host.textContent).toContain('speech-without-audio');
  await act(async () => {
    await db.audioFiles.put({
      id: 'tts_s1_a',
      stageId: 'other',
      text: 'Hello',
      blob: new Blob(['audio']),
      format: 'mp3',
      createdAt: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(host.textContent).toContain('speech-without-audio');
  await act(async () => {
    await db.audioFiles.put({
      id: 'tts_s1_a',
      stageId: 'c',
      blob: new Blob(['audio']),
      format: 'mp3',
      createdAt: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(host.textContent).toBe('');
  await act(async () => {
    await db.audioFiles.clear();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(host.textContent).toContain('speech-without-audio');
  await act(async () => root.render(createElement(Probe, { scene: scene('allocated-audio') })));
  expect(host.textContent).toBe('');
});

it.each([
  { name: 'another course, even with matching text', stageId: 'other', text: 'Hello', have: false },
  { name: 'the current course', stageId: 'c', text: 'Hello', have: true },
  { name: 'an unscoped row with different text', text: 'Other narration', have: false },
  { name: 'an unscoped row with matching text', text: ' Hello ', have: true },
  { name: 'an ambiguous row without ownership metadata', have: false },
  { name: 'a pre-allocation generated action', actionId: 'action_abcdefgh', have: true },
  { name: 'an empty action ID', stageId: 'c', actionId: '', have: false },
  { name: 'an invalidated action', stageId: 'c', audioInvalidated: true, have: false },
  {
    name: 'an action with a current audio reference',
    stageId: 'c',
    audioId: 'allocated',
    have: false,
  },
])(
  'checks legacy cache ownership for $name',
  async ({ stageId, text, actionId = 'a', audioInvalidated, audioId, have }) => {
    const s = scene();
    s.actions![0].id = actionId;
    Object.assign(s.actions![0], { audioInvalidated, audioId });
    await db.audioFiles.put({
      id: `tts_s1_${actionId}`,
      stageId,
      text,
      blob: new Blob(['audio']),
      format: 'mp3',
      createdAt: Date.now(),
    });
    const audio = await new Promise<Set<string>>((resolve, reject) => {
      const stop = observeLegacySpeechAudio(
        s,
        (ids) => {
          stop();
          resolve(ids);
        },
        () => {
          stop();
          reject(new Error('Legacy cache observation failed'));
        },
      );
    });
    expect(audio.has(actionId)).toBe(have);
  },
);

it.each(['disabled', 'unassigned', 'browser-native-tts'])(
  'keeps narration markers off when the workspace TTS slot is %s and reacts to changes',
  async (mode) => {
    const view = modelSettingsViewFor(
      mode === 'browser-native-tts' ? { tts: { registryId: mode } } : {},
    );
    if (mode === 'disabled') {
      view.slots.find((slot) => slot.slot === 'tts')!.effective = {
        status: 'disabled',
        resolvedAt: 'tts',
        source: 'workspace',
      };
    }
    modelSettingsClient.adopt(view);
    await act(async () => root.render(createElement(Probe, { scene: scene() })));
    expect(host.textContent).toBe('');
    await act(async () => setModelSettingsViewForTests({ tts: { registryId: 'openai-tts' } }));
    expect(host.textContent).toContain('speech-without-audio');
    await act(async () => modelSettingsClient.adopt(view));
    expect(host.textContent).toBe('');
    const lint = scene();
    Object.assign(lint.actions![0], { text: '' });
    await act(async () => root.render(createElement(Probe, { scene: lint })));
    expect(host.textContent).toBe('empty-speech');
  },
);
