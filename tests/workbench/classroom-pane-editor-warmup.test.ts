// @vitest-environment jsdom

/**
 * The classroom pane warms the editor chunk while a course sits in Learn mode,
 * so the first switch to Edit does not wait on its download.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStageStore } from '@/lib/store/stage';
import { writeClassroomMode } from '@/lib/workbench/classroom-mode';

const probe = vi.hoisted(() => ({
  preload: (() => Promise.resolve()) as () => Promise<void>,
  calls: 0,
  preloaded: false,
}));

vi.mock('@/lib/edit/preload-editor', () => ({
  preloadEditor: () => {
    probe.calls += 1;
    return probe.preload();
  },
  isEditorPreloaded: () => probe.preloaded,
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/classroom/ClassroomSurface', () => ({ ClassroomSurface: () => null }));
vi.mock('@/components/stage/header-controls', () => ({ HeaderControls: () => null }));
vi.mock('@/lib/workbench/use-workbench-pro-edit', () => ({ useWorkbenchProEditing: () => {} }));
vi.mock('@/components/workbench/workspace/WorkspaceCourseTabs', () => ({
  WorkspaceCourseTabs: () => null,
}));
vi.mock('@/lib/workbench/session-store', () => ({
  useWorkbenchStore: (selector: (state: { setPlaybackOn: () => void }) => unknown) =>
    selector({ setPlaybackOn: vi.fn() }),
}));

import { WorkspaceClassroomPane } from '@/components/workbench/workspace/WorkspaceClassroomPane';
import { warmEditor } from '@/lib/edit/use-editor-warmup';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
/** Pending idle callbacks by handle; cancelling one drops it. */
let idle: Array<() => void> = [];
let idleHandles = new Map<number, () => void>();
let nextHandle = 0;
const cancelIdle = vi.fn((handle: number) => {
  const callback = idleHandles.get(handle);
  idleHandles.delete(handle);
  idle = idle.filter((pending) => pending !== callback);
});

type Props = { hidden: boolean; fullscreen: boolean; readOnly: boolean };
async function render(next: Partial<Props> = {}) {
  const props: Props = { hidden: false, fullscreen: false, readOnly: false, ...next };
  if (!root) {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () =>
    root!.render(
      createElement(WorkspaceClassroomPane, {
        browser: {
          tabs: [{ id: 'stage-1', name: 'Course' }],
          activeCourseId: 'stage-1',
          onActivateCourse: vi.fn(),
          onCloseCourse: vi.fn(),
        },
        ...props,
      }),
    ),
  );
}
const editButton = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="workbench-mode-editing"]')!;
async function runIdle() {
  const pending = idle;
  idle = [];
  await act(async () => {
    for (const callback of pending) callback();
  });
}
async function hoverAndFocusEdit() {
  await act(async () => {
    editButton().dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    editButton().dispatchEvent(new PointerEvent('pointerenter'));
    editButton().focus();
  });
}

beforeEach(() => {
  idle = [];
  idleHandles = new Map();
  cancelIdle.mockClear();
  probe.calls = 0;
  probe.preloaded = false;
  probe.preload = () => Promise.resolve();
  localStorage.clear();
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
    // Only the warm-up's own requests: other modules the pane loads (such as the
    // legacy browser import) may ask for idle time too, depending on timing.
    if (callback !== warmEditor) return ++nextHandle;
    // A fresh wrapper per request, so the same function scheduled twice is two entries.
    const pending = () => callback();
    idle.push(pending);
    const handle = ++nextHandle;
    idleHandles.set(handle, pending);
    return handle;
  });
  vi.stubGlobal('cancelIdleCallback', cancelIdle);
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('warming the editor from the classroom pane', () => {
  it('loads the editor on idle while the course is shown in Learn mode', async () => {
    await render();
    expect(probe.calls).toBe(0);
    expect(idle).toHaveLength(1);
    await runIdle();
    expect(probe.calls).toBe(1);
  });

  it('starts sooner when the pointer or focus reaches the Edit control', async () => {
    await render();
    await hoverAndFocusEdit();
    expect(probe.calls).toBe(2);
  });

  it('never loads it when editing is not allowed', async () => {
    for (const patch of [
      { courseGenerating: true },
      { courseGenerating: false, isOwner: false },
      { isOwner: true, readOnly: true },
      { readOnly: false, scenes: [] as never },
    ]) {
      await act(async () => useStageStore.setState(patch));
      await render();
      await hoverAndFocusEdit();
      await runIdle();
      expect(probe.calls).toBe(0);
    }
    await render({ readOnly: true });
    await hoverAndFocusEdit();
    await runIdle();
    expect(probe.calls).toBe(0);
  });

  it('does not schedule a warm-up for a hidden pane', async () => {
    await render({ hidden: true });
    await runIdle();
    expect(probe.calls).toBe(0);
  });

  it('still warms the editor in full screen, where Edit is offered too', async () => {
    await render({ fullscreen: true });
    await runIdle();
    expect(probe.calls).toBe(1);
  });

  it('does not schedule a warm-up once the editor is already loaded', async () => {
    probe.preloaded = true;
    await render();
    expect(idle).toHaveLength(0);
  });

  it('cancels a pending idle warm-up when editing stops being allowed', async () => {
    await render();
    expect(idle).toHaveLength(1);
    await act(async () => useStageStore.setState({ courseGenerating: true }));
    expect(idle).toHaveLength(0);
    await runIdle();
    expect(probe.calls).toBe(0);
  });

  it('falls back to a timer where requestIdleCallback is missing', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('requestIdleCallback', undefined);
      await render();
      expect(probe.calls).toBe(0);
      await act(async () => vi.advanceTimersByTime(1000));
      expect(probe.calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows a failed warm-up so the pane and a later switch are unaffected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    probe.preload = () => Promise.reject(new Error('chunk failed'));
    await render();
    await runIdle();
    expect(probe.calls).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('warm-up failed'), expect.any(Error));
    // The pane still switches to Edit (the real switch retries the load).
    await act(async () => editButton().click());
    expect(editButton().getAttribute('aria-pressed')).toBe('true');
  });

  it('does not warm in Edit mode (the switch already loads it)', async () => {
    writeClassroomMode('stage-1', 'editing');
    await render();
    expect(editButton().getAttribute('aria-pressed')).toBe('true');
    expect(idle).toHaveLength(0);
  });
});
