'use client';

/**
 * Auto-confirming the agent's recommended answer.
 *
 * `ask_user` may mark one option as recommended: the plan the agent proposes, a
 * default it would pick itself. A question like that should not stall the
 * conversation on a user who stepped away, so the answer form counts down and,
 * if nothing happens, sends the recommended option exactly as a click on it
 * would — through the form's own send path, as an ordinary user message. The
 * user can answer differently at any time afterwards: the next message is just
 * another turn.
 *
 * The rules, as pure functions and one framework-free timer, so the whole
 * contract is testable without a DOM:
 *
 *  - WHEN it may count down (`canAutoConfirm`): the question has exactly one
 *    recommended option, it arrived live in this visit, it is the only open
 *    question (one answer retires every open card, so it must not answer two),
 *    its form is live, the user has not touched it, and the preference is on.
 *  - WHAT pauses it: the pointer resting on the form (the user is reading) and a
 *    hidden tab (nobody is there to see it). Both resume where they left off.
 *  - WHAT stops it for good: any deliberate input — a press or a key inside the
 *    form, or typing anywhere on the page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatNode, QuestionOption } from '@/lib/workbench/session-store';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { sessionScopedKey } from '@/lib/workbench/request-scope';
import { useSettingsStore } from '@/lib/store/settings';
import {
  AUTO_CONFIRM_SECONDS,
  useQuestionAutoConfirm,
} from '@/lib/workbench/question-auto-confirm';
import { isFreeTextOption, questionMode } from './question-card-state';

/**
 * The option the agent recommended, or null when there is none to act on.
 *
 * Defensive about the envelope: an open question has nothing to pick, the
 * free-text option is a prompt to write rather than an answer, and more than
 * one recommendation is no recommendation at all.
 */
export function recommendedOption(node: ChatNode): QuestionOption | null {
  if (questionMode(node) === 'open') return null;
  const marked = (node.questionOptions ?? []).filter(
    (option) => option.recommended === true && !isFreeTextOption(option.id),
  );
  return marked.length === 1 ? marked[0] : null;
}

/** How many questions are still waiting for an answer. */
export function openQuestionCount(chat: readonly ChatNode[]): number {
  return chat.filter((node) => node.kind === 'question' && !node.questionAnswered).length;
}

export function canAutoConfirm(input: {
  node: ChatNode;
  /** The question arrived on the live stream during this visit. */
  live: boolean;
  /** The user's preference (`autoConfirmRecommendedAnswer`). */
  enabled: boolean;
  /** The user already touched this question's form. */
  stopped: boolean;
  /** The form's controls are dead (answered, sending, or no send path). */
  locked: boolean;
  openQuestions: number;
}): boolean {
  const { node, live, enabled, stopped, locked, openQuestions } = input;
  if (!enabled || !live || stopped || locked) return false;
  if (node.kind !== 'question' || node.questionAnswered) return false;
  if (openQuestions !== 1) return false;
  return recommendedOption(node) !== null;
}

/** The whole seconds left, as the countdown reads them (never "0s" while counting). */
export function countdownSeconds(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

/**
 * Keys that are not typing: a modifier pressed on its own (say, on the way to
 * switching windows) is not the user answering.
 */
const NON_TYPING_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn']);

export function isDeliberateKey(key: string): boolean {
  return !NON_TYPING_KEYS.has(key);
}

export type AutoConfirmPauseReason = 'hover' | 'hidden';
export type AutoConfirmPhase = 'running' | 'paused' | 'cancelled' | 'fired';

export interface AutoConfirmSnapshot {
  readonly phase: AutoConfirmPhase;
  readonly remainingMs: number;
}

export interface AutoConfirmTimer {
  snapshot: () => AutoConfirmSnapshot;
  pause: (reason: AutoConfirmPauseReason) => void;
  resume: (reason: AutoConfirmPauseReason) => void;
  cancel: () => void;
  dispose: () => void;
}

/**
 * The countdown itself, with no React in it.
 *
 * Time is measured, not counted: each tick subtracts the wall-clock time since
 * the last one, so a throttled background timer cannot stretch or shrink the
 * wait. Pauses are reasons, not a flag — the pointer leaving the form must not
 * restart a countdown the hidden tab is still holding.
 */
export function createAutoConfirmTimer(options: {
  durationMs: number;
  onFire: () => void;
  onChange?: (snapshot: AutoConfirmSnapshot) => void;
  pausedFor?: readonly AutoConfirmPauseReason[];
  now?: () => number;
  tickMs?: number;
}): AutoConfirmTimer {
  const { durationMs, onFire, onChange, now = Date.now, tickMs = 250 } = options;
  const reasons = new Set<AutoConfirmPauseReason>(options.pausedFor ?? []);
  let remaining = durationMs;
  let phase: AutoConfirmPhase = reasons.size > 0 ? 'paused' : 'running';
  let since: number | null = null;
  let handle: ReturnType<typeof setTimeout> | null = null;

  const snapshot = (): AutoConfirmSnapshot => ({ phase, remainingMs: Math.max(0, remaining) });
  const emit = () => onChange?.(snapshot());
  const clear = () => {
    if (handle !== null) clearTimeout(handle);
    handle = null;
  };
  const settle = () => {
    if (since === null) return;
    const at = now();
    remaining -= at - since;
    since = at;
  };
  const tick = () => {
    handle = null;
    if (phase !== 'running') return;
    settle();
    if (remaining <= 0) {
      remaining = 0;
      since = null;
      phase = 'fired';
      emit();
      onFire();
      return;
    }
    emit();
    schedule();
  };
  const schedule = () => {
    clear();
    handle = setTimeout(tick, Math.min(tickMs, Math.max(0, remaining)));
  };
  const start = () => {
    since = now();
    schedule();
  };
  const settled = () => phase === 'cancelled' || phase === 'fired';

  if (phase === 'running') start();

  return {
    snapshot,
    pause: (reason) => {
      if (settled()) return;
      reasons.add(reason);
      if (phase !== 'running') return;
      settle();
      since = null;
      clear();
      phase = 'paused';
      emit();
    },
    resume: (reason) => {
      if (settled()) return;
      reasons.delete(reason);
      if (phase !== 'paused' || reasons.size > 0) return;
      phase = 'running';
      start();
      emit();
    },
    cancel: () => {
      if (settled()) return;
      settle();
      since = null;
      clear();
      phase = 'cancelled';
      emit();
    },
    dispose: () => {
      clear();
      since = null;
    },
  };
}

/**
 * Marks the auto-confirm switch. Pressing or keying it is a choice ABOUT the
 * countdown, not an answer to the question, so it never counts as the
 * interaction that stops it.
 */
export const AUTO_CONFIRM_SWITCH_ATTR = 'data-auto-confirm-switch';

function onSwitch(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${AUTO_CONFIRM_SWITCH_ATTR}]`) !== null;
}

/**
 * The countdown for one question's form.
 *
 * Null when the question has no recommendation (there is nothing to
 * auto-confirm, so no switch either). Otherwise the preference, its setter for
 * the form's switch, and — while the question may auto-confirm — the running
 * countdown. Turning the switch off ends the countdown (the preference is off);
 * turning it back on starts it again from the top, unless the user already
 * touched this question.
 */
export function useAutoConfirmCountdown(input: {
  node: ChatNode;
  locked: boolean;
  onFire: (option: QuestionOption) => void;
}): {
  readonly option: QuestionOption;
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
  /** The running or paused countdown, or null while it may not run. */
  readonly snapshot: AutoConfirmSnapshot | null;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  /** A deliberate press inside the form: the countdown is over for this question. */
  readonly onPointerDownCapture: (event: { target: EventTarget | null }) => void;
} | null {
  const { node, locked, onFire } = input;
  const sessionId = useWorkbenchStore((s) => s.sessionId);
  const openQuestions = useWorkbenchStore((s) => openQuestionCount(s.chat));
  const key = sessionScopedKey(sessionId, node.key);
  const live = useQuestionAutoConfirm((s) => s.live.includes(key));
  const stopped = useQuestionAutoConfirm((s) => s.stopped.includes(key));
  const enabled = useSettingsStore((s) => s.autoConfirmRecommendedAnswer);
  const setEnabled = useSettingsStore((s) => s.setAutoConfirmRecommendedAnswer);
  const option = recommendedOption(node);
  const eligible = canAutoConfirm({ node, live, enabled, stopped, locked, openQuestions });

  const timerRef = useRef<AutoConfirmTimer | null>(null);
  const onFireRef = useRef(onFire);
  useEffect(() => {
    onFireRef.current = onFire;
  }, [onFire]);
  const [snapshot, setSnapshot] = useState<AutoConfirmSnapshot | null>(null);

  const stop = useCallback(() => {
    timerRef.current?.cancel();
    useQuestionAutoConfirm.getState().stop(key);
  }, [key]);

  const optionId = option?.id ?? null;
  useEffect(() => {
    if (!eligible || !optionId) return;
    const hidden = () => document.visibilityState === 'hidden';
    const timer = createAutoConfirmTimer({
      durationMs: AUTO_CONFIRM_SECONDS * 1000,
      pausedFor: hidden() ? ['hidden'] : [],
      onChange: setSnapshot,
      onFire: () => {
        useQuestionAutoConfirm.getState().stop(key);
        const recommended = (node.questionOptions ?? []).find((o) => o.id === optionId);
        if (recommended) onFireRef.current(recommended);
      },
    });
    timerRef.current = timer;
    setSnapshot(timer.snapshot());
    const onVisibility = () => (hidden() ? timer.pause('hidden') : timer.resume('hidden'));
    const onKey = (event: KeyboardEvent) => {
      if (isDeliberateKey(event.key) && !onSwitch(event.target)) stop();
    };
    // IME and paste can change an input without a key the page sees first.
    const onInput = () => stop();
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('input', onInput, true);
    return () => {
      timer.dispose();
      if (timerRef.current === timer) timerRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('input', onInput, true);
    };
    // `node` is read only for the option's label at fire time; its identity
    // changes on every fold and must not restart the countdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, optionId, key, stop]);

  if (!option) return null;
  const counting = eligible && snapshot !== null && snapshot.phase !== 'cancelled';
  return {
    option,
    enabled,
    setEnabled,
    snapshot: counting ? snapshot : null,
    onPointerEnter: () => timerRef.current?.pause('hover'),
    onPointerLeave: () => timerRef.current?.resume('hover'),
    onPointerDownCapture: (event) => {
      if (!onSwitch(event.target)) stop();
    },
  };
}
