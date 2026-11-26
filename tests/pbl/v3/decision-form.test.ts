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
    responseLabel: 'Text answer',
    rationaleLabel: 'Evidence',
    options: [{ id: 'plain', label: 'Plain text' }],
  });
  expect(container.textContent).not.toContain('Text answer');
  expect(container.textContent).not.toContain('Evidence');
  await act(async () => container.querySelector('button')!.click());
  expect(submit).toHaveBeenCalledWith('plain');
  expect(container.querySelector('textarea')).toBeNull();
});

it('requires an explanation before submitting an option with rationale', async () => {
  await mount({
    id: 'format',
    prompt: 'Choose and explain',
    requiresRationale: true,
    rationaleLabel: 'What makes this format a good fit?',
    options: [{ id: 'plain', label: 'Plain text' }],
  });
  expect(container.querySelector('textarea')!.labels![0]!.textContent).toBe(
    'What makes this format a good fit?',
  );
  const button = () => container.querySelectorAll('button')[1]!;
  await act(async () => container.querySelector('button')!.click());
  expect(submit).not.toHaveBeenCalled();
  expect(button().disabled).toBe(true);
  await type(0, 'It fits my use case.');
  expect(button().disabled).toBe(false);
  await act(async () => button().click());
  expect(submit).toHaveBeenCalledWith('plain', 'It fits my use case.');
});

it.each([
  [undefined, undefined],
  ['Proposed rule', undefined],
  [undefined, 'Supporting evidence'],
  ['Proposed rule', 'Supporting evidence'],
])('labels each text field independently (%s, %s)', async (responseLabel, rationaleLabel) => {
  await mount({
    id: 'rule',
    prompt: 'How should duplicates be handled?',
    responseType: 'text',
    requiresRationale: true,
    responseLabel,
    rationaleLabel,
    options: [],
  });
  expect(container.querySelector('legend')!.textContent).toBe('How should duplicates be handled?');
  expect(
    [...container.querySelectorAll('textarea')].map((field) => field.labels![0]!.textContent),
  ).toEqual([
    responseLabel ?? 'pblV3.decisionResponse',
    rationaleLabel ?? 'pblV3.decisionRationale',
  ]);
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

it.each(['chosen', 'rationale'] as const)(
  'preserves an unstorable %s draft for correction before submitting',
  async (field) => {
    const draft = { chosen: 'Rule', rationale: 'Reason', [field]: 'bad\0text' };
    await mount(
      { id: 'rule', prompt: 'Explain', responseType: 'text', requiresRationale: true, options: [] },
      draft,
    );
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(
      'pblV3.decisionInvalidText',
    );
    expect(container.querySelector('button')!.disabled).toBe(true);
    expect(container.querySelectorAll('textarea')[field === 'chosen' ? 0 : 1]!.value).toBe(
      draft[field],
    );
    await type(field === 'chosen' ? 0 : 1, 'Corrected text');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('button')!.disabled).toBe(false);
  },
);

it('marks only acknowledged answers submitted and enables changed or failed submissions', async () => {
  const decision: LearningView['decisions'][number] = {
    id: 'rule',
    prompt: 'Describe your rule',
    responseType: 'text',
    options: [],
  };
  const selected = { id: 'rule', chosen: 'Saved rule', rationale: '', revision: 0 };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const render = (chosen: string, acknowledged = true, pendingChosen?: string) =>
    act(async () =>
      root!.render(
        createElement(DecisionResponseForm, {
          decision,
          selected: acknowledged ? selected : undefined,
          draft: { chosen, rationale: '' },
          disabled: pendingChosen !== undefined,
          pendingChosen,
          onDraftChange: () => {},
          onSubmit: submit,
        }),
      ),
    );
  await render('Saved rule');
  expect(container.querySelector('button')!.disabled).toBe(true);
  expect(container.querySelector('button')!.textContent).toBe('pblV3.submitted');
  await render('Changed rule');
  expect(container.querySelector('button')!.disabled).toBe(false);
  expect(container.querySelector('button')!.textContent).toBe('pblV3.resubmit');
  await render('Changed rule', true, 'Changed rule');
  expect(container.querySelector('button')!.textContent).toBe('pblV3.submitting');
  await render('Changed rule');
  expect(container.querySelector('button')!.disabled).toBe(false);
  await render('First unsaved rule', false);
  expect(container.querySelector('button')!.textContent).toBe('pblV3.submitDecision');
});

it('distinguishes pending immediate choices from acknowledged choices and permits retry', async () => {
  const decision: LearningView['decisions'][number] = {
    id: 'format',
    prompt: 'Choose a format',
    options: [
      { id: 'plain', label: 'Plain text' },
      { id: 'json', label: 'JSON' },
    ],
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const render = (chosen?: string, pendingChosen?: string) =>
    act(async () =>
      root!.render(
        createElement(DecisionResponseForm, {
          decision,
          selected: chosen ? { id: 'format', chosen, revision: 0 } : undefined,
          disabled: pendingChosen !== undefined,
          pendingChosen,
          onDraftChange: () => {},
          onSubmit: submit,
        }),
      ),
    );
  const status = () => container.querySelector('[role="status"]');
  const options = () => container.querySelectorAll('button');
  await render();
  expect(status()).toBeNull();
  options()[0]!.focus();
  await render(undefined, 'plain');
  expect(document.activeElement).toBe(options()[0]);
  await act(async () => {
    options()[0]!.click();
    options()[1]!.click();
  });
  expect(submit).not.toHaveBeenCalled();
  expect(status()!.textContent).toBe('pblV3.submitting');
  await render('plain');
  expect(status()!.textContent).toBe('pblV3.submitted');
  expect(document.activeElement).toBe(options()[0]);
  expect(options()[0]!.disabled).toBe(false);
  expect(options()[0]!.getAttribute('aria-disabled')).toBe('true');
  await act(async () => options()[0]!.click());
  expect(submit).not.toHaveBeenCalled();
  expect(options()[1]!.disabled).toBe(false);
  await render('plain', 'json');
  expect(status()!.textContent).toBe('pblV3.submitting');
  expect(status()!.getAttribute('aria-busy')).toBe('true');
  expect(options()[1]!.getAttribute('aria-pressed')).toBe('true');
  // Failed replacement: only the prior receipt remains selected; another choice can retry.
  await render('plain');
  expect(options()[0]!.getAttribute('aria-pressed')).toBe('true');
  expect(options()[1]!.getAttribute('aria-pressed')).toBe('false');
  await act(async () => options()[1]!.click());
  expect(submit).toHaveBeenCalledWith('json');
  await render('json');
  expect(status()!.textContent).toBe('pblV3.submitted');
  expect(options()[0]!.disabled).toBe(false);
  expect(options()[1]!.disabled).toBe(false);
  expect(options()[1]!.getAttribute('aria-disabled')).toBe('true');
});
