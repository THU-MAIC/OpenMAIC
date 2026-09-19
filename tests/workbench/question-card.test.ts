/**
 * The `ask_user` question card: the shared pure rules and the transcript row's
 * two visual states. (The composer takeover form lives in `question-form.test.ts`.)
 *
 * The interactive half (a click that sends) is exercised through the rules — the
 * text a set of picks becomes, and when the controls are dead — because the
 * suite runs without a DOM; the render assertions cover what a user can tell
 * apart on screen: a live card with clickable options versus a retired one whose
 * buttons are disabled.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatTimeline } from '@/components/workbench/chat/chat-timeline';
import {
  QUESTION_ANSWERED_LABEL,
  QUESTION_REVIVE_LABEL,
  QUESTION_WAITING_LABEL,
  QuestionCard,
} from '@/components/workbench/chat/question-card';
import {
  answerTextFor,
  isQuestionLocked,
  multiAnswerSeparator,
  pendingQuestion,
  questionHint,
  questionMode,
  togglePicked,
} from '@/components/workbench/chat/question-card-state';
import { defaultWorkbenchTranslator } from '@/lib/i18n/workbench';
import type { ChatNode } from '@/lib/workbench/session-store';

const options = [
  { id: 'plan-a', label: '按章节' },
  { id: 'plan-b', label: '按项目' },
];

function question(extra: Partial<ChatNode> = {}): ChatNode {
  return { key: 'q1', kind: 'question', text: '先做哪一版大纲？', ...extra };
}

const render = (node: ChatNode, onAnswer?: (text: string) => Promise<boolean>) =>
  renderToStaticMarkup(createElement(QuestionCard, { node, onAnswer }));

/**
 * How many controls are actually dead. The rendered class names contain the
 * word "disabled" (`disabled:opacity-70`), so the ATTRIBUTE is what has to be
 * counted — a substring check on "disabled" passes on a fully live card.
 */
const deadControls = (html: string) => html.split('disabled=""').length - 1;

describe('questionMode', () => {
  it('reads the shape off the envelope', () => {
    expect(questionMode(question())).toBe('open');
    expect(questionMode(question({ questionOptions: options }))).toBe('single');
    expect(questionMode(question({ questionOptions: options, questionMultiSelect: true }))).toBe(
      'multi',
    );
  });

  it('degrades multiSelect with no options to an open question', () => {
    // Nothing to select: the only honest shape is the one the payload describes.
    expect(questionMode(question({ questionMultiSelect: true }))).toBe('open');
  });
});

describe('isQuestionLocked', () => {
  it('is live only while unanswered, not sending, and with a send path', () => {
    expect(isQuestionLocked({ answered: false, sending: false, canSend: true })).toBe(false);
    expect(isQuestionLocked({ answered: true, sending: false, canSend: true })).toBe(true);
    expect(isQuestionLocked({ answered: false, sending: true, canSend: true })).toBe(true);
    // A host with no send path shows the record, never a dead action.
    expect(isQuestionLocked({ answered: false, sending: false, canSend: false })).toBe(true);
  });
});

describe('multi-select answers', () => {
  it('toggles picks', () => {
    expect(togglePicked([], 'a')).toEqual(['a']);
    expect(togglePicked(['a'], 'b')).toEqual(['a', 'b']);
    expect(togglePicked(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('joins the picked labels in ENVELOPE order, not click order', () => {
    expect(answerTextFor(options, ['plan-b', 'plan-a'])).toBe(
      `按章节${multiAnswerSeparator(defaultWorkbenchTranslator)}按项目`,
    );
    expect(answerTextFor(options, ['plan-a'])).toBe('按章节');
    // Nothing picked is not a message; the confirm button stays disabled on it.
    expect(answerTextFor(options, [])).toBe('');
    // An id the envelope never offered cannot become an answer.
    expect(answerTextFor(options, ['plan-z'])).toBe('');
  });
});

describe('questionHint', () => {
  it('only speaks where guidance is needed, and never on an answered card', () => {
    // An open question points nowhere now: the composer IS its form while it
    // waits, so "answer in the box below" would describe a box that is the
    // question itself.
    expect(questionHint(question())).toBeNull();
    expect(questionHint(question({ questionOptions: options }))).toBeNull();
    expect(
      questionHint(question({ questionOptions: options, questionMultiSelect: true })),
    ).toContain('多选');
    expect(questionHint(question({ questionAnswered: true }))).toBeNull();
    expect(
      questionHint(
        question({ questionOptions: options, questionMultiSelect: true, questionAnswered: true }),
      ),
    ).toBeNull();
  });
});

describe('QuestionCard render', () => {
  it('a live single-choice card offers the options as enabled buttons', () => {
    const html = render(question({ questionOptions: options }), async () => true);
    expect(html).toContain('workbench-question-card');
    expect(html).toContain('data-answered="false"');
    expect(html).toContain('data-mode="single"');
    expect(html).toContain(QUESTION_WAITING_LABEL);
    expect(html).toContain('先做哪一版大纲？');
    expect(html).toContain('workbench-question-option-plan-a');
    expect(html).toContain('按项目');
    expect(deadControls(html)).toBe(0);
    // Single choice needs no confirm step: the click is the answer.
    expect(html).not.toContain('workbench-question-confirm');
  });

  it('an answered card is retired in place: same rows, dead buttons, no guidance', () => {
    const html = render(
      question({ questionOptions: options, questionAnswered: true }),
      async () => true,
    );
    expect(html).toContain('data-answered="true"');
    expect(html).toContain(QUESTION_ANSWERED_LABEL);
    expect(html).not.toContain(QUESTION_WAITING_LABEL);
    // The options stay as the record of what was offered — but not clickable.
    expect(html).toContain('按章节');
    expect(deadControls(html)).toBe(options.length);
  });

  it('an answered multi-select card drops the confirm action entirely', () => {
    const live = render(
      question({ questionOptions: options, questionMultiSelect: true }),
      async () => true,
    );
    expect(live).toContain('workbench-question-confirm');
    // The options are live; only confirm starts dead, because confirming an
    // empty pick set would send nothing.
    expect(deadControls(live)).toBe(1);
    const answered = render(
      question({ questionOptions: options, questionMultiSelect: true, questionAnswered: true }),
      async () => true,
    );
    expect(answered).not.toContain('workbench-question-confirm');
  });

  it('an open question carries no buttons at all', () => {
    const html = render(question(), async () => true);
    expect(html).toContain('data-mode="open"');
    expect(html).not.toContain('workbench-question-option-');
    expect(html).not.toContain('workbench-question-confirm');
    // The card no longer points at the composer: the composer became the form.
    expect(html).not.toContain('输入框');
  });

  it('a host with no send path renders the record with the options dead', () => {
    const html = render(question({ questionOptions: options }));
    expect(html).toContain('workbench-question-option-plan-a');
    expect(deadControls(html)).toBe(options.length);
  });

  it('the timeline renders the question as its own row, never inside an action cluster', () => {
    const html = renderToStaticMarkup(
      createElement(ChatTimeline, {
        chat: [
          { key: 't1', kind: 'tool', text: '', toolName: 'generate_outline', toolState: 'done' },
          question({ questionOptions: options }),
        ],
        plan: [],
        onAnswer: async () => true,
      }),
    );
    expect(html).toContain('workbench-question-card');
    expect(html).toContain('workbench-question-option-plan-b');
  });
});

describe('pendingQuestion', () => {
  const answered = (key: string) => question({ key, questionAnswered: true });

  it('picks the newest unanswered question, and nothing once answered', () => {
    expect(pendingQuestion([])).toBeNull();
    expect(pendingQuestion([{ key: 'u', kind: 'user', text: 'hi' }])).toBeNull();
    expect(pendingQuestion([answered('q1')])).toBeNull();
    expect(pendingQuestion([question({ key: 'q1' })])?.key).toBe('q1');
    // Answered history plus one open question: the open one.
    expect(pendingQuestion([answered('q1'), question({ key: 'q2' })])?.key).toBe('q2');
    // Newest wins if two are somehow open at once.
    expect(pendingQuestion([question({ key: 'q1' }), question({ key: 'q2' })])?.key).toBe('q2');
  });

  it('ignores everything that is not a question node', () => {
    const chat: ChatNode[] = [
      question({ key: 'q1' }),
      { key: 't1', kind: 'tool', text: '', toolName: 'ask_user', toolState: 'done' },
      { key: 'a1', kind: 'assistant', text: '在等你' },
    ];
    expect(pendingQuestion(chat)?.key).toBe('q1');
  });
});

describe('the way back to a dismissed form', () => {
  it('appears only on the card the host names, and only while it waits', () => {
    // No callback: the ordinary live card, with nothing about a form on it.
    expect(render(question({ questionOptions: options }), async () => true)).not.toContain(
      'workbench-question-revive',
    );
    const withRevive = renderToStaticMarkup(
      createElement(QuestionCard, {
        node: question({ questionOptions: options }),
        onAnswer: async () => true,
        onRevive: () => {},
      }),
    );
    expect(withRevive).toContain('workbench-question-revive');
    expect(withRevive).toContain(QUESTION_REVIVE_LABEL);
    // The options are still live: waving the form off does not retire the card,
    // it only gives the composer back.
    expect(deadControls(withRevive)).toBe(0);
    // An answered question has nothing to go back to.
    const answered = renderToStaticMarkup(
      createElement(QuestionCard, {
        node: question({ questionOptions: options, questionAnswered: true }),
        onAnswer: async () => true,
        onRevive: () => {},
      }),
    );
    expect(answered).not.toContain('workbench-question-revive');
  });

  it('the timeline hands it to the dismissed question and to no other', () => {
    const chat: ChatNode[] = [
      question({ key: 'q1', questionOptions: options, questionAnswered: true }),
      question({ key: 'q2', questionOptions: options }),
    ];
    const html = renderToStaticMarkup(
      createElement(ChatTimeline, {
        chat,
        plan: [],
        onAnswer: async () => true,
        dismissedQuestionKey: 'q2',
        onReviveQuestion: () => {},
      }),
    );
    // One card carries the way back — the dismissed one, not the answered one.
    expect(html.split('workbench-question-revive').length - 1).toBe(1);
    const none = renderToStaticMarkup(
      createElement(ChatTimeline, {
        chat,
        plan: [],
        onAnswer: async () => true,
        dismissedQuestionKey: null,
        onReviveQuestion: () => {},
      }),
    );
    expect(none).not.toContain('workbench-question-revive');
  });
});

/**
 * The card and the composer form are two views of ONE node, so exactly one of
 * them may show the question in full. While the form owns the composer the row
 * is a one-line pointer at it; the moment the form is waved off or answered, the
 * row is the question again.
 */
describe('mutual exclusion with the composer form', () => {
  const long = question({
    key: 'q1',
    text: '这一版大纲要覆盖四件事：\n1. 目标\n2. 章节\n3. 练习\n4. 收尾',
    questionOptions: options,
  });

  const timeline = (takenOverQuestionKey: string | null) =>
    renderToStaticMarkup(
      createElement(ChatTimeline, {
        chat: [{ key: 'a1', kind: 'assistant', text: '我先按章节草拟' }, long],
        plan: [],
        onAnswer: async () => true,
        takenOverQuestionKey,
      }),
    );

  it('collapses the row to one line while the form is up', () => {
    const html = timeline('q1');
    expect(html).toContain('data-collapsed="true"');
    // The question and its options live in the form below, once.
    expect(html).not.toContain('1. 目标');
    expect(html).not.toContain('workbench-question-option-plan-a');
    expect(html).not.toContain('workbench-question-confirm');
    // It still says whose move it is, and where the answer goes.
    expect(html).toContain(QUESTION_WAITING_LABEL);
    expect(html).toContain(defaultWorkbenchTranslator('workbench.question.inFormBelow'));
    // The rest of the transcript is untouched.
    expect(html).toContain('我先按章节草拟');
  });

  it('is the whole question again once the form is gone', () => {
    const html = timeline(null);
    expect(html).toContain('data-collapsed="false"');
    expect(html).toContain('1. 目标');
    expect(html).toContain('workbench-question-option-plan-a');
    expect(html).not.toContain(defaultWorkbenchTranslator('workbench.question.inFormBelow'));
  });

  it('collapses only the question the form is showing', () => {
    const html = renderToStaticMarkup(
      createElement(ChatTimeline, {
        chat: [question({ key: 'q0', questionOptions: options, questionAnswered: true }), long],
        plan: [],
        onAnswer: async () => true,
        takenOverQuestionKey: 'q1',
      }),
    );
    expect(html.split('data-collapsed="true"').length - 1).toBe(1);
    expect(html.split('data-collapsed="false"').length - 1).toBe(1);
  });

  it('never collapses an answered question, whatever the host says', () => {
    // The form is gone by then and this row is the only surviving copy of the
    // question — collapsing it would erase the record.
    const html = renderToStaticMarkup(
      createElement(QuestionCard, {
        node: question({ questionOptions: options, questionAnswered: true }),
        collapsed: true,
      }),
    );
    expect(html).toContain('data-collapsed="false"');
    expect(html).toContain('先做哪一版大纲？');
  });
});
