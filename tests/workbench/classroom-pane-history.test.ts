// @vitest-environment jsdom

/**
 * The workbench hides the editor's command bar, so undo/redo reach the classroom
 * pane's header through a portal, for every scene type. These tests mount the
 * real pane, chrome root, shell and course timeline; only the surface and the
 * heavy siblings around them are stubbed.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitCourseEdit } from '@/lib/edit/course-edit';
import { useCourseTimeline } from '@/lib/edit/course-timeline';
import type { SceneEditorSurface } from '@/lib/edit/scene-editor-surface';
import type { Scene, SceneType } from '@/lib/types/stage';
import { sceneEditorRegistry } from '@/lib/edit/scene-editor-registry';
import { NOOP_SURFACE } from '@/lib/edit/noop-surface';
import { useStageStore } from '@/lib/store/stage';

const probe = vi.hoisted(() => ({
  sceneType: 'slide' as string,
  // Stable: the shell re-publishes surface state whenever `content` changes identity.
  content: { type: 'slide' },
}));

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/edit/SlideNavRail', () => ({ SlideNavRail: () => null }));
vi.mock('@/components/edit/EditDock/EditDock', () => ({ EditDock: () => null }));
vi.mock('@/components/stage/header-controls', () => ({ HeaderControls: () => null }));
vi.mock('@/lib/edit/preload-editor', () => ({
  preloadEditor: () => Promise.resolve(),
  preloadEditorSurfaces: () => Promise.resolve(),
  isEditorPreloaded: () => true,
}));
vi.mock('@/lib/edit/noop-surface', () => ({
  NOOP_SURFACE: {
    sceneType: 'slide',
    SurfaceComponent: () => null,
    useSurfaceState: () => ({
      content: probe.content,
      selection: undefined,
      hasSelection: false,
      insertItems: [],
      floatingActions: [],
      commands: [],
    }),
  },
}));
vi.mock('@/lib/workbench/use-workbench-pro-edit', () => ({ useWorkbenchProEditing: () => {} }));
vi.mock('@/components/workbench/workspace/WorkspaceCourseTabs', () => ({
  WorkspaceCourseTabs: () => null,
}));
vi.mock('@/lib/workbench/session-store', () => ({
  useWorkbenchStore: (selector: (state: { setPlaybackOn: () => void }) => unknown) =>
    selector({ setPlaybackOn: vi.fn() }),
}));
// The real surface mounts the chrome root only in edit mode, and keeps it through
// an exit fade. Keeping it mounted throughout here covers that fade: the pane's
// mode alone has to take the buttons away.
vi.mock('@/components/classroom/ClassroomSurface', async () => {
  const { EditChromeRoot } = await import('@/components/edit/EditChromeRoot');
  return {
    ClassroomSurface: () =>
      createElement(EditChromeRoot, {
        scene: { id: 'scene-1', type: probe.sceneType, title: 'Scene' } as Scene,
        isEditable: true,
      }),
  };
});

import { WorkspaceClassroomPane } from '@/components/workbench/workspace/WorkspaceClassroomPane';
import { EditChromeRoot } from '@/components/edit/EditChromeRoot';
import { TooltipProvider } from '@/components/ui/tooltip';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

function surfaceFor(sceneType: SceneType): SceneEditorSurface {
  return { ...NOOP_SURFACE, sceneType };
}

let root: Root | null = null;
type PaneProps = { readOnly: boolean; fullscreen: boolean; hidden: boolean };

async function mount(element: Parameters<Root['render']>[0]) {
  if (!root) {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => root!.render(element));
}
function renderPane(next: Partial<PaneProps> = {}) {
  return mount(
    createElement(WorkspaceClassroomPane, {
      browser: {
        tabs: [{ id: 'stage-1', name: 'Course' }],
        activeCourseId: 'stage-1',
        onActivateCourse: vi.fn(),
        onCloseCourse: vi.fn(),
      },
      readOnly: false,
      fullscreen: false,
      hidden: false,
      ...next,
    }),
  );
}
const byTestId = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const undoButton = () => byTestId('workbench-undo');
const redoButton = () => byTestId('workbench-redo');
const setMode = (mode: 'learning' | 'editing') =>
  act(async () => byTestId(`workbench-mode-${mode}`)!.click());

beforeEach(() => {
  probe.sceneType = 'slide';
  useCourseTimeline.getState().clearCourse('stage-1');
  sceneEditorRegistry.register(surfaceFor('slide'));
  sceneEditorRegistry.register(surfaceFor('quiz'));
  localStorage.clear();
  useStageStore.setState({
    stage: { id: 'stage-1', name: 'Course' } as never,
    scenes: [{ id: 'scene-1', title: 'Original', content: { type: 'quiz' } }] as never,
    currentSceneId: 'scene-1',
    isOwner: true,
    readOnly: false,
    courseGenerating: false,
  });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  sceneEditorRegistry.unregister('slide');
  sceneEditorRegistry.unregister('quiz');
});

describe('undo and redo in the classroom pane header', () => {
  it.each(['slide', 'quiz', 'interactive', 'pbl'])(
    'sit just left of the mode group while editing a %s',
    async (type) => {
      probe.sceneType = type;
      await renderPane();
      await setMode('editing');

      const header = byTestId('workbench-editor-header')!;
      const redoControl = redoButton()!;
      expect(header.contains(undoButton())).toBe(true);
      expect(header.contains(redoControl)).toBe(true);
      // With the other editing control between them at most: the tour's ?.
      const modeGroup = byTestId('workbench-mode-learning')!.parentElement;
      const next = redoControl.parentElement!.nextElementSibling;
      expect(
        next === modeGroup ||
          (next?.getAttribute('data-testid') === 'workspace-edit-guide' &&
            next.nextElementSibling === modeGroup),
      ).toBe(true);
      expect(undoButton()!.getAttribute('aria-label')).toBe('edit.undo');
      expect(undoButton()!.title).toBe('edit.undo');
      expect(redoControl.getAttribute('aria-label')).toBe('edit.redo');
      expect(redoControl.title).toBe('edit.redo');
    },
  );

  it('follow the course timeline, and undo and redo it', async () => {
    const title = () => useStageStore.getState().scenes[0].title;
    await renderPane();
    await setMode('editing');
    expect(undoButton()!.disabled).toBe(true);
    expect(redoButton()!.disabled).toBe(true);

    await act(async () =>
      commitCourseEdit({}, () =>
        useStageStore.getState().updateScene('scene-1', { title: 'Renamed' }),
      ),
    );
    expect(undoButton()!.disabled).toBe(false);
    expect(redoButton()!.disabled).toBe(true);

    await act(async () => undoButton()!.click());
    expect(title()).toBe('Original');
    expect(undoButton()!.disabled).toBe(true);
    expect(redoButton()!.disabled).toBe(false);

    await act(async () => redoButton()!.click());
    expect(title()).toBe('Renamed');
    expect(undoButton()!.disabled).toBe(false);
    expect(redoButton()!.disabled).toBe(true);
  });

  it('answer the shortcuts only while editing, and leave text fields alone', async () => {
    const title = () => useStageStore.getState().scenes[0].title;
    const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    };
    await renderPane();
    await setMode('editing');
    await act(async () =>
      commitCourseEdit({}, () =>
        useStageStore.getState().updateScene('scene-1', { title: 'Renamed' }),
      ),
    );

    const input = document.body.appendChild(document.createElement('input'));
    const editor = document.body.appendChild(document.createElement('div'));
    editor.setAttribute('contenteditable', 'true');
    const inner = editor.appendChild(document.createElement('p'));
    for (const target of [input, inner]) {
      let event!: KeyboardEvent;
      await act(async () => {
        event = press({ key: 'z', metaKey: true }, target);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(title()).toBe('Renamed');
    }

    let event!: KeyboardEvent;
    await act(async () => {
      event = press({ key: 'z', metaKey: true });
    });
    expect(event.defaultPrevented).toBe(true);
    expect(title()).toBe('Original');
    await act(async () => void press({ key: 'z', ctrlKey: true, shiftKey: true }));
    expect(title()).toBe('Renamed');
    await act(async () => void press({ key: 'z', ctrlKey: true }));
    expect(title()).toBe('Original');
    await act(async () => void press({ key: 'y', ctrlKey: true }));
    expect(title()).toBe('Renamed');
    // Cmd+Y is not redo on a Mac.
    await act(async () => void press({ key: 'z', metaKey: true }));
    await act(async () => void press({ key: 'y', metaKey: true }));
    expect(title()).toBe('Original');

    await setMode('learning');
    await act(async () => void press({ key: 'y', ctrlKey: true }));
    expect(title()).toBe('Original');
  });

  it('are absent in learning mode, even while the chrome root is still mounted', async () => {
    await renderPane();
    expect(undoButton()).toBeNull();
    await setMode('editing');
    expect(undoButton()).not.toBeNull();
    await setMode('learning');
    expect(undoButton()).toBeNull();
    expect(redoButton()).toBeNull();
  });

  it('stay with the editor in full screen, where editing works too', async () => {
    await renderPane();
    await setMode('editing');
    await renderPane({ fullscreen: true });
    expect(byTestId('workbench-fullscreen-header')!.contains(undoButton())).toBe(true);
    await renderPane({ fullscreen: false });
    expect(byTestId('workbench-editor-header')!.contains(undoButton())).toBe(true);
  });

  it('are absent for a read-only course and a hidden pane', async () => {
    await renderPane();
    await setMode('editing');
    await renderPane({ readOnly: true });
    expect(undoButton()).toBeNull();
    await renderPane({ readOnly: false, hidden: true });
    expect(undoButton()).toBeNull();
  });
});

describe('the standalone editor', () => {
  it('keeps undo and redo in its command bar', async () => {
    await mount(
      createElement(
        TooltipProvider,
        null,
        createElement(EditChromeRoot, {
          scene: { id: 'scene-1', type: 'slide', title: 'Scene' } as Scene,
          isEditable: true,
        }),
      ),
    );
    expect(undoButton()).toBeNull();
    const standaloneUndo = byTestId('edit-undo')!;
    expect(standaloneUndo.disabled).toBe(true);
    await act(async () =>
      commitCourseEdit({}, () =>
        useStageStore.getState().updateScene('scene-1', { title: 'Renamed' }),
      ),
    );
    expect(standaloneUndo.disabled).toBe(false);
    await act(async () => standaloneUndo.click());
    expect(useStageStore.getState().scenes[0].title).toBe('Original');
    expect(byTestId('edit-redo')!.disabled).toBe(false);
  });
});
