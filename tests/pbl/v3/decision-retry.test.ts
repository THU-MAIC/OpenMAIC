// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { LearningView } from '@/lib/pbl/v3/types';

const { t, messageHooks } = vi.hoisted(() => ({
  t: (key: string) => key,
  messageHooks: { begin: vi.fn(), finish: vi.fn(), observe: vi.fn() },
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t }) }));
vi.mock('@/lib/hooks/use-theme', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('@/lib/store/stage', () => ({ useStageStore: () => 'stage' }));
vi.mock('@/components/scene-renderers/pbl/v3/activity-provider', () => ({
  usePblActivityGeneration: () => 1,
}));
vi.mock('@/components/scene-renderers/pbl/v3/use-learning-stream', () => ({
  useLearningStream: () => ({ status: 'connected' }),
}));
vi.mock('@/components/scene-renderers/pbl/v3/use-learner-message', () => ({
  useLearnerMessage: () => messageHooks,
}));
vi.mock('@/components/scene-renderers/pbl/v3/workspace-frame', () => ({
  WorkspaceFrame: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/scene-renderers/pbl/v3/workbench-split', () => ({
  WorkbenchSplit: ({ assistant }: { assistant: ReactNode }) => assistant,
}));
vi.mock('@/components/scene-renderers/pbl/v3/task-dock', () => ({
  TaskDock: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/scene-renderers/pbl/v3/workbench-panel', () => ({
  LearningWorkbenchPanel: () => null,
}));
vi.mock('@/components/scene-renderers/pbl/v3/learning-panels', () => ({
  LearningPanels: () => null,
}));
vi.mock('@/components/scene-renderers/pbl/v3/conversation', () => ({
  LearningConversation: () => null,
}));
import { PBLV3Workspace } from '@/components/scene-renderers/pbl/v3/workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement;
let sequence = 0;
async function mount() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(PBLV3Workspace, { sceneId: 'scene' })));
}
async function leave() {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
}
async function type(index: number, value: string) {
  const textarea = container.querySelectorAll('textarea')[index]!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === label,
  )!;
  expect(button).toBeDefined();
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
}
afterEach(async () => {
  await leave();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

it.each(['success', 'retry', 'retry-newer', 'lost-ack'])(
  'acknowledges a decision through the workspace command path: %s',
  async (mode) => {
    const id = `decision-command-${sequence++}`;
    let view = {
      id,
      revision: 1,
      state: {
        status: 'active',
        position: { milestoneId: 'first', milestoneIndex: 0, stageIndex: 1 },
        collected: { first: { decisions: [] } },
      },
      environment: { ready: true },
      stage: { kind: 'dialogue', agent: 'discussion' },
      decisions: [
        {
          id: 'rule',
          prompt: 'Explain your rule',
          responseType: 'text',
          requiresRationale: true,
          options: [],
        },
      ],
      actions: ['decide'],
      questions: [],
      messages: [],
    } as unknown as LearningView;
    const requests: Record<string, unknown>[] = [];
    const accepted = new Set<string>();
    const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (!init?.body) return response(view);
        const body = JSON.parse(String(init.body));
        if (body.action === 'open') return response(view);
        requests.push(body.command);
        if (accepted.has(body.command.id)) return response({ view });
        if (['retry', 'retry-newer'].includes(mode) && requests.length === 1)
          throw new Error('Connection interrupted before submission');
        view = {
          ...view,
          revision: 2,
          state: {
            ...view.state,
            collected: {
              first: {
                ...view.state.collected.first!,
                decisions: [
                  {
                    id: 'rule',
                    chosen: body.command.chosen,
                    rationale: body.command.rationale,
                    revision: 0,
                  },
                ],
              },
            },
          },
        };
        accepted.add(body.command.id);
        if (mode === 'lost-ack' && requests.length === 1)
          throw new Error('Acknowledgement lost after submission');
        return response({ view });
      }),
    );
    await mount();
    await type(0, 'Submitted rule');
    await type(1, 'Submitted reason');
    await click('pblV3.submitDecision');
    const stored = () =>
      JSON.parse(window.sessionStorage.getItem(`maic:pbl-draft:v1:${id}:ui`)!).decisionDrafts;
    if (mode !== 'success') {
      expect(stored()['first:rule']).toEqual({
        chosen: 'Submitted rule',
        rationale: 'Submitted reason',
      });
      if (mode === 'retry-newer') await type(1, 'Newer unsaved reason');
      await click('pblV3.retry');
      expect(requests[1]).toEqual(requests[0]);
    }
    expect(stored()).toEqual(
      mode === 'retry-newer'
        ? { 'first:rule': { chosen: 'Submitted rule', rationale: 'Newer unsaved reason' } }
        : {},
    );
    await leave();
    view.state.collected.first!.decisions = [
      { id: 'rule', chosen: 'Newer server answer', rationale: 'Server reason', revision: 1 },
    ];
    await mount();
    const values = [...container.querySelectorAll('textarea')].map((field) => field.value);
    expect(values).toEqual(
      mode === 'retry-newer'
        ? ['Submitted rule', 'Newer unsaved reason']
        : ['Newer server answer', 'Server reason'],
    );
  },
);
