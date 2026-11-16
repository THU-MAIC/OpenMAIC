// @vitest-environment jsdom
/**
 * Auto-confirming the agent's recommended option.
 *
 * The rules are pure (`canAutoConfirm`, the timer) and covered as such; the
 * form is then driven in a DOM to show the whole contract end to end: a live
 * question with a recommendation counts down and sends exactly the label a
 * click would, and every way the user can be present (a press, a key, typing,
 * a hidden tab, the preference) keeps it from answering for them.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canAutoConfirm,
  countdownSeconds,
  createAutoConfirmTimer,
  isDeliberateKey,
  openQuestionCount,
  recommendedOption,
} from '@/components/workbench/chat/question-auto-confirm-state';
import { QuestionForm } from '@/components/workbench/chat/question-form';
import { QuestionCard } from '@/components/workbench/chat/question-card';
import {
  AUTO_CONFIRM_SECONDS,
  useQuestionAutoConfirm,
} from '@/lib/workbench/question-auto-confirm';
import { useQuestionDrafts } from '@/lib/workbench/question-host';
import { sessionScopedKey } from '@/lib/workbench/request-scope';
import { useWorkbenchStore, type ChatNode } from '@/lib/workbench/session-store';
import { useSettingsStore } from '@/lib/store/settings';

const DURATION = AUTO_CONFIRM_SECONDS * 1000;

function question(extra: Partial<ChatNode> = {}): ChatNode {
  return {
    key: 'e7',
    kind: 'question',
    text: 'Build this plan?',
    questionOptions: [
      { id: 'go', label: 'Go ahead', recommended: true },
      { id: 'change', label: 'Change it' },
    ],
    ...extra,
  };
}

const eligible = {
  node: question(),
  live: true,
  enabled: true,
  stopped: false,
  locked: false,
  openQuestions: 1,
};

describe('recommendedOption', () => {
  it('is the single marked option, never the free-text one', () => {
    expect(recommendedOption(question())?.id).toBe('go');
    expect(recommendedOption(question({ questionOptions: [{ id: 'a', label: 'A' }] }))).toBeNull();
    expect(
      recommendedOption(
        question({
          questionOptions: [
            { id: 'a', label: 'A', recommended: true },
            { id: 'b', label: 'B', recommended: true },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      recommendedOption(
        question({ questionOptions: [{ id: 'other', label: 'Other', recommended: true }] }),
      ),
    ).toBeNull();
    expect(recommendedOption(question({ questionOptions: undefined }))).toBeNull();
  });
});

describe('canAutoConfirm', () => {
  it('counts down only when every condition holds', () => {
    expect(canAutoConfirm(eligible)).toBe(true);
    expect(canAutoConfirm({ ...eligible, live: false })).toBe(false);
    expect(canAutoConfirm({ ...eligible, enabled: false })).toBe(false);
    expect(canAutoConfirm({ ...eligible, stopped: true })).toBe(false);
    expect(canAutoConfirm({ ...eligible, locked: true })).toBe(false);
    expect(canAutoConfirm({ ...eligible, openQuestions: 2 })).toBe(false);
    expect(canAutoConfirm({ ...eligible, node: question({ questionAnswered: true }) })).toBe(false);
    expect(
      canAutoConfirm({
        ...eligible,
        node: question({ questionOptions: [{ id: 'a', label: 'A' }] }),
      }),
    ).toBe(false);
  });

  it('treats a multi-select question by the same rules', () => {
    const multi = question({ questionMultiSelect: true });
    expect(canAutoConfirm({ ...eligible, node: multi })).toBe(true);
    expect(canAutoConfirm({ ...eligible, node: multi, live: false })).toBe(false);
    expect(
      canAutoConfirm({
        ...eligible,
        node: question({
          questionMultiSelect: true,
          questionOptions: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        }),
      }),
    ).toBe(false);
  });

  it('counts the open questions in the transcript', () => {
    expect(openQuestionCount([question(), question({ key: 'e9', questionAnswered: true })])).toBe(
      1,
    );
  });
});

describe('the countdown timer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once after the duration', () => {
    const onFire = vi.fn();
    createAutoConfirmTimer({ durationMs: DURATION, onFire });
    vi.advanceTimersByTime(DURATION - 1);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DURATION);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('holds while paused and resumes with the time that was left', () => {
    const onFire = vi.fn();
    const timer = createAutoConfirmTimer({ durationMs: DURATION, onFire });
    vi.advanceTimersByTime(3000);
    timer.pause('hover');
    vi.advanceTimersByTime(60_000);
    expect(onFire).not.toHaveBeenCalled();
    expect(timer.snapshot()).toEqual({ phase: 'paused', remainingMs: DURATION - 3000 });
    timer.resume('hover');
    vi.advanceTimersByTime(DURATION - 3000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('stays paused until every reason is gone (a hidden tab outlasts the pointer)', () => {
    const onFire = vi.fn();
    const timer = createAutoConfirmTimer({ durationMs: DURATION, onFire, pausedFor: ['hidden'] });
    expect(timer.snapshot().phase).toBe('paused');
    timer.pause('hover');
    timer.resume('hover');
    vi.advanceTimersByTime(DURATION * 2);
    expect(onFire).not.toHaveBeenCalled();
    timer.resume('hidden');
    vi.advanceTimersByTime(DURATION);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('never fires once cancelled', () => {
    const onFire = vi.fn();
    const timer = createAutoConfirmTimer({ durationMs: DURATION, onFire });
    vi.advanceTimersByTime(5000);
    timer.cancel();
    timer.resume('hover');
    vi.advanceTimersByTime(DURATION * 2);
    expect(onFire).not.toHaveBeenCalled();
    expect(timer.snapshot().phase).toBe('cancelled');
  });

  it('reads whole seconds and ignores lone modifier keys', () => {
    expect(countdownSeconds(DURATION)).toBe(AUTO_CONFIRM_SECONDS);
    expect(countdownSeconds(7001)).toBe(8);
    expect(countdownSeconds(1)).toBe(1);
    expect(countdownSeconds(0)).toBe(1);
    expect(isDeliberateKey('Meta')).toBe(false);
    expect(isDeliberateKey('Shift')).toBe(false);
    expect(isDeliberateKey('a')).toBe(true);
    expect(isDeliberateKey('Enter')).toBe(true);
  });
});

describe('the answer form', () => {
  const SESSION = 'session-1';
  const key = sessionScopedKey(SESSION, 'e7');
  let root: Root;
  let container: HTMLDivElement;
  let answers: string[];
  let visibility: DocumentVisibilityState;

  const onAnswer = async (text: string) => {
    answers.push(text);
    return true;
  };

  async function mount(node: ChatNode = question(), live = true) {
    useWorkbenchStore.setState({ sessionId: SESSION, chat: [node] } as never);
    useQuestionAutoConfirm.setState({
      live: live ? [key] : [],
      stopped: [],
      autoConfirmed: [],
      loaded: true,
    });
    await act(async () =>
      root.render(createElement(QuestionForm, { node, onAnswer, onDismiss: () => {} })),
    );
  }

  const form = () => container.querySelector('[data-testid="workbench-question-form"]');
  const advance = async (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    answers = [];
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    useQuestionDrafts.setState({ drafts: {} });
    useSettingsStore.setState({ autoConfirmRecommendedAnswer: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('counts down on a live question and sends what clicking the recommendation would', async () => {
    await mount();
    expect(form()?.getAttribute('data-auto-confirm')).toBe('running');
    expect(
      container.querySelector('[data-testid="workbench-question-auto-confirm"]')?.textContent,
    ).toContain(String(AUTO_CONFIRM_SECONDS));
    await advance(DURATION);
    expect(answers).toEqual(['Go ahead']);
    expect(useQuestionAutoConfirm.getState().autoConfirmed).toContain(key);
  });

  it('sends only the recommended label for a multi-select question', async () => {
    await mount(question({ questionMultiSelect: true }));
    await advance(DURATION);
    expect(answers).toEqual(['Go ahead']);
  });

  it('does not count down for a replayed question', async () => {
    await mount(question(), false);
    expect(form()?.getAttribute('data-auto-confirm')).toBeNull();
    await advance(DURATION * 2);
    expect(answers).toEqual([]);
  });

  it('does not count down without a recommendation', async () => {
    await mount(question({ questionOptions: [{ id: 'a', label: 'A' }] }));
    expect(form()?.getAttribute('data-auto-confirm')).toBeNull();
    await advance(DURATION * 2);
    expect(answers).toEqual([]);
  });

  it('does not count down with the preference off', async () => {
    useSettingsStore.setState({ autoConfirmRecommendedAnswer: false });
    await mount();
    expect(form()?.getAttribute('data-auto-confirm')).toBeNull();
    await advance(DURATION * 2);
    expect(answers).toEqual([]);
  });

  it('stops for good on a press inside the form', async () => {
    await mount();
    await advance(2000);
    await act(async () => {
      form()?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(form()?.getAttribute('data-auto-confirm')).toBeNull();
    await advance(DURATION * 2);
    expect(answers).toEqual([]);
  });

  it('stops for good when the user types anywhere', async () => {
    await mount();
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
    });
    await advance(DURATION * 2);
    expect(answers).toEqual([]);
  });

  it('ignores a lone modifier key', async () => {
    await mount();
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', bubbles: true }));
    });
    await advance(DURATION);
    expect(answers).toEqual(['Go ahead']);
  });

  it('pauses while the tab is hidden', async () => {
    await mount();
    await advance(2000);
    visibility = 'hidden';
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    await advance(DURATION * 3);
    expect(answers).toEqual([]);
    expect(form()?.getAttribute('data-auto-confirm')).toBe('paused');
    visibility = 'visible';
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    await advance(DURATION - 2000);
    expect(answers).toEqual(['Go ahead']);
  });

  it('turns the preference off from the form', async () => {
    await mount();
    const off = container.querySelector<HTMLButtonElement>(
      '[data-testid="workbench-question-auto-confirm-off"]',
    );
    await act(async () => off?.click());
    expect(useSettingsStore.getState().autoConfirmRecommendedAnswer).toBe(false);
    await advance(DURATION * 2);
    expect(answers).toEqual([]);
  });

  it('labels the answered card as auto-selected', async () => {
    const node = question({ questionAnswered: true });
    useWorkbenchStore.setState({ sessionId: SESSION, chat: [node] } as never);
    useQuestionAutoConfirm.setState({ autoConfirmed: [key], loaded: true });
    await act(async () => root.render(createElement(QuestionCard, { node })));
    expect(
      container.querySelector('[data-testid="workbench-question-auto-confirmed"]'),
    ).not.toBeNull();
    useQuestionAutoConfirm.setState({ autoConfirmed: [] });
    await act(async () => root.render(createElement(QuestionCard, { node })));
    expect(container.querySelector('[data-testid="workbench-question-auto-confirmed"]')).toBeNull();
  });
});
