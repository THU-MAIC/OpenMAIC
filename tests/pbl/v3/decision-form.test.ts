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
import { DECISION_RESPONSE_MAX_LENGTH } from '@/lib/pbl/v3/domain/orchestration/decisions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement;
const submit = vi.fn(async () => true);
function Form({
  decision,
  initialDraft,
}: {
  decision: LearningView['decisions'][number];
  initialDraft?: DecisionDraft;
}) {
  const [draft, setDraft] = useState<DecisionDraft | undefined>(initialDraft);
  return createElement(DecisionResponseForm, {
    decision,
    draft,
    disabled: false,
    onDraftChange: setDraft,
    onSubmit: submit,
  });
}
async function mount(decision: LearningView['decisions'][number], initialDraft?: DecisionDraft) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(Form, { decision, initialDraft })));
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

it.each(['chosen', 'rationale'] as const)(
  'preserves an oversized restored %s for correction without submitting or truncating it',
  async (field) => {
    const draft = {
      chosen: 'Rule',
      rationale: 'Reason',
      [field]: 'x'.repeat(DECISION_RESPONSE_MAX_LENGTH + 1),
    };
    await mount(
      {
        id: 'rule',
        prompt: 'Explain your rule',
        responseType: 'text',
        requiresRationale: true,
        options: [],
      },
      draft,
    );
    const fields = () => [...container.querySelectorAll('textarea')];
    const index = field === 'chosen' ? 0 : 1;
    const button = () => container.querySelector('button')!;
    expect(fields().every((node) => node.maxLength === DECISION_RESPONSE_MAX_LENGTH)).toBe(true);
    expect(fields()[index]!.value).toBe(draft[field]);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(button().disabled).toBe(true);
    await act(async () => button().click());
    expect(submit).not.toHaveBeenCalled();
    await type(index, 'x'.repeat(DECISION_RESPONSE_MAX_LENGTH));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(submit).toHaveBeenCalledWith(
      field === 'chosen' ? 'x'.repeat(DECISION_RESPONSE_MAX_LENGTH) : draft.chosen,
      field === 'rationale' ? 'x'.repeat(DECISION_RESPONSE_MAX_LENGTH) : draft.rationale,
    );
  },
);

it('keeps an over-budget Unicode draft editable and enables submission after correction', async () => {
  await mount(
    { id: 'rule', prompt: 'Explain', responseType: 'text', requiresRationale: true, options: [] },
    {
      chosen: '🧠'.repeat(32_000),
      rationale: '🧠'.repeat(32_000),
    },
  );
  expect(container.querySelector('button')!.disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.querySelector('textarea')!.value.length).toBe(64_000);
  await type(1, 'A shorter reason');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('button')!.disabled).toBe(false);
});
