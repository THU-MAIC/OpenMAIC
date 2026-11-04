// @vitest-environment jsdom

/**
 * A slide open in the editor when its scene changes on the server: the real
 * canvas controller, session and stage store, with only the storage module
 * faked. The freshness sync replaces the scene in the store; the next commit
 * from the canvas, which may be an automatic text-height normalization with no
 * user input, must build on that content rather than on the copy the session
 * took when the page was opened.
 */
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const saveStageDataIncremental = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ failedChanges: [] as unknown[] }),
);

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental,
  loadStageData: vi.fn().mockResolvedValue(null),
}));

import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';
import { useSlideCanvasController } from '@/components/edit/surfaces/slide/use-slide-surface';
import { createDefaultSlide, createDefaultTextElement } from '@/lib/edit/slide-edit-elements';
import { useStageStore } from '@/lib/store/stage';
import type { Scene, SlideContent, Stage } from '@/lib/types/stage';

type Text = SlideContent['canvas']['elements'][number] & { content: string; height: number };

function slideWith(content: string, height: number): SlideContent {
  const canvas = createDefaultSlide('slide-1');
  canvas.elements.push({ ...createDefaultTextElement('text-1'), content, height });
  return { type: 'slide', canvas };
}

function textIn(content: SlideContent): Text {
  return content.canvas.elements[0] as Text;
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

function storedScene(): Scene {
  return useStageStore.getState().scenes[0]!;
}

function storedText(): Text {
  return textIn(storedScene().content as SlideContent);
}

/** What the freshness sync does when another writer changed the scene. */
function serverCopyArrives(content: SlideContent, narration: string) {
  act(() => useStageStore.setState({ scenes: [sceneWith(content, narration)] }));
}

let controller: ReturnType<typeof useSlideCanvasController>['controller'] | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function Harness({
  onController,
}: {
  onController: (value: ReturnType<typeof useSlideCanvasController>['controller']) => void;
}) {
  const { controller: current } = useSlideCanvasController();
  useEffect(() => onController(current), [current, onController]);
  return null;
}

/** A commit with no gesture, as the canvas makes when it re-measures text. */
function normalizeHeight(height: number) {
  act(() =>
    controller!.updateSceneData((draft) => {
      textIn(draft as SlideContent).height = height;
    }),
  );
}

beforeEach(async () => {
  vi.useFakeTimers();
  saveStageDataIncremental.mockClear();
  useStageStore.setState({
    stage: { id: 'stage-a', name: 'Course', createdAt: 1, updatedAt: 1 } as Stage,
    scenes: [sceneWith(slideWith('old placeholder', 47), 'old narration')],
    currentSceneId: 'scene-1',
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(Harness, {
        onController: (value) => {
          controller = value;
        },
      }),
    ),
  );
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  controller = null;
  document.body.innerHTML = '';
  useStageStore.getState().clearStore();
  vi.useRealTimers();
});

describe('a slide open in the editor when its scene changes on the server', () => {
  it('an automatic height commit keeps the new content, in the store and in the save', async () => {
    serverCopyArrives(slideWith('agent content', 47), 'agent narration');

    normalizeHeight(107);

    expect(storedText().content).toBe('agent content');
    expect(storedText().height).toBe(107);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const saved = saveStageDataIncremental.mock.calls.at(-1)![2] as { scenes: Scene[] };
    expect(textIn(saved.scenes[0]!.content as SlideContent).content).toBe('agent content');
    expect(saved.scenes[0]!.actions).toEqual(storedScene().actions);
  });

  it('a user edit from the toolbar builds on the new content', () => {
    serverCopyArrives(slideWith('agent content', 47), 'agent narration');

    act(() =>
      useSlideEditSession.getState().applyOp({
        type: 'element.update',
        elementId: 'text-1',
        patch: { left: 321 },
      }),
    );

    expect(storedText().content).toBe('agent content');
    expect(storedText().left).toBe(321);
  });

  it('keeps the undo timeline across a server copy of the same content', () => {
    act(() =>
      useSlideEditSession.getState().applyOp({
        type: 'element.update',
        elementId: 'text-1',
        patch: { left: 321 },
      }),
    );
    act(() => useSlideEditSession.getState().undo());
    const future = useSlideEditSession.getState().history!.future;
    expect(future).toHaveLength(1);

    // The sync reads back what this page just saved: an equal, new object.
    serverCopyArrives(structuredClone(storedScene().content) as SlideContent, 'old narration');

    expect(useSlideEditSession.getState().history!.future).toEqual(future);
    act(() => useSlideEditSession.getState().redo());
    expect(storedText().left).toBe(321);
  });
});
