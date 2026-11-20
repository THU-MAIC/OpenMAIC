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

const { updateScene } = vi.hoisted(() => ({ updateScene: vi.fn() }));
vi.mock('@/lib/edit/course-edit', () => ({
  commitCourseEdit: (_options: unknown, apply: () => void) => apply(),
}));
vi.mock('@/components/stage/scene-thumbnail-content', () => ({
  SceneThumbnailContent: () => null,
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: { use: { viewportSize: () => 1000, viewportRatio: () => 0.5625 } },
}));
vi.mock('@/lib/store/stage', () => ({
  useStageStore: { use: { updateScene: () => updateScene } },
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
  updateScene.mockReset();
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
  renderScenes([s]);
}
function renderScenes(scenes: Scene[]) {
  act(() =>
    root.render(
      createElement(
        Reorder.Group,
        {
          axis: 'y',
          values: scenes.map((s) => s.id),
          onReorder: () => {},
        },
        ...scenes.map((s) =>
          createElement(ThumbItem, {
            key: s.id,
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

it('only marks empty speech and pending media when server narration is unavailable', async () => {
  setModelSettingsViewForTests({});
  const scenes = Array.from({ length: 8 }, (_, order) => ({
    ...scene(),
    id: `scene-${order}`,
    order,
  }));
  renderScenes(scenes);
  await settle();
  expect(host.querySelectorAll('[data-testid="scene-item"]')).toHaveLength(8);
  expect(host.querySelectorAll('[data-testid="scene-issue-marker"]')).toHaveLength(0);
  scenes[0].actions = [{ id: 'empty', type: 'speech', text: '' }];
  if (scenes[1].content.type !== 'slide') throw new Error('Expected a slide');
  scenes[1].content = {
    ...scenes[1].content,
    canvas: {
      ...scenes[1].content.canvas,
      elements: [
        {
          id: 'pending',
          type: 'video',
          src: 'gen_vid_pending',
          rotate: 0,
          left: 50,
          top: 160,
          width: 400,
          height: 225,
          autoplay: false,
        },
      ],
    },
  };
  renderScenes(scenes.map((s) => ({ ...s })));
  const markers = host.querySelectorAll('[data-testid="scene-issue-marker"]');
  expect(markers).toHaveLength(2);
  expect([...markers].map((m) => m.getAttribute('data-severity'))).toEqual(['warning', 'warning']);
});

it('never flashes a cached narration marker during mount, inline rename, or insertion above it', async () => {
  await db.audioFiles.bulkPut([cached(0), cached(1)]);
  let scenes: Scene[] = [{ ...scene(), title: 'Cached narration' }];
  const observed: Element[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        const markers = node.matches('[data-testid="scene-issue-marker"]')
          ? [node]
          : node.querySelectorAll('[data-testid="scene-issue-marker"]');
        for (const marker of markers) {
          if (
            marker
              .closest('[data-testid="scene-item"]')
              ?.querySelector('[data-testid="scene-title"]')?.textContent !== 'Inserted scene'
          )
            observed.push(marker);
        }
      }
    }
  });
  observer.observe(host, { childList: true, subtree: true });
  try {
    renderScenes(scenes);
    await settle();
    expect(marker()).toBeNull();
    updateScene.mockImplementation((id: string, patch: Pick<Scene, 'title'>) => {
      scenes = scenes.map((s) => (s.id === id ? { ...s, ...patch } : s));
      renderScenes(scenes);
    });
    await act(async () => {
      host
        .querySelector('[data-testid="scene-title"]')!
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const input = host.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'Renamed scene',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(updateScene).toHaveBeenCalledWith('s', { title: 'Renamed scene' });
    expect(host.querySelector('[data-testid="scene-title"]')?.textContent).toBe('Renamed scene');
    expect(marker()).toBeNull();
    renderScenes([
      { ...scene(), id: 'inserted', title: 'Inserted scene', actions: [] },
      { ...scenes[0], order: 1 },
    ]);
    await settle();
    const items = host.querySelectorAll('[data-testid="scene-item"]');
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('[data-testid="scene-issue-marker"]')).not.toBeNull();
    expect(items[1].querySelector('[data-testid="scene-issue-marker"]')).toBeNull();
    expect(observed).toEqual([]);
  } finally {
    observer.disconnect();
  }
});
