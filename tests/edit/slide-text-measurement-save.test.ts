// @vitest-environment jsdom

/**
 * The legacy canvas re-measures every text box when it renders one and writes
 * the height it finds into the slide. That is a measurement, not an edit: the
 * real text element, canvas operations, canvas controller, edit session, stage
 * store, save scheduler and freshness sync run here, and only the edges are
 * faked (ResizeObserver, the rich-text editor, fetch, EventSource, the storage
 * module's write).
 *
 * A scene save writes the whole scene, so a measurement that saves replaces
 * whatever the server holds with this tab's copy, with no user input; and one
 * that counts as a pending edit holds back the next remote change.
 */
import { act, createElement, useEffect, type FC, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stageRev: 1,
  sceneRev: 1,
  serverScene: null as unknown,
  saves: [] as unknown[],
  typeInto: null as ((value: string) => void) | null,
}));

vi.mock('@/lib/live-mode', () => ({ isLiveMode: true }));
vi.mock('@/lib/workbench/session-store', () => ({
  appendCompactedReplayEvent: vi.fn(),
  compactReplayEvents: vi.fn(),
  useWorkbenchStore: { getState: () => ({ panelOpen: true, playbackOn: false }) },
}));
vi.mock('@/lib/document-store/store', () => ({
  getDocumentStore: () => ({ loadDocument: vi.fn() }),
}));
vi.mock('@/lib/utils/stage-storage', () => {
  /** What a scene save does on the server: the whole scene lands and its rev moves. */
  const save = async (
    _stageId: string,
    dirty: readonly { kind: string; sceneId?: string }[],
    data: { scenes: readonly { id: string }[] },
  ) => {
    mocks.saves.push(structuredClone({ dirty, scenes: data.scenes }));
    for (const change of dirty) {
      const scene = data.scenes.find((candidate) => candidate.id === change.sceneId);
      if (change.kind !== 'scene' || !scene) continue;
      mocks.serverScene = structuredClone(scene);
      mocks.sceneRev += 1;
      mocks.stageRev += 1;
    }
    return { failedChanges: [] };
  };
  return {
    saveStageData: vi.fn().mockResolvedValue(undefined),
    saveStageDataIncremental: vi.fn(save),
    loadStageData: vi.fn().mockResolvedValue(null),
  };
});
vi.mock('@/lib/hooks/use-history-snapshot', () => ({
  useHistorySnapshot: () => ({ addHistorySnapshot: vi.fn() }),
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: () => ({
      agentMode: 'auto',
      selectedAgentIds: [],
      agentSelectionIsUserSet: false,
      setSelectedAgentIds: vi.fn(),
      setAgentSelectionIsUserSet: vi.fn(),
    }),
  },
}));
vi.mock('@/components/slide-renderer/components/element/ProsemirrorEditor', () => ({
  ProsemirrorEditor: ({ onUpdate }: { onUpdate: (update: { value: string }) => void }) => {
    mocks.typeInto = (value) => onUpdate({ value });
    return null;
  },
}));

import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';
import { useCourseTimeline } from '@/lib/edit/course-timeline';
import {
  useResolvedSlideContent,
  useSlideCanvasController,
} from '@/components/edit/surfaces/slide/use-slide-surface';
import { TextElement } from '@/components/slide-renderer/components/element/TextElement';
import {
  SceneProvider,
  useSceneData,
  type SceneDataController,
} from '@/lib/contexts/scene-context';
import { createDefaultSlide, createDefaultTextElement } from '@/lib/edit/slide-edit-elements';
import { useCanvasStore } from '@/lib/store/canvas';
import { hasUnsavedSceneEdit, stageDocumentEditClock, useStageStore } from '@/lib/store/stage';
import type { Scene, SlideContent, Stage } from '@/lib/types/stage';
import { useStageFreshnessSync } from '@/lib/workbench/use-workbench-session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Text = ReturnType<typeof createDefaultTextElement>;

function slideWith(content: string, height: number, overrides: Partial<Text> = {}): SlideContent {
  const canvas = createDefaultSlide('slide-1');
  canvas.elements.push({
    ...createDefaultTextElement('text-1'),
    content,
    height,
    ...overrides,
  });
  return { type: 'slide', canvas };
}

function sceneWith(content: SlideContent, narration: string): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-a',
    order: 0,
    title: 'Page',
    type: 'slide',
    content,
    actions: [{ id: 'speech-1', type: 'speech', text: narration }],
  } as Scene;
}

function textIn(scene: unknown): Text {
  return (scene as Scene & { content: SlideContent }).content.canvas.elements[0] as Text;
}

function storedScene(): Scene {
  return useStageStore.getState().scenes[0]!;
}

/** An agent or another tab writes the scene on the server. */
function remoteWrite(content: string, height: number, narration: string) {
  mocks.serverScene = sceneWith(slideWith(content, height), narration);
  mocks.sceneRev += 1;
  mocks.stageRev += 1;
}

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  observed = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    MockResizeObserver.instances.push(this);
  }
  observe() {
    this.observed = true;
  }
  unobserve() {
    this.observed = false;
  }
  disconnect() {
    this.observed = false;
  }
  report(width: number, height: number) {
    this.callback(
      [{ contentRect: { width, height } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly listeners = new Map<string, (() => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  close() {}
  emitFreshness() {
    for (const fn of this.listeners.get('stage_freshness') ?? []) fn();
  }
}

/** The canvas reports the box it laid the text out in; the element adds its 20 px of padding. */
function canvasMeasures(height: number, width = 300) {
  const observer = MockResizeObserver.instances.filter((candidate) => candidate.observed).at(-1)!;
  act(() => observer.report(width - 20, height - 20));
}

async function settle(ms = 1_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const Provider = SceneProvider as FC<{ controller?: SceneDataController; children?: ReactNode }>;

function EditCanvas() {
  useStageFreshnessSync('stage-a');
  const { controller } = useSlideCanvasController();
  const element = useResolvedSlideContent().canvas.elements[0] as Text;
  return createElement(
    Provider,
    { controller },
    element ? createElement(TextElement, { elementInfo: element }) : null,
  );
}

let root: ReturnType<typeof createRoot> | null = null;

async function openEditor(stored: Scene) {
  mocks.serverScene = structuredClone(stored);
  useStageStore.setState({
    stage: { id: 'stage-a', name: 'Course', createdAt: 1, updatedAt: 1 } as Stage,
    scenes: [stored],
    currentSceneId: 'scene-1',
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(EditCanvas)));
  const source = MockEventSource.instances[0]!;
  // The sync's first pass only records a baseline; this one verifies the revs.
  await act(async () => source.emitFreshness());
  return source;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.stageRev = 1;
  mocks.sceneRev = 1;
  mocks.serverScene = null;
  mocks.saves = [];
  mocks.typeInto = null;
  MockResizeObserver.instances = [];
  MockEventSource.instances = [];
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/manifest')) {
        const body = {
          rev: mocks.stageRev,
          scenes: [{ id: 'scene-1', order: 0, rev: mocks.sceneRev }],
        };
        return { ok: true, status: 200, json: async () => body };
      }
      if (url.includes('/scenes?')) {
        const scenes = [structuredClone(mocks.serverScene)];
        return { ok: true, status: 200, json: async () => ({ scenes }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  useCanvasStore.setState({ handleElementId: '', isScaling: false });
  useStageStore.getState().clearStore();
  useStageStore.setState({ serverManifestByStage: {} });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a text height the canvas measured, with no edit behind it', () => {
  it('is kept on screen and written nowhere', async () => {
    await openEditor(sceneWith(slideWith('course text', 68), 'course narration'));
    const clock = stageDocumentEditClock();

    canvasMeasures(47);
    await settle();

    expect(textIn(storedScene()).height).toBe(47);
    expect(mocks.saves).toEqual([]);
    expect(textIn(mocks.serverScene).height).toBe(68);
    expect(hasUnsavedSceneEdit('stage-a', 'scene-1')).toBe(false);
    expect(stageDocumentEditClock()).toBe(clock);
  });

  it('does not put a stale copy back over what the server holds', async () => {
    // A tab that has not heard of the agent's change yet.
    const source = await openEditor(sceneWith(slideWith('old text', 68), 'old narration'));
    remoteWrite('agent text', 68, 'agent narration');

    canvasMeasures(47);
    await settle();

    expect(mocks.saves).toEqual([]);
    expect(textIn(mocks.serverScene).content).toBe('agent text');
    expect((mocks.serverScene as Scene).actions![0]).toMatchObject({ text: 'agent narration' });

    await act(async () => source.emitFreshness());
    expect(textIn(storedScene()).content).toBe('agent text');
  });

  it('does not hold back the next remote write, which reaches the screen and stays on the server', async () => {
    const source = await openEditor(sceneWith(slideWith('course text', 47), 'course narration'));

    remoteWrite('agent v1', 47, 'narration v1');
    await act(async () => source.emitFreshness());
    expect(textIn(storedScene()).content).toBe('agent v1');

    // Agent v1 laid out differently: the canvas re-measures it.
    canvasMeasures(107);
    // The agent writes again inside what would have been the save's debounce.
    remoteWrite('agent v2', 47, 'narration v2');
    await act(async () => source.emitFreshness());
    await settle();

    expect(textIn(storedScene()).content).toBe('agent v2');
    expect(storedScene().actions![0]).toMatchObject({ text: 'narration v2' });
    expect(mocks.saves).toEqual([]);
    expect(textIn(mocks.serverScene).content).toBe('agent v2');
  });

  it('adds no undo step and leaves the existing ones', async () => {
    await openEditor(sceneWith(slideWith('course text', 68), 'course narration'));
    act(() =>
      useSlideEditSession.getState().applyOp({
        type: 'element.update',
        elementId: 'text-1',
        patch: { left: 321 },
      }),
    );
    const past = useCourseTimeline.getState().lines['stage-a']?.past;
    expect(past).toBeDefined();

    canvasMeasures(47);

    expect(useCourseTimeline.getState().lines['stage-a']?.past).toBe(past);
  });

  it('settles: reading a save of its own back does not start the save again', async () => {
    const source = await openEditor(sceneWith(slideWith('course text', 68), 'course narration'));
    act(() => mocks.typeInto!('<p>typed</p>'));
    await settle();
    expect(mocks.saves).toHaveLength(1);

    // The sync reads this page's save back, and the canvas measures that copy.
    await act(async () => source.emitFreshness());
    canvasMeasures(47);
    await settle();

    expect(mocks.saves).toHaveLength(1);
  });

  it('also stays unsaved on a canvas with no edit session', async () => {
    function UncontrolledMeasurer() {
      const { updateSceneData } = useSceneData<SlideContent>();
      useEffect(() => {
        mocks.typeInto = (value) =>
          updateSceneData(
            (draft) => {
              (draft.canvas.elements[0] as Text).height = Number(value);
            },
            { measurement: true },
          );
      }, [updateSceneData]);
      return null;
    }
    useStageStore.setState({
      stage: { id: 'stage-a', name: 'Course', createdAt: 1, updatedAt: 1 } as Stage,
      scenes: [sceneWith(slideWith('course text', 68), 'course narration')],
      currentSceneId: 'scene-1',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(createElement(Provider, null, createElement(UncontrolledMeasurer))),
    );

    act(() => mocks.typeInto!('47'));
    await settle();

    expect(textIn(storedScene()).height).toBe(47);
    expect(mocks.saves).toEqual([]);
  });
});

describe('edits next to a measurement still save', () => {
  it('typing, which commits with no pointer gesture, saves the text and the height it led to', async () => {
    await openEditor(sceneWith(slideWith('course text', 47), 'course narration'));

    act(() => mocks.typeInto!('<p>a longer sentence</p>'));
    canvasMeasures(107);
    await settle();

    expect(mocks.saves).toHaveLength(1);
    expect(textIn(mocks.serverScene)).toMatchObject({
      content: '<p>a longer sentence</p>',
      height: 107,
    });
  });

  it('the next real edit carries a height measured before it', async () => {
    await openEditor(sceneWith(slideWith('course text', 68), 'course narration'));

    canvasMeasures(47);
    await settle();
    expect(mocks.saves).toEqual([]);

    act(() =>
      useSlideEditSession.getState().applyOp({
        type: 'element.update',
        elementId: 'text-1',
        patch: { left: 321 },
      }),
    );
    await settle();

    expect(mocks.saves).toHaveLength(1);
    expect(textIn(mocks.serverScene)).toMatchObject({ left: 321, height: 47 });
  });

  it('dragging a resize handle saves the height the drag ended on', async () => {
    await openEditor(sceneWith(slideWith('course text', 68), 'course narration'));
    act(() => useCanvasStore.setState({ handleElementId: 'text-1', isScaling: true }));

    canvasMeasures(120);
    await settle();
    expect(mocks.saves).toEqual([]);

    act(() => useCanvasStore.setState({ isScaling: false }));
    await settle();

    expect(mocks.saves).toHaveLength(1);
    expect(textIn(mocks.serverScene).height).toBe(120);
  });

  it('measures the width of vertical text the same way', async () => {
    await openEditor(sceneWith(slideWith('course text', 68, { vertical: true }), 'narration'));

    canvasMeasures(68, 90);
    await settle();

    expect(textIn(storedScene()).width).toBe(90);
    expect(mocks.saves).toEqual([]);
  });

  it('a remote change still waits for an edit that really is unsaved', async () => {
    const source = await openEditor(sceneWith(slideWith('course text', 47), 'course narration'));

    act(() => mocks.typeInto!('<p>typed</p>'));
    canvasMeasures(107);
    remoteWrite('agent text', 47, 'agent narration');
    await act(async () => source.emitFreshness());

    expect(textIn(storedScene()).content).toBe('<p>typed</p>');
  });
});
