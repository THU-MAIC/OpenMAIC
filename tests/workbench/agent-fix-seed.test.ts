// @vitest-environment jsdom
/**
 * "Fix with agent" (issue #2329) lands in the empty conversation opened for
 * the course: the composer names the course first, the problem follows as
 * draft text, and nothing is sent — the owner reviews it and sends it.
 */
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPOSER_INPUT, composerText, setComposerText } from './_composer-driver';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ locale: 'en-US', t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/workbench/agent-skills', () => ({
  useAgentSkills: () => ({ skills: [], loading: false, error: null, reload: async () => {} }),
  invalidateAgentSkills: async () => {},
}));
vi.mock('@/components/workbench/chat/chat-timeline', () => ({ ChatTimeline: () => null }));
vi.mock('@/components/workbench/chat/autoscroll', () => ({
  useWorkbenchAutoscroll: () => ({
    scrollRef: { current: null },
    contentRef: { current: null },
    isNearBottom: true,
    scrollToBottom: async () => {},
  }),
}));

import { WorkbenchChat } from '@/components/workbench/WorkbenchChat';
import {
  WorkbenchCourseNavigationProvider,
  WorkbenchDraftConversationProvider,
} from '@/lib/workbench/panel-context';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { useCourseRefsStore } from '@/lib/store/course-refs';
import type { AgentFixDraftSeed } from '@/lib/workbench/agent-fix-handoff';

const PREFILL = 'Please fix this issue on “Page 2 · Graph”: Interactive page error.\n\n> boom';

let posts: unknown[] = [];
const disposers: Array<() => Promise<void>> = [];

const wait = (milliseconds = 30) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push({ url, body: init.body });
        return Response.json({ id: 'ses-new', stageId: 'stage-1', status: 'succeeded' });
      }
      if (url === '/api/agent/runtime') return Response.json({ enabled: true });
      if (url.startsWith('/api/materials/library')) return Response.json({ materials: [] });
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  useWorkbenchStore.getState().detach();
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

function seed(key: number, courseId = 'stage-1'): AgentFixDraftSeed {
  return { key, ownerKey: `draft:${courseId}`, courseId, text: PREFILL };
}

async function draftChat(props: {
  courseId?: string;
  agentFixSeed: AgentFixDraftSeed | null;
  onAgentFixSeedConsumed?: (key: number) => void;
  strict?: boolean;
}) {
  const courseId = props.courseId ?? 'stage-1';
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposers.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const navigation = {
    activeCourseId: courseId,
    courseOptions: [],
    openCourse: () => {},
    lookupCourse: () => null,
  };
  const draft = {
    ownerKey: `draft:${courseId}`,
    course: { stageId: courseId, title: 'Physics' },
    start: async () => ({ accepted: true }),
  };
  const render = async (next: typeof props) => {
    const chat = createElement(
      WorkbenchCourseNavigationProvider,
      { navigation } as never,
      createElement(
        WorkbenchDraftConversationProvider,
        { draft } as never,
        createElement(WorkbenchChat, {
          hosted: true,
          agentFixSeed: next.agentFixSeed,
          onAgentFixSeedConsumed: next.onAgentFixSeedConsumed,
          conversation: `draft:${courseId}`,
        }),
      ),
    );
    await act(async () => root.render(props.strict ? createElement(StrictMode, null, chat) : chat));
    await wait();
  };
  await render(props);
  const input = () => container.querySelector(COMPOSER_INPUT)!;
  return { container, input, render };
}

describe('fix with agent in the course draft composer', () => {
  it('names the course, then pre-fills the problem, once, without sending it', async () => {
    const consumed = vi.fn();
    const view = await draftChat({
      agentFixSeed: seed(3),
      onAgentFixSeedConsumed: consumed,
      strict: true,
    });
    const text = composerText(view.input());
    expect(text.endsWith(PREFILL)).toBe(true);
    // The course mention the draft opened with is still its first word, and
    // its reference is still staged: the conversation is about this course.
    expect(text.startsWith(PREFILL)).toBe(false);
    expect(text).toContain('Physics');
    expect(useCourseRefsStore.getState().refs.map((ref) => ref.stageId)).toEqual(['stage-1']);
    // Development replays the effect; consuming is by key, so that is one hand-off.
    expect(consumed).toHaveBeenCalledWith(3);
    expect(consumed.mock.calls.every(([key]) => key === 3)).toBe(true);
    expect(posts).toEqual([]);
  });

  it('replaces what was typed before, and leaves a later draft alone', async () => {
    const consumed = vi.fn();
    const view = await draftChat({ agentFixSeed: null, onAgentFixSeedConsumed: consumed });
    await act(async () => setComposerText(view.input(), 'half a thought'));
    await view.render({ agentFixSeed: seed(4), onAgentFixSeedConsumed: consumed });
    expect(composerText(view.input())).not.toContain('half a thought');
    expect(composerText(view.input()).endsWith(PREFILL)).toBe(true);

    // The same seed again (not yet dropped by the shell) applies nothing more.
    await act(async () => setComposerText(view.input(), 'my own words'));
    await view.render({ agentFixSeed: seed(4), onAgentFixSeedConsumed: consumed });
    expect(composerText(view.input())).toBe('my own words');
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it('is not taken by the draft of another course', async () => {
    const consumed = vi.fn();
    const view = await draftChat({
      courseId: 'stage-2',
      agentFixSeed: seed(5, 'stage-1'),
      onAgentFixSeedConsumed: consumed,
    });
    expect(composerText(view.input())).not.toContain(PREFILL);
    expect(consumed).not.toHaveBeenCalled();
  });
});
