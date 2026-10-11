// @vitest-environment jsdom
/**
 * Exercise the real Stage → InteractiveIframeHost repair capability.
 * Source-string assertions cannot catch a hosted fallback in a different branch.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  isOwner: true,
  readOnly: false,
  generating: false,
  hosted: false,
  playback: false,
  editPinned: false,
  directRepair: undefined as undefined | ((sceneId: string, error: string) => void),
  iframeRepair: undefined as undefined | ((sceneId: string, error: string) => void),
  routeReplace: vi.fn(),
  stagedHandoff: vi.fn(() => true),
  runtimeEnabled: true,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: state.routeReplace }) }));
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: { div: 'div' },
}));
vi.mock('@/lib/store', () => {
  const get = () => ({
    mode: 'playback',
    setMode: vi.fn(),
    scenes: [{ id: 'scene-1' }],
    currentSceneId: 'scene-1',
    generatingOutlines: [],
    stage: { id: 'course-a' },
    isOwner: state.isOwner,
    readOnly: state.readOnly,
    courseGenerating: state.generating,
    getCurrentScene: () => ({ id: 'scene-1' }),
  });
  return {
    useStageStore: Object.assign(
      (selector?: (s: ReturnType<typeof get>) => unknown) => (selector ? selector(get()) : get()),
      { getState: get },
    ),
  };
});
vi.mock('@/lib/edit/stage-mode', () => ({
  isCurrentSceneEditable: () => true,
  isHostedSceneEditable: () => true,
  resolveStageChromeMode: () => 'loading',
}));
vi.mock('@/lib/config/feature-flags', () => ({
  isProWorkbenchEnabled: () => true,
  isMaicEditorEnabled: () => true,
}));
vi.mock('@/components/edit/EditChromeRoot', () => ({ EditChromeRoot: () => null }));
vi.mock('@/components/edit/PlaybackChromeRoot', () => ({ PlaybackChromeRoot: () => null }));
vi.mock('@/components/scene-renderers/InteractiveIframeHost', () => ({
  InteractiveIframeHost: ({
    onRequestInteractiveRepair,
  }: {
    onRequestInteractiveRepair?: (sceneId: string, error: string) => void;
  }) => {
    state.iframeRepair = onRequestInteractiveRepair;
    return null;
  },
}));
vi.mock('@/lib/edit/transitions', () => ({ CHROME_EASE: [] }));
vi.mock('@/lib/edit/enter-edit-mode', () => ({ enterEditMode: vi.fn() }));
vi.mock('@/lib/edit/preload-editor', () => ({
  isEditorPreloaded: () => false,
  preloadEditor: () => Promise.resolve(),
}));
vi.mock('@/components/workbench/WorkbenchReturnControl', () => ({
  WorkbenchReturnControl: () => null,
}));
vi.mock('@/lib/workbench/classroom-back-control', () => ({
  resolveClassroomBackControl: () => 'hidden',
}));
vi.mock('@/lib/workbench/classroom-header-controls', () => ({
  resolveClassroomHeaderControls: () => ({
    showHeader: false,
    showGlobalControls: false,
    showCourseActions: false,
  }),
}));
vi.mock('@/lib/workbench/session-store', () => {
  const get = () => ({ setPanelOpen: vi.fn(), setPlaybackOn: vi.fn() });
  return {
    useWorkbenchStore: Object.assign(
      (selector: (s: ReturnType<typeof get>) => unknown) => selector(get()),
      { getState: get },
    ),
  };
});
vi.mock('@/lib/workbench/panel-context', () => ({
  useWorkbenchPanelState: () => ({
    hosted: state.hosted,
    visible: true,
    playback: state.playback,
    editPinned: state.editPinned,
    requestInteractiveRepair: state.directRepair,
  }),
}));
vi.mock('@/lib/workbench/workspace-panes', () => ({
  workspaceHref: ({ courseId }: { courseId: string }) => `/workspace?course=${courseId}`,
}));
vi.mock('@/lib/workbench/pro-playback-exit', () => ({
  exitProPlaybackToStandalone: vi.fn(),
}));
vi.mock('@/lib/workbench/interactive-repair-handoff', () => ({
  stageInteractiveRepairHandoff: state.stagedHandoff,
}));

import { Stage } from '@/components/stage';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  state.isOwner = true;
  state.readOnly = false;
  state.generating = false;
  state.hosted = false;
  state.playback = false;
  state.editPinned = false;
  state.directRepair = undefined;
  state.iframeRepair = undefined;
  state.runtimeEnabled = true;
  state.routeReplace.mockClear();
  state.stagedHandoff.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ enabled: state.runtimeEnabled }),
    })),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mountStage() {
  await act(async () => {
    root.render(createElement(Stage));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('interactive repair Stage entry behavior', () => {
  it('does not fall back to standalone handoff in hosted edit when callback is absent', async () => {
    state.hosted = true;
    state.editPinned = true;
    await mountStage();
    expect(state.iframeRepair).toBeUndefined();
    expect(state.stagedHandoff).not.toHaveBeenCalled();
    expect(state.routeReplace).not.toHaveBeenCalled();
  });

  it('uses only the supplied callback when hosted edit is writable', async () => {
    const callback = vi.fn();
    state.hosted = true;
    state.editPinned = true;
    state.directRepair = callback;
    await mountStage();
    expect(state.iframeRepair).toBe(callback);
    await act(async () => state.iframeRepair?.('scene-1', 'ReferenceError'));
    expect(callback).toHaveBeenCalledExactlyOnceWith('scene-1', 'ReferenceError');
    expect(state.stagedHandoff).not.toHaveBeenCalled();
    expect(state.routeReplace).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'owner false', owner: false, readOnly: false, generating: false },
    { label: 'readOnly true', owner: true, readOnly: true, generating: false },
    { label: 'course generating', owner: true, readOnly: false, generating: true },
  ])('hides hosted edit repair for $label', async ({ owner, readOnly, generating }) => {
    state.hosted = true;
    state.editPinned = true;
    state.directRepair = vi.fn();
    state.isOwner = owner;
    state.readOnly = readOnly;
    state.generating = generating;
    await mountStage();
    expect(state.iframeRepair).toBeUndefined();
    expect(state.stagedHandoff).not.toHaveBeenCalled();
  });

  it('permits a writable standalone handoff without submitting a message', async () => {
    await mountStage();
    expect(state.iframeRepair).toBeTypeOf('function');
    await act(async () => state.iframeRepair?.('scene-1', 'ReferenceError'));
    expect(state.stagedHandoff).toHaveBeenCalledExactlyOnceWith({
      courseId: 'course-a',
      sceneId: 'scene-1',
      error: 'ReferenceError',
    });
    expect(state.routeReplace).toHaveBeenCalledExactlyOnceWith('/workspace?course=course-a');
    expect(fetch).toHaveBeenCalledTimes(1); // only runtime capability check
  });

  it('does not offer standalone handoff while course is generating', async () => {
    state.generating = true;
    await mountStage();
    expect(state.iframeRepair).toBeUndefined();
    expect(state.stagedHandoff).not.toHaveBeenCalled();
  });
});
