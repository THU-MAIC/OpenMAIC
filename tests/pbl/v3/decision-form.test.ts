// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
import {
  DecisionResponseForm,
  type DecisionDraft,
} from '@/components/scene-renderers/pbl/v3/decision-response';
import type { LearningView } from '@/lib/pbl/v3/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement;
const submit = vi.fn(async () => true);
function Form({ decision }: { decision: LearningView['decisions'][number] }) {
  const [draft, setDraft] = useState<DecisionDraft>();
  return createElement(DecisionResponseForm, {
    decision,
    draft,
    disabled: false,
    onDraftChange: setDraft,
    onSubmit: submit,
  });
}
async function mount(decision: LearningView['decisions'][number]) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(Form, { decision })));
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
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  submit.mockClear();
});

it('keeps the existing immediate-submit choice interaction', async () => {
  await mount({
    id: 'format',
    prompt: 'Choose a format',
    options: [{ id: 'plain', label: 'Plain text' }],
  });
  await act(async () => container.querySelector('button')!.click());
  expect(submit).toHaveBeenCalledWith('plain');
  expect(container.querySelector('textarea')).toBeNull();
});

it('requires an explanation before submitting an option with rationale', async () => {
  await mount({
    id: 'format',
    prompt: 'Choose and explain',
    requiresRationale: true,
    options: [{ id: 'plain', label: 'Plain text' }],
  });
  const button = () => container.querySelectorAll('button')[1]!;
  await act(async () => container.querySelector('button')!.click());
  expect(submit).not.toHaveBeenCalled();
  expect(button().disabled).toBe(true);
  await type(0, 'It fits my use case.');
  expect(button().disabled).toBe(false);
  await act(async () => button().click());
  expect(submit).toHaveBeenCalledWith('plain', 'It fits my use case.');
});

it('submits learner-authored multiline text and rationale without a prefilled answer', async () => {
  await mount({
    id: 'rule',
    prompt: 'Describe the rule and explain it.',
    responseType: 'text',
    requiresRationale: true,
    options: [],
  });
  const button = () => container.querySelector('button')!;
  expect([...container.querySelectorAll('textarea')].map((n) => n.value)).toEqual(['', '']);
  await type(0, '  \n ');
  await type(1, 'A reason');
  expect(button().disabled).toBe(true);
  await type(0, 'If the condition holds, act.\nOtherwise keep the current state.');
  await act(async () => button().click());
  expect(submit).toHaveBeenCalledWith(
    'If the condition holds, act.\nOtherwise keep the current state.',
    'A reason',
  );
});
