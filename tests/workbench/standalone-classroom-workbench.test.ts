// @vitest-environment jsdom

/**
 * The standalone classroom (`/classroom/[id]`) where the workbench is part of
 * the build: the same chrome as the workspace's full-screen classroom. Learn |
 * Edit flips this page's own editor, and the collapse glyph opens the course in
 * the workspace with it in the right pane. A classroom hosted by the workspace
 * draws no header of its own (the pane does).
 */
import { act, createElement, forwardRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStageStore } from '@/lib/store/stage';
import { WorkbenchPanelProvider } from '@/lib/workbench/panel-context';

const probe = vi.hoisted(() => ({
  playbackProps: null as Record<string, unknown> | null,
  replace: vi.fn(),
  workbench: true,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: probe.replace }) }));
vi.mock('@/lib/config/feature-flags', () => ({
  isMaicEditorEnabled: () => true,
  isWorkbenchEnabled: () => probe.workbench,
}));
vi.mock('@/lib/edit/preload-editor', () => ({
  preloadEditor: () => Promise.resolve(),
  isEditorPreloaded: () => false,
}));
vi.mock('@/lib/workbench/session-store', () => ({
  useWorkbenchStore: (s: (v: unknown) => unknown) => s({ setPanelOpen: vi.fn() }),
}));
vi.mock('@/components/edit/EditChromeRoot', () => ({ EditChromeRoot: () => null }));
vi.mock('@/components/edit/PlaybackChromeRoot', () => ({
  PlaybackChromeRoot: forwardRef(function Playback(props: Record<string, unknown>) {
    probe.playbackProps = props;
    return null;
  }),
}));
vi.mock('@/components/scene-renderers/InteractiveIframeHost', () => ({
  InteractiveIframeHost: () => null,
}));
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: { div: ({ children }: { children: ReactNode }) => createElement('div', null, children) },
}));

import { Stage } from '@/components/stage';

let root: Root;

async function render(hosted = false) {
  const stage = createElement(Stage, { classroomId: 'stage-1' });
  await act(async () =>
    root.render(hosted ? createElement(WorkbenchPanelProvider, null, stage) : stage),
  );
  // The runtime probe answers, then the header learns the workspace is reachable.
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
}

function runtime(enabled: boolean) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ enabled }) }));
}

beforeEach(() => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  probe.playbackProps = null;
  probe.replace.mockClear();
  probe.workbench = true;
  runtime(true);
  useStageStore.setState({
    stage: { id: 'stage-1' } as never,
    scenes: [{ id: 'scene-1', type: 'slide' }] as never,
    currentSceneId: 'scene-1',
    generatingOutlines: [],
    isOwner: true,
    readOnly: false,
    courseGenerating: false,
    mode: 'playback',
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('the standalone classroom with the workbench', () => {
  it('offers Learn | Edit on this page and the way into the workspace', async () => {
    await render();
    const props = probe.playbackProps!;
    expect(props.workbenchControls).toBe(true);
    expect(props.hideHeader).toBe(false);
    // Edit flips this page's own editor; it no longer navigates anywhere.
    expect(props.onEnterProMode).toBeTypeOf('function');
    expect(props.onOpenInWorkspace).toBeTypeOf('function');
  });

  it('opens the course in the workspace, in the right pane', async () => {
    await render();
    await act(async () => (probe.playbackProps!.onOpenInWorkspace as () => void)());
    expect(probe.replace).toHaveBeenCalledWith('/workspace?course=stage-1');
  });

  it('keeps Learn | Edit but no way in while the workspace is unreachable', async () => {
    runtime(false);
    await render();
    expect(probe.playbackProps!.workbenchControls).toBe(true);
    expect(probe.playbackProps!.onOpenInWorkspace).toBeUndefined();
  });

  it('offers no edit control to someone who does not own the course', async () => {
    useStageStore.setState({ isOwner: false });
    await render();
    expect(probe.playbackProps!.onEnterProMode).toBeUndefined();
    expect(probe.playbackProps!.onOpenInWorkspace).toBeTypeOf('function');
  });
});

describe('the standalone classroom without the workbench', () => {
  it('keeps today’s header: the edit switch, nothing about the workspace', async () => {
    probe.workbench = false;
    await render();
    const props = probe.playbackProps!;
    expect(props.workbenchControls).toBe(false);
    expect(props.onOpenInWorkspace).toBeUndefined();
    expect(props.onEnterProMode).toBeTypeOf('function');
  });
});

describe('a classroom hosted by the workspace', () => {
  it('draws no header of its own, at either size', async () => {
    await render(true);
    const props = probe.playbackProps!;
    expect(props.hideHeader).toBe(true);
    expect(props.onEnterProMode).toBeUndefined();
    expect(props.onOpenInWorkspace).toBeUndefined();
  });
});
