'use client';

/**
 * The composer's optimistic states — the two moments where the button has to
 * answer before the runner can: "send was just pressed, show STOP" and "stop
 * was just accepted, show the stopping label".
 *
 * The fold's `status` only moves when a runner lifecycle event arrives:
 * `session_resumed` / `session_start` flip it to `running`, and a posted
 * follow-up has to wait for the runner's next claim scan first (up to
 * `scanIntervalMs`) before that event exists. The send button must not wait
 * for that round trip — the instant send is pressed it flips to STOP, and
 * this module is the pure rule for that flag's lifetime.
 *
 * `isComposerLive` is the single source for "STOP, not send": the fold's own
 * live statuses, OR the optimistic flag.
 *
 * The flag is dropped the moment the fold's status moves off the value it
 * had when send was pressed — the runner confirmed (live), or a terminal
 * `session_end` settled the send (failed / cancelled / succeeded) — or by
 * the POST failure path in the component, which clears it directly. Keeping
 * the flag while the status has NOT moved is deliberate: for a posted
 * follow-up the runner emits its resume before it can settle, so an
 * unchanged terminal status means the claim is still in flight and STOP is
 * still the honest button (and the cancel path works against it).
 *
 * The stop flag is the mirror image and answers a different question — see
 * `shouldDropPendingStop`.
 */
import type { SessionStatus } from '@/lib/workbench/session-store';

/** Whether the fold itself says a run is in flight. */
export function isRunLive(status: SessionStatus): boolean {
  return status === 'running' || status === 'queued' || status === 'connecting';
}

/** Whether the composer should show STOP (the run is live) instead of send. */
export function isComposerLive(input: { status: SessionStatus; pendingSend: boolean }): boolean {
  const { status, pendingSend } = input;
  return isRunLive(status) || pendingSend;
}

/** Explain the intentionally disabled refs-only send state in the composer. */
export function shouldPromptForRefInstruction(input: {
  hasElementRefs: boolean;
  hasText: boolean;
}): boolean {
  return input.hasElementRefs && !input.hasText;
}

/**
 * Whether the optimistic STOP should be dropped: only when the fold's status
 * has moved off the value it had at send time. `startedStatus` is null once
 * the flag has been cleared (POST failure or a previous drop), which never
 * drops.
 */
export function shouldDropPendingSend(input: {
  pendingSend: boolean;
  status: SessionStatus;
  startedStatus: SessionStatus | null;
}): boolean {
  const { pendingSend, status, startedStatus } = input;
  return pendingSend && startedStatus !== null && status !== startedStatus;
}

/**
 * Whether the optimistic "stopping" label should be dropped, i.e. the run is no
 * longer live.
 *
 * `POST /cancel` answers 202: it means the runner has been ASKED, not that it
 * has stopped. What actually ends the run is the loop noticing between steps —
 * after an in-flight tool call returns, which can be tens of seconds — and
 * writing `session_end`. So the flag is held on the fold's own liveness rather
 * than on any local timer, and it lifts on whatever terminal status arrives
 * (cancelled normally; succeeded or failed if the run beat the cancel to the
 * finish line, which is a correction, not an error to report).
 *
 * Deliberately NOT the `shouldDropPendingSend` shape ("status moved off the
 * value it had"): a cancel pressed while the status is already terminal — a
 * follow-up that the runner has not claimed yet, so the composer is showing
 * STOP on `pendingSend` alone — would then wait for a change that may never
 * come, and stick on "stopping" forever. Asking "is it still live" cannot
 * strand the button.
 */
export function shouldDropPendingStop(input: {
  pendingStop: boolean;
  status: SessionStatus;
}): boolean {
  const { pendingStop, status } = input;
  return pendingStop && !isRunLive(status);
}
