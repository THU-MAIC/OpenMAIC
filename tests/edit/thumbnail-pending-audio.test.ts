// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Reorder } from 'motion/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThumbItem } from '@/components/edit/SlideNavRail/ThumbItem';
import { db } from '@/lib/device-storage/database';
import type { Scene } from '@/lib/types/stage';
import { setModelSettingsViewForTests } from '../helpers/model-settings-view';

vi.mock('@/components/stage/scene-thumbnail-content', () => ({
  SceneThumbnailContent: () => null,
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: { use: { viewportSize: () => 1000, viewportRatio: () => 0.5625 } },
}));
vi.mock('@/lib/store/stage', () => ({
  useStageStore: { use: { updateScene: () => () => {} } },
}));

const scene = (): Scene => ({
  id: 's',
  stageId: 'c',
  type: 'slide',
  title: 'Narration',
  order: 0,
  createdAt: 0,
  updatedAt: 0,
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
  actions: [{ id: 'a', type: 'speech', text: 'Hello' }],
});
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setModelSettingsViewForTests({ tts: { registryId: 'openai-tts' } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  await db.audioFiles.clear();
  setModelSettingsViewForTests(null);
  vi.unstubAllGlobals();
});
function render(s: Scene) {
  act(() =>
    root.render(
      createElement(
        Reorder.Group,
        {
          axis: 'y',
          values: [s.id],
          onReorder: () => {},
        },
        createElement(ThumbItem, {
          scene: s,
          index: s.order,
          active: true,
          canDelete: true,
          onActivate: () => {},
          onDuplicate: () => {},
          onDelete: () => {},
        }),
      ),
    ),
  );
}
const marker = () => host.querySelector('[data-testid="scene-issue-marker"]');
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
const cached = (order: number) => ({
  id: `tts_s${order}_a`,
  stageId: 'c',
  text: 'Hello',
  blob: new Blob(['audio']),
  format: 'mp3',
  createdAt: 0,
});

it('does not show an unchecked narration marker on first mount with cached audio', async () => {
  await db.audioFiles.put(cached(0));
  render(scene());
  expect(marker()).toBeNull();
  await settle();
  expect(marker()).toBeNull();
});

it('waits for the new order lookup and then reports a confirmed cache miss', async () => {
  await db.audioFiles.bulkPut([cached(0), cached(1)]);
  render(scene());
  await settle();
  expect(marker()).toBeNull();
  render({ ...scene(), order: 1 });
  expect(marker()).toBeNull();
  await settle();
  expect(marker()).toBeNull();
  render({ ...scene(), order: 2 });
  expect(marker()).toBeNull();
  await settle();
  expect(marker()?.getAttribute('data-severity')).toBe('warning');
  render({ ...scene(), order: 1 });
  expect(marker()).toBeNull();
  await settle();
  expect(marker()).toBeNull();
});

it('shows confirmed missing narration and follows subsequent cache writes and deletion', async () => {
  render(scene());
  expect(marker()).toBeNull();
  await settle();
  expect(marker()).not.toBeNull();
  await act(async () => {
    await db.audioFiles.put(cached(0));
  });
  await settle();
  expect(marker()).toBeNull();
  await act(async () => {
    await db.audioFiles.clear();
  });
  await settle();
  expect(marker()).not.toBeNull();
});

it.each(['empty speech', 'dangling cue', 'invalidated narration'])(
  'shows %s immediately while the local audio lookup is pending',
  (kind) => {
    const s = scene();
    if (kind === 'empty speech') s.actions!.push({ id: 'empty', type: 'speech', text: '' });
    if (kind === 'dangling cue')
      s.actions!.push({ id: 'cue', type: 'spotlight', elementId: 'missing' });
    if (kind === 'invalidated narration') Object.assign(s.actions![0], { audioInvalidated: true });
    render(s);
    expect(marker()?.getAttribute('data-severity')).toBe('warning');
  },
);

it('does not hide the warning indefinitely if the local audio query fails', async () => {
  vi.spyOn(db.audioFiles, 'get').mockRejectedValueOnce(new Error('Device cache unavailable'));
  render(scene());
  await settle();
  expect(marker()).not.toBeNull();
});
