/**
 * The composer's optimistic send state (`composer-send-state.ts`): the rule
 * that flips the send button to STOP the instant send is pressed, without
 * waiting for the runner's claim scan to surface `session_resumed` in the
 * fold.
 *
 * Pins the contract the workbench button depends on: a terminal status shows
 * STOP while a send is pending, and the pending flag is dropped exactly when
 * the fold's status moves off the value it had at send time — never by a
 * timer, never by assuming how long the server will take.
 */
import { describe, expect, it } from 'vitest';

import {
  isComposerLive,
  isRunLive,
  shouldPromptForRefInstruction,
  shouldDropPendingSend,
  shouldDropPendingStop,
} from '@/components/workbench/chat/composer-send-state';
import type { SessionStatus } from '@/lib/workbench/session-store';

const LIVE: SessionStatus[] = ['connecting', 'queued', 'running'];
const TERMINAL: SessionStatus[] = ['succeeded', 'failed', 'cancelled'];

describe('isComposerLive', () => {
  it('the fold live statuses show STOP with or without a pending send', () => {
    for (const status of LIVE) {
      expect(isComposerLive({ status, pendingSend: false })).toBe(true);
      expect(isComposerLive({ status, pendingSend: true })).toBe(true);
    }
  });

  it('a terminal status shows STOP the instant send is pressed (optimistic)', () => {
    for (const status of TERMINAL) {
      expect(isComposerLive({ status, pendingSend: false })).toBe(false);
      expect(isComposerLive({ status, pendingSend: true })).toBe(true);
    }
  });
});

describe('refs-only composer guidance', () => {
  it('prompts for an instruction only when refs are staged without text', () => {
    expect(shouldPromptForRefInstruction({ hasElementRefs: true, hasText: false })).toBe(true);
    expect(shouldPromptForRefInstruction({ hasElementRefs: true, hasText: true })).toBe(false);
    expect(shouldPromptForRefInstruction({ hasElementRefs: false, hasText: false })).toBe(false);
  });
});

describe('shouldDropPendingSend', () => {
  it('keeps STOP while the fold has not moved (the claim scan is in flight)', () => {
    for (const status of TERMINAL) {
      expect(shouldDropPendingSend({ pendingSend: true, status, startedStatus: status })).toBe(
        false,
      );
    }
  });

  it('drops the flag when the runner confirms: terminal -> running/queued', () => {
    for (const started of TERMINAL) {
      expect(
        shouldDropPendingSend({ pendingSend: true, status: 'running', startedStatus: started }),
      ).toBe(true);
      expect(
        shouldDropPendingSend({ pendingSend: true, status: 'queued', startedStatus: started }),
      ).toBe(true);
    }
  });

  it('drops the flag when the run settles terminal without a live status', () => {
    // A failed run (or a cancel requested during the optimistic window) ends
    // the STOP without ever confirming live — the send button must return.
    expect(
      shouldDropPendingSend({ pendingSend: true, status: 'failed', startedStatus: 'succeeded' }),
    ).toBe(true);
    expect(
      shouldDropPendingSend({
        pendingSend: true,
        status: 'cancelled',
        startedStatus: 'succeeded',
      }),
    ).toBe(true);
    // A steer send (already live) drops the moment the run ends.
    expect(
      shouldDropPendingSend({ pendingSend: true, status: 'succeeded', startedStatus: 'running' }),
    ).toBe(true);
  });

  it('a cleared flag or an unknown started status never drops', () => {
    expect(
      shouldDropPendingSend({
        pendingSend: false,
        status: 'succeeded',
        startedStatus: 'succeeded',
      }),
    ).toBe(false);
    expect(
      shouldDropPendingSend({ pendingSend: true, status: 'succeeded', startedStatus: null }),
    ).toBe(false);
  });
});

describe('isRunLive', () => {
  it('is the fold half of "the run is in flight", shared by both flags', () => {
    for (const status of LIVE) expect(isRunLive(status)).toBe(true);
    for (const status of TERMINAL) expect(isRunLive(status)).toBe(false);
  });
});

describe('shouldDropPendingStop', () => {
  it('holds 正在停止 for as long as the run is still live', () => {
    // POST /cancel answers 202 — the runner has been asked, not stopped. The
    // loop only notices between steps, so an in-flight tool call can keep the
    // run alive for tens of seconds after the click.
    for (const status of LIVE) {
      expect(shouldDropPendingStop({ pendingStop: true, status })).toBe(false);
    }
  });

  it('lifts on any terminal status, not just cancelled', () => {
    // cancelled is the normal answer; succeeded/failed mean the run reached the
    // finish line first, which is a correction to show, not an error to report.
    for (const status of TERMINAL) {
      expect(shouldDropPendingStop({ pendingStop: true, status })).toBe(true);
    }
  });

  it('cannot strand the button when the cancel was pressed after the run ended', () => {
    // The composer can be showing STOP on `pendingSend` alone (a follow-up the
    // runner has not claimed yet) while the fold status is still terminal. A
    // "status moved off its old value" rule would wait forever here; this one
    // resolves on the next render.
    expect(shouldDropPendingStop({ pendingStop: true, status: 'succeeded' })).toBe(true);
  });

  it('says nothing when no stop is pending', () => {
    for (const status of [...LIVE, ...TERMINAL]) {
      expect(shouldDropPendingStop({ pendingStop: false, status })).toBe(false);
    }
  });
});
