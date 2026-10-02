// @vitest-environment jsdom

import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  whiteboardOpen: false,
  runtimeProjection: null as {
    stageId: string;
    lastSeq: number | null;
    whiteboard: import('@/lib/types/stage').Whiteboard | null;
  } | null,
  roundtableProps: undefined as Record<string, unknown> | undefined,
  canvasProps: undefined as Record<string, unknown> | undefined,
  piEnabled: true,
  coursewareReferenceEnabled: true,
  topicActive: false,
  engineMode: 'idle' as 'idle' | 'playing' | 'paused',
  engineOptions: undefined as
    | {
        onModeChange?: (mode: 'idle' | 'playing' | 'paused') => void;
        onProgress?: (snapshot: { actionIndex: number; sceneId: string }) => void;
        onUserInterrupt?: (text: string) => void;
        onComplete?: () => void;
      }
    | undefined,
  startLecture: vi.fn(),
  endSession: vi.fn(),
  engineStop: vi.fn(),
  engineStart: vi.fn(),
  engineContinuePlayback: vi.fn(),
  handleUserInterrupt: vi.fn(),
}));

const textElement = {
  id: 'text-1',
  type: 'text',
  content: '<p>First grounded fact</p>',
  defaultFontName: 'Arial',
  defaultColor: '#000',
  left: 0,
  top: 0,
  width: 100,
  height: 40,
  rotate: 0,
};
const shapeElement = {
  id: 'shape-1',
  type: 'shape',
  viewBox: [100, 100],
  path: 'M0 0',
  fixedRatio: false,
  fill: '#fff',
  left: 0,
  top: 0,
  width: 100,
  height: 40,
  rotate: 0,
};
const scene = {
  id: 'scene-1',
  stageId: 'stage-1',
  title: 'Slide',
  order: 0,
  type: 'slide',
  actions: [],
  content: {
    type: 'slide',
    canvas: { elements: [textElement, shapeElement] },
  },
};
const secondScene = {
  ...scene,
  id: 'scene-2',
  title: 'Second slide',
  order: 1,
};
const interactiveScene = {
  id: 'scene-interactive',
  stageId: 'stage-1',
  title: 'Projectile simulation',
  order: 0,
  type: 'interactive',
  actions: [],
  content: {
    type: 'interactive',
    widgetType: 'simulation',
    html: '<label for="angle-slider">Angle</label><input id="angle-slider" type="range" min="0" max="90" value="45">',
  },
};

const stageState = {
  mode: 'playback',
  stage: { id: 'stage-1', whiteboard: [] as import('@/lib/types/stage').Whiteboard[] },
  getCurrentScene: () =>
    stageState.scenes.find((candidate) => candidate.id === stageState.currentSceneId),
  scenes: [scene, secondScene] as Array<typeof scene | typeof interactiveScene>,
  currentSceneId: scene.id,
  setCurrentSceneId: vi.fn((sceneId: string) => {
    stageState.currentSceneId = sceneId;
  }),
  generatingOutlines: [],
  outlines: [],
};

vi.mock('@/lib/store', () => {
  const useStageStore = Object.assign(() => stageState, {
    use: {
      failedOutlines: () => [],
      generationComplete: () => true,
    },
    getState: () => stageState,
  });
  return { useStageStore };
});

vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: {
    use: {
      whiteboardOpen: () => mocks.whiteboardOpen,
      runtimeWhiteboardProjection: () => mocks.runtimeProjection,
      whiteboardClearing: () => false,
      setWhiteboardOpenManually: () => vi.fn(),
    },
    getState: () => ({
      whiteboardOpen: mocks.whiteboardOpen,
      runtimeWhiteboardProjection: mocks.runtimeProjection,
      whiteboardClearing: false,
    }),
  },
}));

const settingsState = {
  sidebarCollapsed: false,
  setSidebarCollapsed: vi.fn(),
  chatAreaWidth: 320,
  setChatAreaWidth: vi.fn(),
  chatAreaCollapsed: false,
  setChatAreaCollapsed: vi.fn(),
  setTTSMuted: vi.fn(),
  setTTSVolume: vi.fn(),
  selectedAgentIds: [],
  ttsMuted: false,
  ttsEnabled: false,
  ttsVolume: 1,
  playbackSpeed: 1,
  autoPlayLecture: false,
};
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: Object.assign(
    (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
    { getState: () => settingsState },
  ),
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'chat.lectureNotes.pageLabel') return `Page ${options?.n}`;
      const summaries: Record<string, string> = {
        'chat.elementReference.summary.noText': 'No text',
        'chat.elementReference.summary.emptyContent': 'No content',
        'chat.elementReference.summary.code': 'Code',
        'chat.elementReference.summary.line': 'Line',
        'chat.elementReference.summary.imageMetadata': 'Image (metadata only)',
        'chat.elementReference.summary.videoMetadata': 'Video (metadata only)',
        'chat.elementReference.summary.audioMetadata': 'Audio (metadata only)',
        'edit.element.text': 'Text',
        'edit.element.image': 'Image',
        'edit.element.shape': 'Shape',
        'edit.element.line': 'Line',
        'edit.element.chart': 'Chart',
        'edit.element.table': 'Table',
        'edit.element.latex': 'Formula',
        'edit.element.video': 'Video',
        'edit.element.audio': 'Audio',
        'edit.element.code': 'Code',
        'edit.sceneType.interactive': 'Interactive',
      };
      return summaries[key] ?? key;
    },
  }),
}));

vi.mock('@/components/stage/scene-sidebar', () => ({ SceneSidebar: () => null }));
vi.mock('@/components/header', () => ({ Header: () => null }));
vi.mock('@/components/canvas/canvas-area', async () => {
  const React = await import('react');
  return {
    CanvasArea: (props: Record<string, unknown>) => {
      mocks.canvasProps = props;
      return React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'pick-text',
          onClick: () =>
            (props.onPickElement as ((element: unknown) => void) | undefined)?.(textElement),
        },
        'pick text',
      );
    },
  };
});
vi.mock('@/components/roundtable', async () => {
  const React = await import('react');
  return {
    Roundtable: (props: Record<string, unknown>) => {
      mocks.roundtableProps = props;
      const pill = props.elementReferencePill as
        | { sceneLabel: string; displaySummary: string; elementType: string }
        | undefined;
      return React.createElement(
        'div',
        null,
        props.showElementReference
          ? React.createElement(
              'button',
              {
                type: 'button',
                'data-testid': 'toggle-pick',
                onClick: () => (props.onToggleElementPick as (() => void) | undefined)?.(),
              },
              'toggle pick',
            )
          : null,
        React.createElement(
          'button',
          {
            type: 'button',
            'data-testid': 'send',
            onClick: () =>
              (props.onMessageSend as ((message: string) => void) | undefined)?.('Explain this'),
          },
          'send',
        ),
        pill
          ? React.createElement(
              'div',
              { 'data-testid': 'owner-pill' },
              `${pill.sceneLabel} · ${pill.elementType} · ${pill.displaySummary}`,
            )
          : null,
      );
    },
  };
});
vi.mock('@/components/chat/chat-area', async () => {
  const React = await import('react');
  return {
    ChatArea: React.forwardRef(function MockChatArea(_props, ref) {
      React.useImperativeHandle(ref, () => ({
        sendMessage: mocks.sendMessage,
        endActiveSession: vi.fn().mockResolvedValue(undefined),
        endSession: mocks.endSession,
        startLecture: mocks.startLecture,
        addLectureMessage: vi.fn(),
        getLectureMessageId: vi.fn(),
        startDiscussion: vi.fn(),
        switchToTab: vi.fn(),
        resumeActiveLiveBuffer: vi.fn(),
        pauseActiveLiveBuffer: vi.fn(),
        stopActiveSession: vi.fn(),
        continueActiveSoftClosingSession: vi.fn(),
        getActiveSessionType: vi.fn(),
        pauseBuffer: vi.fn(),
        resumeBuffer: vi.fn(),
        resumeActiveSession: vi.fn(),
      }));
      return null;
    }),
  };
});

vi.mock('@/lib/playback', () => ({
  PlaybackEngine: class {
    constructor(
      _scenes: unknown,
      _actionEngine: unknown,
      _audioPlayer: unknown,
      options: {
        onModeChange?: (mode: 'idle' | 'playing' | 'paused') => void;
        onUserInterrupt?: (text: string) => void;
        onComplete?: () => void;
      },
    ) {
      mocks.engineOptions = options;
      options.onModeChange?.(mocks.engineMode);
    }
    stop() {
      mocks.engineStop();
    }
    getMode() {
      return mocks.engineMode;
    }
    isExhausted() {
      return false;
    }
    canJumpToAction() {
      return false;
    }
    jumpToAction() {
      return Promise.resolve(false);
    }
    handleUserInterrupt(text: string) {
      mocks.handleUserInterrupt(text);
      mocks.engineOptions?.onUserInterrupt?.(text);
    }
    start() {
      mocks.engineStart();
    }
    continuePlayback() {
      mocks.engineContinuePlayback();
    }
    pause() {}
    confirmDiscussion() {}
    skipDiscussion() {}
  },
  computePlaybackView: () => ({ kind: 'idle', isTopicActive: mocks.topicActive }),
  shouldAutoResumeLecture: () => false,
}));
vi.mock('@/lib/playback/action-navigation', () => ({
  canJumpWithinReconstructablePrefix: () => false,
  isUnsafePlaybackNavigationAction: () => false,
}));
vi.mock('@/lib/playback/action-resume', () => ({
  getActionResumeRestoreCursor: () => ({ actionIndex: 0, position: null }),
  clearActionResumePosition: vi.fn(),
  createActionResumePosition: vi.fn(),
  getActionResumeStorageKey: () => 'resume-key',
  readActionResumeState: () => null,
  saveActionResumePosition: vi.fn(),
}));
vi.mock('@/lib/playback/cursor', () => ({
  loadCursor: vi.fn().mockResolvedValue(null),
  saveCursor: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/action/engine', () => ({ ActionEngine: class {} }));
vi.mock('@/lib/utils/audio-player', () => ({
  createAudioPlayer: () => ({
    destroy: vi.fn(),
    setMuted: vi.fn(),
    setVolume: vi.fn(),
    setPlaybackRate: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-discussion-tts', () => ({
  useDiscussionTTS: () => ({
    cleanup: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    handleSegmentSealed: vi.fn(),
    shouldHold: vi.fn(() => false),
  }),
}));
vi.mock('@/lib/store/widget-iframe', () => ({
  useWidgetIframeStore: { getState: () => ({ getSendMessage: () => undefined }) },
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  agentsToParticipants: () => [],
  useAgentRegistry: Object.assign(
    (selector: (state: { agents: Record<string, unknown> }) => unknown) => selector({ agents: {} }),
    { getState: () => ({ getAgent: () => undefined }) },
  ),
}));
vi.mock('@/lib/config/feature-flags', () => ({
  isPiChatEnabled: () => mocks.piEnabled,
  isCoursewareReferenceEnabled: () => mocks.coursewareReferenceEnabled,
}));

import {
  PlaybackChromeRoot,
  type PlaybackChromeRootHandle,
} from '@/components/edit/PlaybackChromeRoot';

describe('PlaybackChromeRoot element-reference ownership', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.whiteboardOpen = false;
    mocks.runtimeProjection = null;
    stageState.stage.whiteboard = [];
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.roundtableProps = undefined;
    mocks.canvasProps = undefined;
    mocks.piEnabled = true;
    mocks.coursewareReferenceEnabled = true;
    mocks.topicActive = false;
    mocks.engineMode = 'idle';
    mocks.engineOptions = undefined;
    mocks.startLecture.mockReset();
    mocks.startLecture.mockResolvedValue('lecture-1');
    mocks.endSession.mockReset();
    mocks.endSession.mockResolvedValue(undefined);
    mocks.engineStop.mockReset();
    mocks.engineStart.mockReset();
    mocks.engineContinuePlayback.mockReset();
    mocks.handleUserInterrupt.mockReset();
    stageState.scenes = [scene, secondScene];
    stageState.currentSceneId = scene.id;
    stageState.setCurrentSceneId.mockClear();
    settingsState.autoPlayLecture = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function click(testId: string) {
    act(() => {
      container
        .querySelector(`[data-testid="${testId}"]`)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  async function renderOwner(props: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(createElement(PlaybackChromeRoot, props));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function rerenderOwner() {
    await act(async () => {
      root.render(createElement(PlaybackChromeRoot));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('selects the stage snapshot whiteboard and sends an identity-only reference', async () => {
    const board = {
      id: 'board',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [textElement as import('@openmaic/dsl').PPTElement],
    };
    mocks.whiteboardOpen = true;
    stageState.stage.whiteboard = [board];
    await renderOwner();
    expect(mocks.roundtableProps?.canPickSlideElement).toBe(true);
    click('toggle-pick');
    act(() =>
      (mocks.canvasProps?.onPickWhiteboardElement as (element: unknown) => void)(textElement),
    );
    expect(mocks.canvasProps?.elementPickActive).toBe(false);
    expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain(
      'whiteboard.title · Text · First grounded fact',
    );
    expect((mocks.roundtableProps?.canSendMessage as () => boolean)()).toBe(true);
    click('send');
    expect(mocks.sendMessage.mock.calls[0][1].elementReference).toEqual({
      kind: 'whiteboard_element',
      whiteboardId: 'board',
      elementId: 'text-1',
    });
    act(() =>
      mocks.sendMessage.mock.calls[0][1].onResponseAccepted(
        new Response('', { headers: { 'X-OpenMAIC-Element-Reference-Accepted': '1' } }),
      ),
    );
    expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();
  });

  it.each([false, true])(
    'disables selection under runtime authority (already armed: %s)',
    async (alreadyArmed) => {
      const board = {
        id: 'board',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [textElement as import('@openmaic/dsl').PPTElement],
      };
      mocks.whiteboardOpen = true;
      stageState.stage.whiteboard = [board];
      if (alreadyArmed) {
        await renderOwner();
        click('toggle-pick');
        expect(mocks.canvasProps?.elementPickActive).toBe(true);
      }
      mocks.runtimeProjection = { stageId: 'stage-1', lastSeq: 7, whiteboard: board };
      await renderOwner();
      expect(mocks.roundtableProps?.canPickSlideElement).toBe(false);
      click('toggle-pick');
      expect(mocks.canvasProps?.elementPickActive).toBe(false);
      act(() =>
        (mocks.canvasProps?.onPickWhiteboardElement as (element: unknown) => void)(textElement),
      );
      expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();
    },
  );

  it('keeps a stale whiteboard selection visible and blocks sending until reselected or removed', async () => {
    mocks.whiteboardOpen = true;
    stageState.stage.whiteboard = [
      {
        id: 'board',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [textElement as import('@openmaic/dsl').PPTElement],
      },
    ];
    await renderOwner();
    click('toggle-pick');
    act(() =>
      (mocks.canvasProps?.onPickWhiteboardElement as (element: unknown) => void)(textElement),
    );
    stageState.stage.whiteboard[0].elements = [];
    await rerenderOwner();
    expect((mocks.roundtableProps?.canSendMessage as () => boolean)()).toBe(false);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="owner-pill"]')).not.toBeNull();
    act(() => (mocks.roundtableProps?.onClearElementReference as () => void)());
    expect((mocks.roundtableProps?.canSendMessage as () => boolean)()).toBe(true);
  });

  it('does not clear a slide draft merely because the whiteboard opens', async () => {
    await renderOwner();
    click('toggle-pick');
    click('pick-text');
    mocks.whiteboardOpen = true;
    await rerenderOwner();
    expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain('Page 1');
  });

  it('owns pick state, freezes one request snapshot, and clears only on an accepted receipt', async () => {
    await renderOwner();

    click('toggle-pick');
    expect(mocks.canvasProps?.elementPickActive).toBe(true);
    click('pick-text');
    expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain(
      'Page 1 · Text · First grounded fact',
    );

    click('send');
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    const [, options] = mocks.sendMessage.mock.calls[0] as [
      string,
      { elementReference: unknown; onResponseAccepted: (response: Response) => void },
    ];
    expect(options.elementReference).toEqual({
      kind: 'slide_element',
      sceneId: 'scene-1',
      elementId: 'text-1',
    });
    act(() =>
      options.onResponseAccepted(
        new Response(null, { headers: { 'X-OpenMAIC-Element-Reference-Accepted': '1' } }),
      ),
    );
    expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();
  });

  it('consumes one PPT picker arm synchronously and rejects a stale second pick', async () => {
    await renderOwner();
    click('toggle-pick');

    act(() => {
      const onPickElement = mocks.canvasProps?.onPickElement as (element: unknown) => void;
      onPickElement(textElement);
      onPickElement(shapeElement);
    });

    expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain(
      'Page 1 · Text · First grounded fact',
    );
    click('send');
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'Explain this',
      expect.objectContaining({
        elementReference: {
          kind: 'slide_element',
          sceneId: 'scene-1',
          elementId: 'text-1',
        },
      }),
    );
  });

  it('keeps a newer owner draft when an older request receipt arrives', async () => {
    await renderOwner();
    click('toggle-pick');
    click('pick-text');
    click('send');
    const [, options] = mocks.sendMessage.mock.calls[0] as [
      string,
      { onResponseAccepted: (response: Response) => void },
    ];

    click('toggle-pick');
    act(() => {
      (mocks.canvasProps?.onPickElement as (element: unknown) => void)(shapeElement);
    });
    act(() =>
      options.onResponseAccepted(
        new Response(null, { headers: { 'X-OpenMAIC-Element-Reference-Accepted': '1' } }),
      ),
    );

    expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain(
      'Page 1 · Shape · No text',
    );
  });

  it.each(['playing', 'paused'] as const)(
    'freezes the draft through the synchronous %s interrupt bridge and sends exactly once',
    async (mode) => {
      mocks.engineMode = mode;
      await renderOwner();
      expect(mocks.roundtableProps?.engineMode).toBe(mode);

      click('toggle-pick');
      click('pick-text');
      click('send');

      expect(mocks.handleUserInterrupt).toHaveBeenCalledOnce();
      expect(mocks.handleUserInterrupt).toHaveBeenCalledWith('Explain this');
      expect(mocks.sendMessage).toHaveBeenCalledOnce();
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        'Explain this',
        expect.objectContaining({
          elementReference: {
            kind: 'slide_element',
            sceneId: 'scene-1',
            elementId: 'text-1',
          },
        }),
      );
    },
  );

  it('hides the entry and sends an ordinary unreferenced message when Pi is off', async () => {
    mocks.piEnabled = false;
    await renderOwner();

    expect(mocks.roundtableProps).toMatchObject({
      showElementReference: false,
      canPickSlideElement: false,
      elementPickActive: false,
    });
    expect(container.querySelector('[data-testid="toggle-pick"]')).toBeNull();

    click('send');

    expect(mocks.handleUserInterrupt).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenCalledWith('Explain this', undefined);
  });

  it('keeps Pi messaging available while the independent reference gate clears its UI state', async () => {
    await renderOwner();
    click('toggle-pick');
    click('pick-text');
    expect(container.querySelector('[data-testid="owner-pill"]')).not.toBeNull();

    mocks.coursewareReferenceEnabled = false;
    await rerenderOwner();

    expect(mocks.roundtableProps).toMatchObject({
      showElementReference: false,
      canPickSlideElement: false,
      elementPickActive: false,
    });
    expect(container.querySelector('[data-testid="toggle-pick"]')).toBeNull();
    expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();

    click('send');
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenCalledWith('Explain this', undefined);
  });

  it('owns an Interactive identity delivered through the Stage sibling seam', async () => {
    stageState.scenes = [interactiveScene];
    stageState.currentSceneId = interactiveScene.id;
    const pickerStates: unknown[] = [];
    const ownerRef = createRef<PlaybackChromeRootHandle>();
    await renderOwner({
      ref: ownerRef,
      onInteractivePickerChange: (state: unknown) => pickerStates.push(state),
    });

    expect(mocks.roundtableProps).toMatchObject({
      showElementReference: true,
      canPickSlideElement: true,
    });
    click('toggle-pick');
    expect(pickerStates).toContainEqual({
      sceneId: interactiveScene.id,
      active: true,
      selectedSelector: undefined,
    });

    act(() => {
      expect(
        ownerRef.current?.acceptInteractivePick({
          sceneId: interactiveScene.id,
          selector: '#angle-slider',
        }),
      ).toBe(true);
      expect(
        ownerRef.current?.acceptInteractivePick({
          sceneId: interactiveScene.id,
          selector: '#stale-second-pick',
        }),
      ).toBe(false);
    });
    expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain(
      'Page 1 · Interactive · #angle-slider',
    );
    expect(pickerStates).toContainEqual({
      sceneId: interactiveScene.id,
      active: false,
      selectedSelector: '#angle-slider',
    });

    click('send');
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'Explain this',
      expect.objectContaining({
        elementReference: {
          kind: 'interactive_component',
          sceneId: interactiveScene.id,
          selector: '#angle-slider',
        },
      }),
    );
    const [, options] = mocks.sendMessage.mock.calls[0] as [
      string,
      { onResponseAccepted: (response: Response) => void },
    ];
    act(() =>
      options.onResponseAccepted(
        new Response(null, { headers: { 'X-OpenMAIC-Element-Reference-Accepted': '1' } }),
      ),
    );
    expect(pickerStates.at(-1)).toEqual({
      sceneId: interactiveScene.id,
      active: false,
      selectedSelector: undefined,
    });
  });

  it('rejects an Interactive pick synchronously after the owner cancels', async () => {
    stageState.scenes = [interactiveScene];
    stageState.currentSceneId = interactiveScene.id;
    const ownerRef = createRef<PlaybackChromeRootHandle>();
    await renderOwner({ ref: ownerRef });

    click('toggle-pick');
    act(() => {
      ownerRef.current?.cancelElementPick();
      expect(
        ownerRef.current?.acceptInteractivePick({
          sceneId: interactiveScene.id,
          selector: '#stale-after-cancel',
        }),
      ).toBe(false);
    });

    expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();
  });

  it('cancels an armed Interactive picker with Escape from playback chrome', async () => {
    stageState.scenes = [interactiveScene];
    stageState.currentSceneId = interactiveScene.id;
    const pickerStates: unknown[] = [];
    const ownerRef = createRef<PlaybackChromeRootHandle>();
    await renderOwner({
      ref: ownerRef,
      onInteractivePickerChange: (state: unknown) => pickerStates.push(state),
    });

    click('toggle-pick');
    expect(pickerStates.at(-1)).toEqual({
      sceneId: interactiveScene.id,
      active: true,
      selectedSelector: undefined,
    });

    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => window.dispatchEvent(escape));

    expect(escape.defaultPrevented).toBe(true);
    expect(pickerStates.at(-1)).toEqual({
      sceneId: interactiveScene.id,
      active: false,
      selectedSelector: undefined,
    });
    expect(
      ownerRef.current?.acceptInteractivePick({
        sceneId: interactiveScene.id,
        selector: '#stale-after-escape',
      }),
    ).toBe(false);
  });

  it('freezes one Interactive identity for exactly one send and preserves it without a receipt', async () => {
    stageState.scenes = [interactiveScene];
    stageState.currentSceneId = interactiveScene.id;
    const ownerRef = createRef<PlaybackChromeRootHandle>();
    await renderOwner({ ref: ownerRef });

    click('toggle-pick');
    act(() => {
      ownerRef.current?.acceptInteractivePick({
        sceneId: interactiveScene.id,
        selector: '#angle-slider',
      });
    });
    click('send');

    expect(mocks.handleUserInterrupt).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    const [, options] = mocks.sendMessage.mock.calls[0] as [
      string,
      {
        elementReference: unknown;
        onResponseAccepted: (response: Response) => void;
      },
    ];
    expect(options.elementReference).toEqual({
      kind: 'interactive_component',
      sceneId: interactiveScene.id,
      selector: '#angle-slider',
    });
    act(() => options.onResponseAccepted(new Response(null)));
    expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain(
      '#angle-slider',
    );
  });

  it('clears the owner draft after manual scene navigation settles', async () => {
    await renderOwner();
    click('toggle-pick');
    click('pick-text');
    expect(container.querySelector('[data-testid="owner-pill"]')).not.toBeNull();

    act(() => {
      (mocks.roundtableProps?.onNextSlide as (() => void) | undefined)?.();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stageState.setCurrentSceneId).toHaveBeenCalledWith(secondScene.id);

    await rerenderOwner();
    expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();

    click('send');
    expect(mocks.sendMessage).toHaveBeenCalledWith('Explain this', undefined);
  });

  it('keeps the owner draft while a gated scene navigation has not settled', async () => {
    mocks.topicActive = true;
    await renderOwner();
    click('toggle-pick');
    click('pick-text');

    act(() => {
      (mocks.roundtableProps?.onNextSlide as (() => void) | undefined)?.();
    });

    expect(stageState.setCurrentSceneId).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="owner-pill"]')).not.toBeNull();
  });

  it('stops the previous engine when switching to a non-playable scene', async () => {
    await renderOwner();
    expect(mocks.engineStop).not.toHaveBeenCalled();
    const previousEngineOptions = mocks.engineOptions;

    stageState.scenes = [scene, interactiveScene];
    stageState.currentSceneId = interactiveScene.id;
    await rerenderOwner();

    expect(mocks.engineStop).toHaveBeenCalledOnce();
    act(() => previousEngineOptions?.onProgress?.({ actionIndex: 1, sceneId: scene.id }));
    expect(mocks.roundtableProps?.currentActionIndex).toBe(0);
  });

  it('does not resume manual playback after its engine is superseded', async () => {
    let resolveStartLecture!: (sessionId: string) => void;
    mocks.startLecture.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveStartLecture = resolve;
      }),
    );
    await renderOwner();
    const onPlayPause = mocks.roundtableProps?.onPlayPause as () => Promise<void>;

    let playPromise!: Promise<void>;
    act(() => {
      playPromise = onPlayPause();
    });
    stageState.scenes = [scene, interactiveScene];
    stageState.currentSceneId = interactiveScene.id;
    await rerenderOwner();

    await act(async () => {
      resolveStartLecture('stale-lecture');
      await playPromise;
    });

    expect(mocks.engineContinuePlayback).not.toHaveBeenCalled();
    expect(mocks.endSession).toHaveBeenCalledWith('stale-lecture');
  });

  it('does not auto-start playback after its engine is superseded', async () => {
    vi.useFakeTimers();
    settingsState.autoPlayLecture = true;
    try {
      await renderOwner();
      act(() => mocks.engineOptions?.onComplete?.());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });

      let resolveStartLecture!: (sessionId: string) => void;
      mocks.startLecture.mockReturnValueOnce(
        new Promise<string>((resolve) => {
          resolveStartLecture = resolve;
        }),
      );
      await rerenderOwner();

      stageState.scenes = [scene, secondScene, interactiveScene];
      stageState.currentSceneId = interactiveScene.id;
      await rerenderOwner();

      await act(async () => {
        resolveStartLecture('stale-auto-lecture');
        await Promise.resolve();
      });

      expect(mocks.engineStart).not.toHaveBeenCalled();
      expect(mocks.endSession).toHaveBeenCalledWith('stale-auto-lecture');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the owner draft after automatic playback advances the scene', async () => {
    vi.useFakeTimers();
    settingsState.autoPlayLecture = true;
    try {
      await renderOwner();
      click('toggle-pick');
      click('pick-text');
      expect(container.querySelector('[data-testid="owner-pill"]')).not.toBeNull();

      act(() => mocks.engineOptions?.onComplete?.());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(stageState.setCurrentSceneId).toHaveBeenCalledWith(secondScene.id);

      await rerenderOwner();
      expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();

      click('send');
      expect(mocks.sendMessage).toHaveBeenCalledWith('Explain this', undefined);
    } finally {
      vi.useRealTimers();
    }
  });
});
