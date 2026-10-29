// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveStageChromeMode } from '@/lib/edit/stage-mode';
import { useWorkbenchPanelState, type WorkbenchPanelState } from '@/lib/workbench/panel-context';
import { useStageStore } from '@/lib/store/stage';
import { readClassroomMode, writeClassroomMode } from '@/lib/workbench/classroom-mode';

const probe = vi.hoisted(() => ({
  states: [] as WorkbenchPanelState[],
}));
const setPlaybackOn = vi.fn();

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/classroom/ClassroomSurface', () => ({
  ClassroomSurface: () => {
    const panel = useWorkbenchPanelState();
    probe.states.push(panel);
    return null;
  },
}));
vi.mock('@/components/stage/header-controls', () => ({ HeaderControls: () => null }));
vi.mock('@/lib/workbench/use-workbench-pro-edit', () => ({ useWorkbenchProEditing: () => {} }));
vi.mock('@/components/workbench/workspace/WorkspaceCourseTabs', () => ({
  WorkspaceCourseTabs: () => null,
}));
vi.mock('@/lib/workbench/session-store', () => ({
  useWorkbenchStore: (selector: (state: { setPlaybackOn: () => void }) => unknown) =>
    selector({ setPlaybackOn }),
}));

import { WorkspaceClassroomPane } from '@/components/workbench/workspace/WorkspaceClassroomPane';

let root: Root | null = null;
let props = { courseId: 'stage-1', hidden: false, fullscreen: false, readOnly: false };
const onCloseCourse = vi.fn();
const button = (mode: string) =>
  document.querySelector<HTMLButtonElement>(`[data-testid="workbench-mode-${mode}"]`)!;
const panel = () => probe.states.at(-1)!;
const chrome = () =>
  resolveStageChromeMode({
    storedMode: 'edit',
    hosted: panel().hosted,
    workbenchShowingClassroom: panel().editPinned,
    workbenchLearning: panel().learning && panel().visible,
    isEditable: true,
    hasCurrentScene: true,
    stageMatchesHost: true,
    editorReady: true,
    editorLoadFailed: false,
  });

async function render(next: Partial<typeof props> = {}) {
  props = { ...props, ...next };
  if (!root) {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () =>
    root!.render(
      createElement(WorkspaceClassroomPane, {
        browser: {
          tabs: [{ id: props.courseId, name: 'Course' }],
          activeCourseId: props.courseId,
          onActivateCourse: vi.fn(),
          onCloseCourse,
        },
        hidden: props.hidden,
        fullscreen: props.fullscreen,
        readOnly: props.readOnly,
      }),
    ),
  );
}
async function click(mode: string) {
  await act(async () => button(mode).click());
}

beforeEach(() => {
  props = { courseId: 'stage-1', hidden: false, fullscreen: false, readOnly: false };
  probe.states.length = 0;
  setPlaybackOn.mockClear();
  onCloseCourse.mockClear();
  localStorage.clear();
  useStageStore.setState({
    stage: { id: 'stage-1', name: 'Course' } as never,
    scenes: [{ id: 'scene-1' }] as never,
    isOwner: true,
    readOnly: false,
    courseGenerating: false,
  });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe('classroom tab modes', () => {
  it('starts in learning and switches in the same pane', async () => {
    await render();
    expect(chrome()).toBe('playback');
    await click('editing');
    expect(chrome()).toBe('edit');
    expect(setPlaybackOn).not.toHaveBeenCalled();
    expect(readClassroomMode('stage-1')).toBe('editing');
    await click('learning');
    expect(chrome()).toBe('playback');
    expect(readClassroomMode('stage-1')).toBe('learning');
  });

  it('isolates course preferences and restores editing after a remount', async () => {
    await render();
    await click('editing');
    await act(async () => useStageStore.setState({ stage: { id: 'stage-2' } as never }));
    await render({ courseId: 'stage-2' });
    expect(chrome()).toBe('playback');
    await act(async () => useStageStore.setState({ stage: { id: 'stage-1' } as never }));
    await render({ courseId: 'stage-1' });
    expect(chrome()).toBe('edit');
    await act(async () => root!.unmount());
    root = null;
    await render();
    expect(chrome()).toBe('edit');
    expect(readClassroomMode('stage-2')).toBe('learning');
  });

  it('keeps in-memory course choices when browser storage is denied', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      await render();
      await click('editing');
      await act(async () => useStageStore.setState({ stage: { id: 'stage-2' } as never }));
      await render({ courseId: 'stage-2' });
      expect(chrome()).toBe('playback');
      await act(async () => useStageStore.setState({ stage: { id: 'stage-1' } as never }));
      await render({ courseId: 'stage-1' });
      expect(chrome()).toBe('edit');
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('overrides saved editing during generation, then restores it without overwriting memory', async () => {
    writeClassroomMode('stage-1', 'editing');
    await act(async () => useStageStore.setState({ courseGenerating: true }));
    await render();
    expect(chrome()).toBe('playback');
    expect(button('editing').disabled).toBe(true);
    await click('editing');
    expect(readClassroomMode('stage-1')).toBe('editing');
    await act(async () => useStageStore.setState({ courseGenerating: false }));
    expect(chrome()).toBe('edit');
    await act(async () => useStageStore.setState({ courseGenerating: true }));
    expect(chrome()).toBe('playback');
    expect(panel().editPinned).toBe(false);
  });

  it('gates every edit request on ownership, access and the loaded course', async () => {
    writeClassroomMode('stage-1', 'editing');
    await render({ readOnly: true });
    expect(chrome()).toBe('playback');
    expect(button('editing').disabled).toBe(true);
    await render({ readOnly: false });
    for (const patch of [
      { isOwner: false },
      { isOwner: true, readOnly: true },
      { readOnly: false, stage: { id: 'other' } as never },
    ]) {
      await act(async () => useStageStore.setState(patch));
      expect(chrome()).toBe('playback');
      expect(button('editing').disabled).toBe(true);
    }
  });

  it('folding drops chrome, and full screen keeps the per-course preference', async () => {
    writeClassroomMode('stage-1', 'editing');
    await render({ hidden: true });
    expect(chrome()).toBe('loading');
    await render({ hidden: false });
    expect(chrome()).toBe('edit');
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="workbench-start-learning"]')!
        .click(),
    );
    expect(setPlaybackOn).toHaveBeenCalledWith(true);
    await render({ fullscreen: true });
    // Full screen is a size, not a mode: editing stays editing.
    expect(chrome()).toBe('edit');
    await render({ fullscreen: false });
    expect(chrome()).toBe('edit');
    expect(readClassroomMode('stage-1')).toBe('editing');
  });
});

describe('the full-screen classroom', () => {
  const q = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

  it('keeps a header: leave on the left, Learn | Edit and collapse on the right', async () => {
    await render({ fullscreen: true });
    expect(q('workbench-fullscreen-header')).not.toBeNull();
    expect(q('workbench-editor-header')).toBeNull();
    expect(q('workbench-leave-course')).not.toBeNull();
    expect(q('workbench-mode-learning')).not.toBeNull();
    expect(q('workbench-exit-fullscreen')).not.toBeNull();
    // The collapse sits where the split view's maximize sits: the last control.
    const header = q('workbench-fullscreen-header')!;
    expect(header.lastElementChild?.getAttribute('data-testid')).toBe('workbench-exit-fullscreen');
  });

  it('switches to editing in full screen', async () => {
    await render({ fullscreen: true });
    expect(chrome()).toBe('playback');
    await click('editing');
    expect(chrome()).toBe('edit');
    expect(setPlaybackOn).not.toHaveBeenCalled();
  });

  it('collapses back to the split view with the course still open', async () => {
    await render({ fullscreen: true });
    await act(async () => q('workbench-exit-fullscreen')!.click());
    expect(setPlaybackOn).toHaveBeenCalledWith(false);
    expect(onCloseCourse).not.toHaveBeenCalled();
  });

  it('collapses on an unhandled Escape, and leaves an Escape someone handled alone', async () => {
    await render({ fullscreen: true });
    const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    handled.preventDefault();
    await act(async () => window.dispatchEvent(handled));
    expect(setPlaybackOn).not.toHaveBeenCalled();
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
    );
    expect(setPlaybackOn).toHaveBeenCalledWith(false);
  });

  it('does not listen for Escape in the split view', async () => {
    await render({ fullscreen: false });
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
    );
    expect(setPlaybackOn).not.toHaveBeenCalled();
  });

  it('leaves this course: closes its tab and returns to the workspace', async () => {
    await render({ fullscreen: true });
    await act(async () => q('workbench-leave-course')!.click());
    expect(setPlaybackOn).toHaveBeenCalledWith(false);
    expect(onCloseCourse).toHaveBeenCalledWith('stage-1');
  });
});
