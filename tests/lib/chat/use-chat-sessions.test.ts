import { describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '@/lib/types/chat';
import {
  consumePiSessionBoundaryContext,
  createPreviousLiveSessionContext,
  createPiSessionBoundaryContext,
  getPiSessionBoundaryContext,
  getPiSingleRequestOutcome,
  isOpenLiveSession,
  normalizeStoredSessionsForRestore,
  retireLiveRequestResources,
  resumeSoftClosingSessionForFollowUp,
  resumeSoftClosingSessionWithoutMessage,
  runPiSingleRequest,
  shouldAwaitPresentationAction,
  withPiInclassWhiteboardTools,
  MANUAL_STOP_END_OPTIONS,
  takeSoftCloseRegistration,
} from '@/components/chat/use-chat-sessions';
import type { ChatRequestTemplate } from '@/components/chat/use-chat-sessions';
import type { UIMessage } from 'ai';
import type { ChatMessageMetadata } from '@/lib/types/chat';

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-1',
    type: 'qa',
    title: 'Q&A',
    status: 'active',
    messages: [],
    config: { agentIds: ['default-1'], defaultAgentId: 'default-1' },
    toolCalls: [],
    pendingToolCalls: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('normalizeStoredSessionsForRestore', () => {
  it('does not restore transient active or soft-closing statuses', () => {
    const restored = normalizeStoredSessionsForRestore([
      makeSession({ id: 'active', status: 'active' }),
      makeSession({ id: 'soft-closing', status: 'soft-closing', endReason: 'user_goodbye' }),
      makeSession({ id: 'completed', status: 'completed' }),
    ]);

    expect(restored.map((session) => [session.id, session.status, session.endReason])).toEqual([
      ['active', 'interrupted', undefined],
      ['soft-closing', 'completed', 'user_goodbye'],
      ['completed', 'completed', undefined],
    ]);
  });
});

describe('Pi live-session context lifecycle', () => {
  it('keeps the ended session scene when the store already points at the next scene', () => {
    const previous = createPreviousLiveSessionContext(
      makeSession({ sceneId: 'scene-old' }),
      'scene-new',
      'scene_switch',
    );

    expect(previous).toEqual({ endSource: 'scene_switch', sceneId: 'scene-old' });
    expect(createPiSessionBoundaryContext(previous, 'scene-new')).toEqual({
      isFirstRequestInLiveSession: true,
      previousEndSource: 'scene_switch',
      sameSceneAsPrevious: false,
    });
  });

  it('falls back to the current store scene when the session has no captured scene', () => {
    expect(createPreviousLiveSessionContext(makeSession(), 'scene-current', 'manual_stop')).toEqual(
      {
        endSource: 'manual_stop',
        sceneId: 'scene-current',
      },
    );
  });

  it('describes the first request without treating the UI boundary as a clear command', () => {
    expect(MANUAL_STOP_END_OPTIONS).toEqual({ source: 'manual_stop' });
    expect(
      createPiSessionBoundaryContext({ endSource: 'manual_stop', sceneId: 'scene-1' }, 'scene-1'),
    ).toEqual({
      isFirstRequestInLiveSession: true,
      previousEndSource: 'manual_stop',
      sameSceneAsPrevious: true,
    });
  });

  it('reports a scene change without implying that the board must be cleared', () => {
    expect(
      createPiSessionBoundaryContext({ endSource: 'turn_complete', sceneId: 'scene-1' }, 'scene-2'),
    ).toEqual({
      isFirstRequestInLiveSession: true,
      previousEndSource: 'turn_complete',
      sameSceneAsPrevious: false,
    });
  });

  it('can be consumed exactly once so later requests in the same session omit it', () => {
    const contexts = new Map([
      ['session-new', createPiSessionBoundaryContext(undefined, 'scene-1')],
    ]);

    const first = getPiSessionBoundaryContext(contexts, 'session-new');
    expect(first).toEqual({
      isFirstRequestInLiveSession: true,
      previousEndSource: undefined,
      sameSceneAsPrevious: undefined,
    });
    expect(first && consumePiSessionBoundaryContext(contexts, 'session-new', first)).toBe(true);
    expect(getPiSessionBoundaryContext(contexts, 'session-new')).toBeUndefined();
  });

  it('does not consume a replacement context from a stale request callback', () => {
    const original = createPiSessionBoundaryContext(undefined, 'scene-1');
    const replacement = createPiSessionBoundaryContext(
      { endSource: 'scene_switch', sceneId: 'scene-1' },
      'scene-2',
    );
    const contexts = new Map([['session-new', replacement]]);

    expect(consumePiSessionBoundaryContext(contexts, 'session-new', original)).toBe(false);
    expect(getPiSessionBoundaryContext(contexts, 'session-new')).toBe(replacement);
  });
});

describe('isOpenLiveSession', () => {
  it('treats soft-closing QA/discussion sessions as still open for live controls', () => {
    expect(isOpenLiveSession({ type: 'qa', status: 'active' })).toBe(true);
    expect(isOpenLiveSession({ type: 'discussion', status: 'soft-closing' })).toBe(true);
    expect(isOpenLiveSession({ type: 'qa', status: 'completed' })).toBe(false);
    expect(isOpenLiveSession({ type: 'lecture', status: 'soft-closing' })).toBe(false);
  });
});

describe('resumeSoftClosingSessionForFollowUp', () => {
  it('keeps the visible wrap-up history and reactivates the session for a follow-up', () => {
    const wrapUpMessage: UIMessage<ChatMessageMetadata> = {
      id: 'teacher-wrap-up',
      role: 'assistant',
      parts: [{ type: 'text', text: '总结一下：树荫通过减少直射辐射来降低地表吸热。' }],
    };
    const followUpMessage: UIMessage<ChatMessageMetadata> = {
      id: 'user-follow-up',
      role: 'user',
      parts: [{ type: 'text', text: '那湿度会影响吗？' }],
    };

    const next = resumeSoftClosingSessionForFollowUp(
      makeSession({
        status: 'soft-closing',
        endReason: 'user_done',
        softCloseDeadline: 123,
        messages: [wrapUpMessage],
      }),
      followUpMessage,
      99,
    );

    expect(next.status).toBe('active');
    expect(next.endReason).toBeUndefined();
    expect(next.softCloseDeadline).toBeUndefined();
    expect(next.updatedAt).toBe(99);
    expect(next.messages).toEqual([wrapUpMessage, followUpMessage]);
  });

  it('resumes without appending a message for explicit continue or input activity', () => {
    const session = makeSession({
      status: 'soft-closing',
      endReason: 'user_done',
      softCloseDeadline: 123,
    });

    const next = resumeSoftClosingSessionWithoutMessage(session, 99);

    expect(next).toMatchObject({
      status: 'active',
      endReason: undefined,
      softCloseDeadline: undefined,
      updatedAt: 99,
      messages: [],
    });
    expect(resumeSoftClosingSessionWithoutMessage(makeSession(), 99)).toBeUndefined();
  });
});

describe('soft-close registration arbitration', () => {
  it('allows exactly one path to claim a soft-close cycle', () => {
    const timer = setTimeout(() => undefined, 60_000);
    const registrations = new Map([['session-1', { token: 'cycle-1', deadline: 100, timer }]]);

    expect(takeSoftCloseRegistration(registrations, 'session-1', 'stale')).toBeUndefined();
    expect(takeSoftCloseRegistration(registrations, 'session-1', 'cycle-1')).toMatchObject({
      token: 'cycle-1',
      deadline: 100,
    });
    expect(takeSoftCloseRegistration(registrations, 'session-1', 'cycle-1')).toBeUndefined();
    expect(registrations.size).toBe(0);
  });
});

describe('getPiSingleRequestOutcome', () => {
  it('enters soft-closing for a server-side close after the stream has drained', () => {
    const directorState = {
      turnCount: 1,
      agentResponses: [],
      whiteboardLedger: [],
    };

    expect(
      getPiSingleRequestOutcome({
        directorState,
        totalAgents: 1,
        agentHadContent: true,
        cueUserReceived: false,
        sessionClosed: true,
        endReason: 'user_done',
      }),
    ).toEqual({ type: 'soft_closing', endReason: 'user_done', directorState });
  });

  it('keeps the session open when Pi cues the user', () => {
    const directorState = {
      turnCount: 1,
      agentResponses: [],
      whiteboardLedger: [],
    };

    expect(
      getPiSingleRequestOutcome({
        directorState,
        totalAgents: 1,
        agentHadContent: true,
        cueUserReceived: true,
        sessionClosed: false,
      }),
    ).toEqual({ type: 'cue_user', directorState });
  });

  it('treats empty Pi child output as a stream error even if fallback cue_user fired', () => {
    const directorState = {
      turnCount: 0,
      agentResponses: [],
      whiteboardLedger: [],
    };

    expect(
      getPiSingleRequestOutcome({
        directorState,
        totalAgents: 0,
        agentHadContent: false,
        cueUserReceived: true,
        sessionClosed: false,
      }),
    ).toEqual({ type: 'error', messageKey: 'chat.error.streamInterrupted' });
  });
});

describe('withPiInclassWhiteboardTools', () => {
  it('enables Pi whiteboard tools on the inclass request config without dropping fields', () => {
    const request = {
      messages: [],
      storeState: {},
      config: {
        agentIds: ['default-1'],
        sessionType: 'qa',
        triggerAgentId: 'default-2',
      },
      apiKey: 'test-key',
    } satisfies ChatRequestTemplate;

    const next = withPiInclassWhiteboardTools(request);

    expect(next).not.toBe(request);
    expect(next.config).toEqual({
      agentIds: ['default-1'],
      sessionType: 'qa',
      triggerAgentId: 'default-2',
      piEnableWhiteboardTools: true,
    });
    expect(request.config).not.toHaveProperty('piEnableWhiteboardTools');
  });
});

describe('retireLiveRequestResources', () => {
  it('retires resources immediately but waits for an in-flight action to settle', async () => {
    const controller = new AbortController();
    let finishAction: (() => void) | undefined;
    const actionCompletion = new Promise<void>((resolve) => {
      finishAction = resolve;
    });
    const buffer = {
      shutdown: vi.fn(),
      waitForCurrentAction: vi.fn(() => actionCompletion),
    };
    const buffers = new Map([['session-1', buffer]]);

    let retirementSettled = false;
    const retirement = retireLiveRequestResources(controller, 'session-1', buffers).then(() => {
      retirementSettled = true;
    });

    expect(controller.signal.aborted).toBe(true);
    expect(buffer.shutdown).toHaveBeenCalledOnce();
    expect(buffers.has('session-1')).toBe(false);
    expect(retirementSettled).toBe(false);

    finishAction?.();
    await retirement;
    expect(retirementSettled).toBe(true);
  });
});

describe('shouldAwaitPresentationAction', () => {
  it('waits for shared whiteboard mutations without blocking on long media playback', () => {
    expect(shouldAwaitPresentationAction('wb_clear')).toBe(true);
    expect(shouldAwaitPresentationAction('wb_edit_code')).toBe(true);
    expect(shouldAwaitPresentationAction('play_video')).toBe(false);
  });
});

describe('runPiSingleRequest', () => {
  it('does not accept the first-request context when fetch fails before a response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('network down'))),
    );
    const onResponseAccepted = vi.fn();

    try {
      await expect(
        runPiSingleRequest(
          'session-1',
          {
            messages: [],
            storeState: {},
            config: { agentIds: ['teacher-1'] },
            apiKey: '',
          } as unknown as ChatRequestTemplate,
          new AbortController(),
          'qa',
          () => ({ onEvent: vi.fn(), onIterationEnd: vi.fn() }),
          vi.fn(),
          vi.fn(),
          vi.fn(),
          vi.fn(),
          { current: vi.fn() },
          (key) => key,
          onResponseAccepted,
        ),
      ).rejects.toThrow('network down');
    } finally {
      vi.unstubAllGlobals();
    }

    expect(onResponseAccepted).not.toHaveBeenCalled();
  });

  it('treats EOF without a done event as interrupted without waiting for drain', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: 'agent_start',
              data: {
                messageId: 'message-1',
                agentId: 'teacher-1',
                agentName: 'Teacher',
              },
            })}\n\n`,
          ),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const onIterationEnd = vi.fn(async () => {
      throw new Error('must not wait for a missing done event');
    });
    const clearAfterError = vi.fn();
    const onResponseAccepted = vi.fn();

    try {
      await runPiSingleRequest(
        'session-1',
        {
          messages: [],
          storeState: {},
          config: { agentIds: ['teacher-1'] },
          apiKey: '',
        } as unknown as ChatRequestTemplate,
        new AbortController(),
        'qa',
        () => ({ onEvent: vi.fn(), onIterationEnd }),
        clearAfterError,
        vi.fn(),
        vi.fn(),
        vi.fn(),
        { current: vi.fn() },
        (key) => key,
        onResponseAccepted,
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(onIterationEnd).not.toHaveBeenCalled();
    expect(onResponseAccepted).toHaveBeenCalledOnce();
    expect(clearAfterError).toHaveBeenCalledWith('session-1', 'chat.error.streamInterrupted');
  });
});
