// @vitest-environment jsdom

/**
 * The workbench hides the editor's command bar, so undo/redo reach the classroom
 * pane's header through a portal. These tests mount the real pane, chrome root
 * and shell; only the surface and the heavy siblings around them are stubbed.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { SceneEditorSurface, SurfaceHistory } from '@/lib/edit/scene-editor-surface';
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

const undo = vi.fn();
const redo = vi.fn();
const useFlags = create(() => ({ canUndo: false, canRedo: false }));

function surfaceWithHistory(sceneType: SceneType): SceneEditorSurface {
  return {
    ...NOOP_SURFACE,
    sceneType,
    useSurfaceState: () => {
      const flags = useFlags();
      const history: SurfaceHistory = { ...flags, undo, redo };
      return { ...NOOP_SURFACE.useSurfaceState(), history };
    },
  };
}

let root: Root | null = null;
type PaneProps = { readOnly: boolean; playback: boolean; hidden: boolean };

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
      playback: false,
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
  undo.mockClear();
  redo.mockClear();
  useFlags.setState({ canUndo: false, canRedo: false });
  sceneEditorRegistry.register(surfaceWithHistory('slide'));
  sceneEditorRegistry.register(surfaceWithHistory('quiz'));
  localStorage.clear();
  useStageStore.setState({
    stage: { id: 'stage-1', name: 'Course' } as never,
    scenes: [{ id: 'scene-1' }] as never,
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
  it.each(['slide', 'quiz'])('sit just left of the mode group while editing a %s', async (type) => {
    probe.sceneType = type;
    await renderPane();
    await setMode('editing');

    const header = byTestId('workbench-editor-header')!;
    const redoControl = redoButton()!;
    expect(header.contains(undoButton())).toBe(true);
    expect(header.contains(redoControl)).toBe(true);
    expect(redoControl.parentElement!.nextElementSibling).toBe(
      byTestId('workbench-mode-learning')!.parentElement,
    );
    expect(undoButton()!.getAttribute('aria-label')).toBe('edit.undo');
    expect(undoButton()!.title).toBe('edit.undo');
    expect(redoControl.getAttribute('aria-label')).toBe('edit.redo');
    expect(redoControl.title).toBe('edit.redo');
  });

  it('follow canUndo and canRedo, and invoke the surface history', async () => {
    await renderPane();
    await setMode('editing');
    expect(undoButton()!.disabled).toBe(true);
    expect(redoButton()!.disabled).toBe(true);

    await act(async () => useFlags.setState({ canUndo: true }));
    expect(undoButton()!.disabled).toBe(false);
    expect(redoButton()!.disabled).toBe(true);
    await act(async () => undoButton()!.click());
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).not.toHaveBeenCalled();

    await act(async () => useFlags.setState({ canUndo: false, canRedo: true }));
    expect(undoButton()!.disabled).toBe(true);
    expect(redoButton()!.disabled).toBe(false);
    await act(async () => redoButton()!.click());
    expect(redo).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledTimes(1);
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

  it('are absent in playback and return afterwards', async () => {
    await renderPane();
    await setMode('editing');
    await renderPane({ playback: true });
    expect(undoButton()).toBeNull();
    await renderPane({ playback: false });
    expect(undoButton()).not.toBeNull();
  });

  it('are absent for a read-only course and a hidden pane', async () => {
    await renderPane();
    await setMode('editing');
    await renderPane({ readOnly: true });
    expect(undoButton()).toBeNull();
    await renderPane({ readOnly: false, hidden: true });
    expect(undoButton()).toBeNull();
  });

  it('are absent on a scene type with no history', async () => {
    probe.sceneType = 'interactive';
    await renderPane();
    await setMode('editing');
    expect(byTestId('workbench-mode-editing')!.getAttribute('aria-pressed')).toBe('true');
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
    expect(document.querySelector('svg.lucide-undo2')).not.toBeNull();
    expect(document.querySelector('svg.lucide-redo2')).not.toBeNull();
  });
});
