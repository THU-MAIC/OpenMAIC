// @vitest-environment jsdom
/**
 * Picking a knowledge-base material in the real composers (RFC #1716 §4): the
 * launch panel, a new conversation's first message, and a follow-up. The pick
 * only stages a pill -- nothing is posted -- and the send carries its id. The
 * `@` button is there whenever the menu can open, classrooms or not, and every
 * extraction state reads differently in the menu.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { CourseMentionMenu } from '@/components/workbench/course-mention-menu';
import { ProLaunchPanel } from '@/components/workbench/ProLaunchPanel';
import { WorkbenchChat } from '@/components/workbench/WorkbenchChat';
import { startConversationWithFirstMessage } from '@/lib/workbench/first-message-session';
import {
  WorkbenchCourseNavigationProvider,
  WorkbenchDraftConversationProvider,
} from '@/lib/workbench/panel-context';
import { useWorkbenchStore } from '@/lib/workbench/session-store';

// jsdom lays nothing out; the menu scrolls its highlighted row into view.
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

type Mode = 'launch' | 'new' | 'follow';

const courseOptions = [{ id: 'stage-1', name: 'Classroom' }];
let posts: Array<{ url: string; body: Record<string, unknown> }> = [];
let dispose: (() => Promise<void>) | undefined;

const wait = (milliseconds: number) =>
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
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ url, body });
        if (url === '/api/agent/sessions') {
          return Response.json({
            id: 'ses-new',
            stageId: 'stage-1',
            status: 'succeeded',
            prompt: body.prompt,
          });
        }
        if (url.endsWith('/messages')) {
          return Response.json({ elementRefsAccepted: true, courseRefsAccepted: true });
        }
      }
      if (url === '/api/agent/runtime') return Response.json({ enabled: true });
      if (url.startsWith('/api/materials/library')) {
        return Response.json({
          materials: [
            {
              materialId: 'src-doc',
              name: 'document.pdf',
              bytes: 3,
              mime: 'application/pdf',
              extraction: { status: 'done' },
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  useWorkbenchStore.getState().detach();
});

afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
});

async function mount(mode: Mode, hasCourses = true): Promise<HTMLElement> {
  if (mode === 'follow') {
    useWorkbenchStore.getState().attach('ses-follow', 'stage-1');
    useWorkbenchStore.setState({ replaying: false, status: 'succeeded' });
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const options = hasCourses ? courseOptions : [];
  const navigation = {
    activeCourseId: null,
    courseOptions: options,
    openCourse: () => {},
    lookupCourse: () => null,
  };
  const draft =
    mode === 'new'
      ? {
          ownerKey: 'draft-1',
          start: async (message: Record<string, unknown>) => {
            const started = await startConversationWithFirstMessage({
              stageId: 'stage-1',
              ...message,
            } as never);
            return { accepted: true, ...started };
          },
        }
      : null;
  const composer =
    mode === 'launch'
      ? createElement(ProLaunchPanel, { courseOptions: options, onSessionCreated: () => {} })
      : createElement(
          WorkbenchCourseNavigationProvider,
          { navigation } as never,
          createElement(
            WorkbenchDraftConversationProvider,
            { draft } as never,
            createElement(WorkbenchChat, { hosted: true }),
          ),
        );
  await act(async () => root.render(composer as never));
  await wait(30);
  dispose = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}

async function type(container: HTMLElement, text: string) {
  const textarea = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea,
      text,
    );
    textarea.setSelectionRange(text.length, text.length);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const mentionButton = (container: HTMLElement, mode: Mode) =>
  container.querySelector<HTMLButtonElement>(
    `[data-testid="${mode === 'launch' ? 'pro-launch-mention-button' : 'workbench-mention-button'}"]`,
  );

describe.each(['launch', 'new', 'follow'] as const)('the %s composer', (mode) => {
  it('stages a picked material without posting anything, then sends its id', async () => {
    const container = await mount(mode);
    const button = mentionButton(container, mode);
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    await wait(230);
    const option = container.querySelector<HTMLButtonElement>(
      '[data-testid="workbench-material-option-src-doc"]',
    );
    expect(option).not.toBeNull();
    await act(async () => option!.click());
    expect(posts).toEqual([]);
    expect(container.textContent).toContain('document.pdf');

    await type(container, 'Teach this');
    const send = container.querySelector<HTMLButtonElement>(
      `[data-testid="${mode === 'launch' ? 'pro-launch-start' : 'workbench-send'}"]`,
    );
    expect(send?.disabled).toBe(false);
    await act(async () => send!.click());
    const sent = posts.find((post) =>
      mode === 'launch' ? post.url === '/api/agent/sessions' : post.url.endsWith('/messages'),
    );
    expect(sent?.body.materialIds).toEqual(['src-doc']);
  });
});

describe.each(['launch', 'follow'] as const)('the %s composer without classrooms', (mode) => {
  it('still offers the @ button, which opens the knowledge base', async () => {
    const container = await mount(mode, false);
    const button = mentionButton(container, mode);
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-label')).toBe('proMode.mentionCourseOrMaterial');
    await act(async () => button!.click());
    await wait(230);
    expect(
      container.querySelector('[data-testid="workbench-material-option-src-doc"]'),
    ).not.toBeNull();
  });
});

describe('the @ menu', () => {
  it('names every extraction state, so not-extracted and extracted read differently', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    dispose = async () => {
      await act(async () => root.unmount());
      container.remove();
    };
    const material = (id: string, status: 'idle' | 'done' | 'running' | 'failed') => ({
      materialId: id,
      name: id,
      bytes: 1,
      folderName: 'Unit 1',
      attached: false,
      staged: false,
      extractionStatus: status,
    });
    await act(async () =>
      root.render(
        createElement(CourseMentionMenu, {
          candidates: [],
          materials: [
            material('m-idle', 'idle'),
            material('m-done', 'done'),
            material('m-running', 'running'),
            material('m-failed', 'failed'),
          ],
          onPick: () => {},
          onPickMaterial: () => {},
          onClose: () => {},
        }),
      ),
    );
    const meta = (id: string) =>
      container
        .querySelector(`[data-testid="workbench-material-option-${id}"]`)!
        .querySelectorAll('span')[1]!.textContent;
    expect(meta('m-idle')).toBe('Unit 1 · workspace.courseMention.materialNotExtracted');
    expect(meta('m-done')).toBe('Unit 1 · workspace.courseMention.materialExtracted');
    expect(meta('m-running')).toBe('Unit 1 · workspace.courseMention.materialExtracting');
    expect(meta('m-failed')).toBe('Unit 1 · workspace.courseMention.materialFailed');
  });
});
