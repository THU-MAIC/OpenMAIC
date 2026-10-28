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
let props = { courseId: 'stage-1', hidden: false, playback: false, readOnly: false };
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
          onCloseCourse: vi.fn(),
        },
        hidden: props.hidden,
        playback: props.playback,
        readOnly: props.readOnly,
      }),
    ),
  );
}
async function click(mode: string) {
  await act(async () => button(mode).click());
}

beforeEach(() => {
  props = { courseId: 'stage-1', hidden: false, playback: false, readOnly: false };
  probe.states.length = 0;
  setPlaybackOn.mockClear();
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

  it('folding drops chrome, and full-screen playback preserves the per-course preference', async () => {
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
    await render({ playback: true });
    expect(chrome()).toBe('playback');
    await render({ playback: false });
    expect(chrome()).toBe('edit');
    expect(readClassroomMode('stage-1')).toBe('editing');
  });
});
