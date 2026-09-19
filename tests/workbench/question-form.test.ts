/**
 * The composer takeover form — the shape `ask_user` gives the input area while a
 * question waits.
 *
 * Two halves, both testable without a DOM. The KEYBOARD is a pure reducer, so the
 * matrix below is the contract itself rather than a description of it: which key
 * does what, at which highlight position, and — the rule that actually breaks
 * things when it is wrong — what happens to those keys while the caret sits in a
 * text box. The RENDER assertions cover what a user can tell apart: a
 * questionnaire with numbered rows and the free-text row at the end, an open
 * question degraded to one box, and a submit control that starts dead because
 * nothing is picked yet.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QUESTION_FORM_KEY_HINT, QuestionForm } from '@/components/workbench/chat/question-form';
import {
  composerTakeover,
  editingKindFor,
  formAnswerText,
  moveHighlight,
  NO_PICKS,
  OTHER_ROW_LABEL,
  pickOption,
  pickOther,
  questionFormKeyAction,
  questionFormRows,
  quickPickIndex,
} from '@/components/workbench/chat/question-form-state';
import { multiAnswerSeparator } from '@/components/workbench/chat/question-card-state';
import { composerLayout, wbStyles } from '@/components/workbench/chat/chat-styles';
import { defaultWorkbenchTranslator } from '@/lib/i18n/workbench';
import type { ChatNode } from '@/lib/workbench/session-store';

/** The default locale's list separator, which the answer text is joined with. */
const SEPARATOR = multiAnswerSeparator(defaultWorkbenchTranslator);

const options = [
  { id: 'plan-a', label: '按章节' },
  { id: 'plan-b', label: '按项目' },
];

function question(extra: Partial<ChatNode> = {}): ChatNode {
  return { key: 'q1', kind: 'question', text: '先做哪一版大纲？', ...extra };
}

const form = (node: ChatNode, onAnswer?: (text: string) => Promise<boolean>) =>
  renderToStaticMarkup(createElement(QuestionForm, { node, onAnswer, onDismiss: () => {} }));

/** How many controls are actually dead — the class names contain "disabled:" too. */
const deadControls = (html: string) => html.split('disabled=""').length - 1;

describe('questionFormRows', () => {
  it('appends 其他 after the envelope options, and nothing at all for an open question', () => {
    expect(questionFormRows(question({ questionOptions: options }))).toEqual([
      { kind: 'option', id: 'plan-a', label: '按章节' },
      { kind: 'option', id: 'plan-b', label: '按项目' },
      { kind: 'other' },
    ]);
    // No options means no rows to navigate: the form degrades to one box.
    expect(questionFormRows(question())).toEqual([]);
  });
});

describe('picking', () => {
  it('single choice replaces, and drops the written answer', () => {
    expect(pickOption(NO_PICKS, 'plan-a', false)).toEqual({
      picked: ['plan-a'],
      otherPicked: false,
    });
    expect(pickOption({ picked: ['plan-a'], otherPicked: false }, 'plan-b', false)).toEqual({
      picked: ['plan-b'],
      otherPicked: false,
    });
    expect(pickOption({ picked: [], otherPicked: true }, 'plan-a', false)).toEqual({
      picked: ['plan-a'],
      otherPicked: false,
    });
  });

  it('multi toggles, and lets canned picks and a written answer coexist', () => {
    expect(pickOption(NO_PICKS, 'plan-a', true)).toEqual({
      picked: ['plan-a'],
      otherPicked: false,
    });
    expect(pickOption({ picked: ['plan-a'], otherPicked: true }, 'plan-b', true)).toEqual({
      picked: ['plan-a', 'plan-b'],
      otherPicked: true,
    });
    expect(pickOption({ picked: ['plan-a'], otherPicked: false }, 'plan-a', true)).toEqual({
      picked: [],
      otherPicked: false,
    });
  });

  it('其他 is a radio in single choice (never unpicks) and a checkbox in multi', () => {
    expect(pickOther({ picked: ['plan-a'], otherPicked: false }, false)).toEqual({
      picked: [],
      otherPicked: true,
    });
    expect(pickOther({ picked: [], otherPicked: true }, false)).toEqual({
      picked: [],
      otherPicked: true,
    });
    expect(pickOther({ picked: ['plan-a'], otherPicked: false }, true)).toEqual({
      picked: ['plan-a'],
      otherPicked: true,
    });
    expect(pickOther({ picked: ['plan-a'], otherPicked: true }, true)).toEqual({
      picked: ['plan-a'],
      otherPicked: false,
    });
  });
});

describe('formAnswerText', () => {
  const answer = (input: Partial<Parameters<typeof formAnswerText>[0]>) =>
    formAnswerText({
      mode: 'single',
      options,
      picks: NO_PICKS,
      otherText: '',
      openText: '',
      ...input,
    });

  it('is empty until there is something to send — which is what disables 提交', () => {
    expect(answer({})).toBe('');
    expect(answer({ mode: 'open', openText: '   ' })).toBe('');
    // The "other" pick, blank, is still nothing to send.
    expect(answer({ picks: { picked: [], otherPicked: true } })).toBe('');
  });

  it('sends the picked label, or the written text when 其他 is the pick', () => {
    expect(answer({ picks: { picked: ['plan-b'], otherPicked: false } })).toBe('按项目');
    expect(
      answer({ picks: { picked: [], otherPicked: true }, otherText: '  先做大纲再说  ' }),
    ).toBe('先做大纲再说');
  });

  it('multi joins in ENVELOPE order with the written answer last', () => {
    expect(
      formAnswerText({
        mode: 'multi',
        options,
        picks: { picked: ['plan-b', 'plan-a'], otherPicked: true },
        otherText: '再加一版逐字稿',
        openText: '',
      }),
    ).toBe(`按章节${SEPARATOR}按项目${SEPARATOR}再加一版逐字稿`);
  });

  it('an open question sends exactly what was typed, trimmed', () => {
    expect(answer({ mode: 'open', openText: ' 我想先看看素材 \n' })).toBe('我想先看看素材');
  });
});

describe('highlight movement', () => {
  // Three rows means indexes 0..2, plus 3 = submit.
  it('is clamped at both ends: ↑ on the first row does not teleport to 提交', () => {
    expect(moveHighlight(0, -1, 3)).toBe(0);
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, 1, 3)).toBe(3);
    expect(moveHighlight(3, 1, 3)).toBe(3);
    expect(moveHighlight(3, -1, 3)).toBe(2);
  });
});

describe('quickPickIndex', () => {
  it('maps 1-9 onto the rows that exist, 其他 included', () => {
    expect(quickPickIndex('1', 3)).toBe(0);
    expect(quickPickIndex('3', 3)).toBe(2);
    // Past the list: no row, no action (rather than a silent pick of the last).
    expect(quickPickIndex('4', 3)).toBeNull();
    expect(quickPickIndex('0', 3)).toBeNull();
    expect(quickPickIndex('a', 3)).toBeNull();
    expect(quickPickIndex('Enter', 3)).toBeNull();
  });
});

describe('editingKindFor', () => {
  it('separates the line box from the multi-line one — Enter means different things', () => {
    expect(editingKindFor('INPUT')).toBe('line');
    expect(editingKindFor('textarea')).toBe('multiline');
    expect(editingKindFor('BUTTON')).toBe(false);
    expect(editingKindFor('DIV')).toBe(false);
  });
});

describe('questionFormKeyAction', () => {
  const key = (input: Partial<Parameters<typeof questionFormKeyAction>[0]>) =>
    questionFormKeyAction({
      key: 'Enter',
      editing: false,
      modifier: false,
      highlight: 0,
      rowCount: 3,
      ...input,
    });

  it('↑↓ move the highlight', () => {
    expect(key({ key: 'ArrowDown', highlight: 0 })).toEqual({ type: 'move', index: 1 });
    expect(key({ key: 'ArrowUp', highlight: 2 })).toEqual({ type: 'move', index: 1 });
    expect(key({ key: 'ArrowUp', highlight: 0 })).toEqual({ type: 'move', index: 0 });
  });

  it('1-9 confirm a row directly — the fast path for "highlight it, then Enter"', () => {
    expect(key({ key: '2' })).toEqual({ type: 'activate', index: 1 });
    expect(key({ key: '9' })).toEqual({ type: 'none' });
  });

  it('Enter confirms the highlight, and submits once the highlight is on 提交', () => {
    expect(key({ key: 'Enter', highlight: 1 })).toEqual({ type: 'activate', index: 1 });
    expect(key({ key: 'Enter', highlight: 3 })).toEqual({ type: 'submit' });
    // An open question has no rows at all, so Enter can only mean submit.
    expect(key({ key: 'Enter', highlight: 0, rowCount: 0 })).toEqual({ type: 'submit' });
  });

  it('Escape always dismisses — including from inside a text box', () => {
    expect(key({ key: 'Escape' })).toEqual({ type: 'dismiss' });
    expect(key({ key: 'Escape', editing: 'line' })).toEqual({ type: 'dismiss' });
    expect(key({ key: 'Escape', editing: 'multiline' })).toEqual({ type: 'dismiss' });
  });

  it('typing in a box never quick-picks and never moves the highlight', () => {
    // The one that would make the "other" box unusable: digits are text there.
    expect(key({ key: '2', editing: 'line' })).toEqual({ type: 'none' });
    expect(key({ key: '2', editing: 'multiline' })).toEqual({ type: 'none' });
    expect(key({ key: 'a', editing: 'line' })).toEqual({ type: 'none' });
    expect(key({ key: 'ArrowDown', editing: 'line' })).toEqual({ type: 'none' });
    expect(key({ key: 'ArrowUp', editing: 'multiline' })).toEqual({ type: 'none' });
  });

  it('Enter in a box: submits the 其他 line, writes a newline in an open answer', () => {
    expect(key({ key: 'Enter', editing: 'line' })).toEqual({ type: 'submit' });
    expect(key({ key: 'Enter', editing: 'multiline' })).toEqual({ type: 'none' });
  });

  it('⌘/Ctrl+Enter submits from anywhere, textarea included', () => {
    expect(key({ key: 'Enter', modifier: true, editing: 'multiline' })).toEqual({
      type: 'submit',
    });
    expect(key({ key: 'Enter', modifier: true, editing: false, highlight: 0 })).toEqual({
      type: 'submit',
    });
  });

  it('an IME candidate commit is not a submit', () => {
    expect(key({ key: 'Enter', composing: true, editing: 'line' })).toEqual({ type: 'none' });
    expect(key({ key: 'Enter', composing: true, editing: false })).toEqual({ type: 'none' });
    // Escape still gets out, composing or not.
    expect(key({ key: 'Escape', composing: true })).toEqual({ type: 'dismiss' });
  });

  it('anything else is nothing', () => {
    expect(key({ key: 'Tab' })).toEqual({ type: 'none' });
    expect(key({ key: 'x' })).toEqual({ type: 'none' });
  });
});

describe('composerTakeover', () => {
  const q1 = question({ key: 'q1' });
  const q2 = question({ key: 'q2' });

  it('gives the composer to the waiting question, and back when it is waved off', () => {
    expect(composerTakeover({ pending: null, dismissedKey: null })).toBeNull();
    expect(composerTakeover({ pending: q1, dismissedKey: null })).toBe(q1);
    // Dismiss: the composer is restored, and the question itself is untouched.
    expect(composerTakeover({ pending: q1, dismissedKey: 'q1' })).toBeNull();
  });

  it('a NEW question takes it over again without anything being reset', () => {
    expect(composerTakeover({ pending: q2, dismissedKey: 'q1' })).toBe(q2);
  });

  it('a stale dismissal cannot resurrect a form for a question nobody is waiting on', () => {
    expect(composerTakeover({ pending: null, dismissedKey: 'q1' })).toBeNull();
  });
});

describe('QuestionForm render', () => {
  it('is a questionnaire: numbered rows, radios, 其他 last, 提交 dead until a pick', () => {
    const html = form(question({ questionOptions: options }), async () => true);
    expect(html).toContain('workbench-question-form');
    expect(html).toContain('data-mode="single"');
    expect(html).toContain('先做哪一版大纲？');
    expect(html).toContain('workbench-question-form-option-plan-a');
    expect(html).toContain('workbench-question-form-option-plan-b');
    // The free-text channel is the last row, not a sentence about another box.
    expect(html).toContain('workbench-question-form-other');
    expect(html).toContain(OTHER_ROW_LABEL);
    expect(html.indexOf('workbench-question-form-other')).toBeGreaterThan(
      html.indexOf('workbench-question-form-option-plan-b'),
    );
    // Radio semantics for a single-choice question.
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="radio"');
    expect(html).toContain('aria-checked="false"');
    // Nothing is picked yet, so submit is the only dead control.
    expect(html).toContain('workbench-question-form-submit');
    expect(deadControls(html)).toBe(1);
    expect(html).toContain('workbench-question-form-dismiss');
  });

  it('numbers every row, 其他 included, so the digit shortcuts do not lie', () => {
    const html = form(question({ questionOptions: options }), async () => true);
    for (const badge of ['>1<', '>2<', '>3<']) expect(html).toContain(badge);
  });

  it('multi-select is a checkbox group, not a radio group', () => {
    const html = form(
      question({ questionOptions: options, questionMultiSelect: true }),
      async () => true,
    );
    expect(html).toContain('data-mode="multi"');
    expect(html).toContain('role="group"');
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain('role="checkbox"');
  });

  it('an open question degrades to the question plus one box, no rows', () => {
    const html = form(question(), async () => true);
    expect(html).toContain('data-mode="open"');
    expect(html).toContain('workbench-question-form-open');
    expect(html).not.toContain('workbench-question-form-option-');
    expect(html).not.toContain('workbench-question-form-other');
    // Still submittable-looking chrome, still dead: nothing has been typed.
    expect(html).toContain('workbench-question-form-submit');
    expect(deadControls(html)).toBe(1);
  });

  it('the 其他 box only exists once that row is picked', () => {
    // Nothing picked on a fresh render, so no stray input to tab into.
    expect(form(question({ questionOptions: options }), async () => true)).not.toContain(
      'workbench-question-form-other-input',
    );
  });

  it('caps the question and the row list so the bottom-anchored form cannot grow off screen', () => {
    const html = form(
      question({ text: '很长的问题'.repeat(80), questionOptions: options }),
      async () => true,
    );
    expect(html).toContain('overflow-y-auto');
    expect(html).toMatch(/max-h-\[\d+vh\]/);
  });

  it('states the keyboard once, as decoration', () => {
    const html = form(question({ questionOptions: options }), async () => true);
    expect(html).toContain(QUESTION_FORM_KEY_HINT);
    expect(html).toContain('aria-hidden="true"');
  });

  it('is a plain section that owns Escape, not a modal', () => {
    // It takes the composer's place rather than covering the app: no dialog
    // semantics, no focus trap — but Escape belongs to it while it is up, which
    // is what keeps the double-Escape run-stop from firing underneath.
    const html = form(question({ questionOptions: options }), async () => true);
    expect(html).toContain('<section');
    expect(html).toContain('data-esc-owner');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
  });

  it('a host with no send path renders the record with everything dead', () => {
    const html = form(question({ questionOptions: options }));
    // Two option rows + the "other" row + submit.
    expect(deadControls(html)).toBe(4);
  });

  it('an answered question renders no live controls either', () => {
    const html = form(
      question({ questionOptions: options, questionAnswered: true }),
      async () => true,
    );
    expect(deadControls(html)).toBe(4);
  });
});

/**
 * The form takes real space. Everything about "the transcript must not hide
 * behind the composer" reduces to this one rule, so it is pinned here rather
 * than measured in a browser: BOTH composer modes are in flow and opaque, and the
 * viewport's reserve is only a gutter because the viewport itself ends where the
 * composer begins. The ordinary composer used to float against a fixed `pb-36`
 * reserve — a bet on its height that any attachment row (a material, a slide
 * reference, a loaded skill) collected by growing over unread messages.
 */
describe('composerLayout', () => {
  const input = composerLayout(false);
  const form = composerLayout(true);

  it('puts the ordinary composer IN the layout too, so its context rows cannot overlap', () => {
    expect(input.mode).toBe('input');
    expect(input.footer).not.toContain('absolute');
    expect(input.footer).toContain('relative');
    expect(input.footer).toContain('shrink-0');
    // Opaque and non-floating: a variable-height composer cannot be paid for by
    // a fixed reserve, and a gradient over unread text is the overlap wearing a
    // veil.
    expect(input.footer).toContain('bg-background');
    expect(input.footer).not.toContain('bg-gradient');
    expect(input.footer).not.toContain('pointer-events-none');
    expect(input.scrollPadding).toBe('pb-4');
    expect(input.jumpButtonOffset).toBe('bottom-3');
  });

  it('keeps the composer context inside the input box, bounded and scrollable', () => {
    // The attached pills live INSIDE the box they qualify, and past a few rows
    // the block scrolls rather than pushing the textarea off the surface.
    expect(wbStyles.composer.context).toContain('max-h-');
    expect(wbStyles.composer.context).toContain('overflow-y-auto');
    // The seam is a fade over the viewport's own gutter, never a veil that eats
    // pointer events.
    expect(wbStyles.composer.seamFade).toContain('pointer-events-none');
    expect(wbStyles.composer.seamFade).toContain('h-3');
  });

  it('puts the question form IN the layout, so nothing can sit under it', () => {
    expect(form.mode).toBe('form');
    expect(form.footer).not.toContain('absolute');
    expect(form.footer).toContain('relative');
    // In flow it must not shrink under a tall transcript, and it must be opaque:
    // a gradient over unread text is the overlap bug wearing a veil.
    expect(form.footer).toContain('shrink-0');
    expect(form.footer).toContain('bg-background');
    expect(form.footer).not.toContain('bg-gradient');
    expect(form.footer).not.toContain('pointer-events-none');
    // No reserve to pay: the viewport ends where the form begins.
    expect(form.scrollPadding).toBe('pb-4');
    expect(form.jumpButtonOffset).toBe('bottom-3');
  });

  it('keeps the question body scrollable inside the form either way', () => {
    // The form is allowed to be tall, but not unbounded: a 40-line question
    // scrolls inside its own box instead of pushing the rows off screen.
    expect(wbStyles.questionForm.question).toContain('max-h-[22vh]');
    expect(wbStyles.questionForm.question).toContain('overflow-y-auto');
    expect(wbStyles.questionForm.rows).toContain('max-h-[34vh]');
    expect(wbStyles.questionForm.rows).toContain('overflow-y-auto');
  });
});
