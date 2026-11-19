'use client';

/**
 * What the workbench remembers about auto-confirming an agent's question.
 *
 * When `ask_user` marks one option as recommended, the answer form counts down
 * and, if the user does nothing, sends that option exactly as a click would
 * (`components/workbench/chat/question-auto-confirm-state.ts`). Three facts
 * outside any one form decide whether that may happen and what the transcript
 * says afterwards, so they live here:
 *
 *  - LIVE questions: only a question that arrived on the live stream during the
 *    CURRENT attachment of its session may count down. The stream forgets a
 *    session's live questions whenever it attaches to or leaves that session,
 *    so a question replayed from the backlog (an old session reopened, the same
 *    session left unanswered and opened again, a reconnect catching up) is
 *    history the user has not seen arrive, and answering it for them would be
 *    acting on a decision they never saw.
 *  - STOPPED questions: once the user touched a question's form, or its
 *    countdown fired, it is over for good, even if the form unmounts and mounts
 *    again elsewhere (the composer and the request preview host the same
 *    question). Firing CLAIMS the question here first, so two forms that both
 *    happen to be counting down for it can send its answer only once.
 *  - AUTO-CONFIRMED questions: the answer an auto-confirm sends is an ordinary
 *    user message (the whole `ask_user` answer protocol), so the only record that
 *    it was chosen for the user is kept here, per browser, to label the answered
 *    card.
 *
 * Every key is `sessionScopedKey(sessionId, node.key)`.
 */
import { create } from 'zustand';
import { sessionScopedKey } from '@/lib/workbench/request-scope';

/** How long the form waits before sending the recommended option. */
export const AUTO_CONFIRM_SECONDS = 8;

const AUTO_CONFIRMED_STORAGE_KEY = 'openmaic:workbench:auto-confirmed-questions';
const MAX_REMEMBERED = 200;

function readAutoConfirmed(): string[] {
  try {
    if (typeof window === 'undefined') return [];
    const raw = window.localStorage.getItem(AUTO_CONFIRMED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeAutoConfirmed(keys: readonly string[]): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(AUTO_CONFIRMED_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // A label is a convenience; a full or blocked storage just loses it.
  }
}

/** Append a key to a bounded, de-duplicated list (newest last). */
function remember(list: readonly string[], key: string): string[] {
  return [...list.filter((other) => other !== key), key].slice(-MAX_REMEMBERED);
}

interface QuestionAutoConfirmState {
  readonly live: readonly string[];
  readonly stopped: readonly string[];
  readonly autoConfirmed: readonly string[];
  /** Whether `autoConfirmed` has been read from the browser yet. */
  readonly loaded: boolean;
  readonly markLive: (key: string) => void;
  readonly unmarkLive: (key: string) => void;
  /** Forget every live marker of one session (`sessionScopedKey` prefix). */
  readonly forgetLiveSession: (sessionId: string) => void;
  readonly stop: (key: string) => void;
  /** Stop the question and report whether this call was the one that stopped it. */
  readonly claim: (key: string) => boolean;
  readonly markAutoConfirmed: (key: string) => void;
  readonly unmarkAutoConfirmed: (key: string) => void;
  readonly load: () => void;
}

export const useQuestionAutoConfirm = create<QuestionAutoConfirmState>((set, get) => ({
  live: [],
  stopped: [],
  autoConfirmed: [],
  loaded: false,
  markLive: (key) => set((state) => ({ live: remember(state.live, key) })),
  unmarkLive: (key) =>
    set((state) =>
      state.live.includes(key) ? { live: state.live.filter((other) => other !== key) } : state,
    ),
  forgetLiveSession: (sessionId) => {
    const prefix = sessionScopedKey(sessionId, '');
    set((state) =>
      state.live.some((key) => key.startsWith(prefix))
        ? { live: state.live.filter((key) => !key.startsWith(prefix)) }
        : state,
    );
  },
  claim: (key) => {
    if (get().stopped.includes(key)) return false;
    set((state) => ({ stopped: remember(state.stopped, key) }));
    return true;
  },
  stop: (key) =>
    set((state) =>
      state.stopped.includes(key) ? state : { stopped: remember(state.stopped, key) },
    ),
  markAutoConfirmed: (key) => {
    get().load();
    const next = remember(get().autoConfirmed, key);
    writeAutoConfirmed(next);
    set({ autoConfirmed: next });
  },
  unmarkAutoConfirmed: (key) => {
    const next = get().autoConfirmed.filter((other) => other !== key);
    writeAutoConfirmed(next);
    set({ autoConfirmed: next });
  },
  load: () => {
    if (get().loaded) return;
    set((state) => ({
      loaded: true,
      autoConfirmed: [...readAutoConfirmed(), ...state.autoConfirmed].slice(-MAX_REMEMBERED),
    }));
  },
}));
