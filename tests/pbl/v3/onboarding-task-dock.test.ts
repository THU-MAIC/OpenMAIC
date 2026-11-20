// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskDock } from '@/components/scene-renderers/pbl/v3/task-dock';
import type { LearningView } from '@/lib/pbl/v3/types';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
const view = {
  id: 'study',
  busy: false,
  actions: ['chat', 'next'],
  state: {
    status: 'running',
    milestones: [{ milestoneId: 'first', status: 'active' }],
    position: { milestoneId: 'first', milestoneIndex: 0, stageIndex: 0 },
  },
  stage: { kind: 'mentor_say', agent: 'discussion' },
  milestones: [{ id: 'first', title: 'First', stages: ['teaching', 'dialogue', 'quiz'] }],
} as LearningView;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.useFakeTimers();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});
async function render(props: Partial<Parameters<typeof TaskDock>[0]> = {}) {
  const options = { view, children: null, action: createElement('button', null, 'Next'), ...props };
  await act(async () => root.render(createElement(TaskDock, options)));
}
const bar = () => host.querySelector('[data-testid="pbl-advance-bar"]');

it('stops next-step attention after eight seconds without disabling progression', async () => {
  await render();
  expect(bar()!.getAttribute('data-attention')).toBe('true');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(7999);
  });
  expect(bar()!.getAttribute('data-attention')).toBe('true');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2);
  });
  expect(bar()!.getAttribute('data-attention')).toBe('false');
  expect(bar()!.querySelector('button')!.disabled).toBe(false);
});

it.each([{ actionDisabled: true }, { modalActive: true }, { working: true }])(
  'does not request attention while blocked: %j',
  async (props) => {
    await render(props);
    expect(bar()!.getAttribute('data-attention')).toBe('false');
    await render();
    expect(bar()!.getAttribute('data-attention')).toBe('true');
  },
);

it('dismisses task details outside without losing a quiz choice', async () => {
  const quiz = {
    ...view,
    stage: { kind: 'check', checker: 'quiz' },
    actions: ['quiz'],
  } as LearningView;
  function Quiz() {
    const [checked, setChecked] = useState(false);
    const options = { view: quiz, children: null, action: null };
    return createElement(
      TaskDock,
      options,
      createElement('input', {
        type: 'radio',
        checked,
        onChange: () => setChecked(true),
      }),
    );
  }
  await act(async () => root.render(createElement(Quiz)));
  const toggle = host.querySelector<HTMLButtonElement>('[data-pbl-tour="task-trigger"]')!;
  await act(async () => toggle.click());
  const input = host.querySelector('input')!;
  expect(input.checked).toBe(false);
  await act(async () => input.click());
  expect(input.checked).toBe(true);
  await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(host.querySelector('[role="region"]')).toBeNull();
  await act(async () => toggle.click());
  expect(host.querySelector('input')!.checked).toBe(true);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(host.querySelector('[role="region"]')).toBeNull();
  expect(document.activeElement).toBe(toggle);
});
