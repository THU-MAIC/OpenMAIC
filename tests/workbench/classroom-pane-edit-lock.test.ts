// @vitest-environment jsdom

/**
 * The right pane's classroom is edit-locked.
 *
 * The lock lives at the pane, not in the entry paths: `WorkspaceClassroomPane`
 * is the single element that mounts a classroom into the workspace, so this
 * exercises the real chain — pane → `WorkbenchPanelProvider` → the panel state
 * a hosted classroom reads → `resolveStageChromeMode` — instead of asserting
 * the resolver in isolation. What the classroom document or the stage store
 * says about play/edit is deliberately fed in as hostile input.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveStageChromeMode, type StageChromeModeContext } from '@/lib/edit/stage-mode';
import { useWorkbenchPanelState, type WorkbenchPanelState } from '@/lib/workbench/panel-context';

const probe = vi.hoisted(() => ({ states: [] as WorkbenchPanelState[] }));
const setPlaybackOn = vi.fn();

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
// Stand in for the real classroom and report the panel state it would host
// its chrome decision on.
vi.mock('@/components/classroom/ClassroomSurface', () => ({
  ClassroomSurface: () => {
    probe.states.push(useWorkbenchPanelState());
    return null;
  },
}));
vi.mock('@/lib/workbench/use-workbench-pro-edit', () => ({
  useWorkbenchProEditing: () => undefined,
}));
vi.mock('@/components/workbench/workspace/WorkspaceCourseTabs', () => ({
  WorkspaceCourseTabs: () => null,
}));
vi.mock('@/lib/store/stage', () => ({
  useStageStore: (selector: (state: { scenes: unknown[] }) => unknown) =>
    selector({ scenes: [{ id: 'scene-1' }] }),
}));
vi.mock('@/lib/workbench/session-store', () => ({
  useWorkbenchStore: (selector: (state: { setPlaybackOn: () => void }) => unknown) =>
    selector({ setPlaybackOn }),
}));

import { WorkspaceClassroomPane } from '@/components/workbench/workspace/WorkspaceClassroomPane';

let root: Root | null = null;

async function mountPane(props: { hidden: boolean; playback: boolean }): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(WorkspaceClassroomPane, {
        browser: {
          tabs: [{ id: 'stage-1', name: 'Course' }],
          activeCourseId: 'stage-1',
          onActivateCourse: vi.fn(),
          onCloseCourse: vi.fn(),
        },
        readOnly: false,
        ...props,
      }),
    ),
  );
}

/** The chrome a hosted classroom would resolve for the pane's first render. */
function hostedChrome(panel: WorkbenchPanelState, overrides: Partial<StageChromeModeContext> = {}) {
  return resolveStageChromeMode({
    // Hostile input: the stage store's transient mode always says playback for
    // a course that has just been loaded (`loadFromStorage` resets it), and a
    // stage persisted mid-learning would say the same.
    storedMode: 'playback',
    hosted: panel.hosted,
    workbenchShowingClassroom: panel.hosted && panel.editPinned,
    workbenchLearning: panel.hosted && panel.playback,
    isEditable: true,
    hasCurrentScene: true,
    stageMatchesHost: true,
    editorReady: true,
    editorLoadFailed: false,
    ...overrides,
  });
}

beforeEach(() => {
  probe.states.length = 0;
  setPlaybackOn.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('workspace classroom pane edit lock', () => {
  it('locks the classroom it mounts to edit on the first render', async () => {
    await mountPane({ hidden: false, playback: false });

    expect(probe.states.length).toBeGreaterThan(0);
    // Not "the first render happened to be edit": every render the pane
    // produced declared the lock.
    for (const panel of probe.states) {
      expect(panel.hosted).toBe(true);
      expect(panel.editPinned).toBe(true);
      expect(hostedChrome(panel)).toBe('edit');
    }
  });

  it('holds the lock for a freshly created classroom that has no scene yet', async () => {
    await mountPane({ hidden: false, playback: false });
    const panel = probe.states[0];

    // The agent has just created the course: the document is in the store but
    // generation has not produced a scene, so the edit chrome cannot mount
    // yet. This used to resolve to the full playback chrome — speed control,
    // play button, learner avatars, mic bar — and flip to edit once the first
    // scene landed.
    expect(hostedChrome(panel, { isEditable: false, hasCurrentScene: false })).toBe('loading');
    // ...and the moment the first scene exists it is edit, with no playback
    // frame in between.
    expect(hostedChrome(panel)).toBe('edit');
  });

  it('cannot be flipped by classroom state that says playback', async () => {
    await mountPane({ hidden: false, playback: false });
    const panel = probe.states[0];

    for (const storedMode of ['playback', 'autonomous', 'edit'] as const) {
      expect(hostedChrome(panel, { storedMode })).toBe('edit');
    }
  });

  it('never resolves playback while the pane holds the lock', async () => {
    await mountPane({ hidden: false, playback: false });
    const panel = probe.states[0];
    const booleans = [false, true];

    for (const isEditable of booleans) {
      for (const hasCurrentScene of booleans) {
        for (const stageMatchesHost of booleans) {
          for (const editorReady of booleans) {
            for (const editorLoadFailed of booleans) {
              expect(
                hostedChrome(panel, {
                  isEditable,
                  hasCurrentScene,
                  stageMatchesHost,
                  editorReady,
                  editorLoadFailed,
                }),
              ).not.toBe('playback');
            }
          }
        }
      }
    }
  });

  it('does not park the learning chrome behind a folded pane', async () => {
    await mountPane({ hidden: true, playback: false });
    const panel = probe.states[0];

    expect(panel.editPinned).toBe(false);
    // Folded is not learning: the editor drops, but unfolding must not
    // cross-fade a classroom's playback chrome out over the reopened pane.
    expect(hostedChrome(panel)).toBe('loading');
  });

  it('releases the lock only through Start Learning', async () => {
    await mountPane({ hidden: false, playback: false });
    const button = document.querySelector<HTMLButtonElement>(
      '[data-testid="workbench-start-learning"]',
    );
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(setPlaybackOn).toHaveBeenCalledWith(true);

    // The pane re-rendered with that intent is the one state that hands the
    // classroom back to the learning chrome.
    await act(async () => root?.unmount());
    root = null;
    probe.states.length = 0;
    await mountPane({ hidden: false, playback: true });
    const panel = probe.states[0];

    expect(panel.editPinned).toBe(false);
    expect(hostedChrome(panel)).toBe('playback');
  });
});
