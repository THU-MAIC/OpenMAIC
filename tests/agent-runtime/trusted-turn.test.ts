import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';

import {
  buildGuardedCoachCancelledTurnEventData,
  durableUserMessageSeq,
  GUARDED_COACH_CANCELLED_TURN_EVENT,
  guardedCoachCancelledTurnEventSeq,
  inspectClaimSettledCancellation,
  isGuardedCoachCancelledTurnEventType,
  redactClaimSettledCancellationForPublicEventData,
  recoverTrustedUserMessageSeq,
  tagDurableUserMessage,
} from '@/lib/server/agent-runtime/trusted-turn';

const user = (text: string) => ({ role: 'user', content: text }) as unknown as AgentMessage;
const assistant = (text: string) =>
  ({ role: 'assistant', content: [{ type: 'text', text }] }) as unknown as AgentMessage;

describe('trusted durable user turn recovery', () => {
  it('recovers the exact tagged turn from the raw branch', () => {
    const frame = tagDurableUserMessage(user('turn N'), 7);

    expect(durableUserMessageSeq(frame)).toBe(7);
    expect(
      recoverTrustedUserMessageSeq({
        cursorMessages: [frame, assistant('working')],
        loggedMessages: [{ seq: 7 }],
        claimSeq: 9,
      }),
    ).toEqual({ ok: true, userMessageSeq: 7 });
  });

  it('does not replace turn N with a later queued N+1 event', () => {
    expect(
      recoverTrustedUserMessageSeq({
        cursorMessages: [tagDurableUserMessage(user('turn N'), 7), assistant('working')],
        loggedMessages: [{ seq: 7 }, { seq: 12 }],
        claimSeq: 12,
      }),
    ).toEqual({ ok: true, userMessageSeq: 7 });
  });

  it('uses raw cursor messages even when the compacted context omitted the user frame', () => {
    const cursorMessages = [tagDurableUserMessage(user('turn N'), 7), assistant('working')];
    const compactedContext = [assistant('summary without the original user frame')];

    expect(compactedContext.findLast((message) => message.role === 'user')).toBeUndefined();
    expect(
      recoverTrustedUserMessageSeq({
        cursorMessages,
        loggedMessages: [{ seq: 7 }],
        claimSeq: 8,
      }),
    ).toEqual({ ok: true, userMessageSeq: 7 });
  });

  it('fails closed when a post-claim frame appears in the branch', () => {
    expect(
      recoverTrustedUserMessageSeq({
        cursorMessages: [
          tagDurableUserMessage(user('turn N'), 7),
          tagDurableUserMessage(user('turn N+1'), 12),
        ],
        loggedMessages: [{ seq: 7 }, { seq: 12 }],
        claimSeq: 10,
      }),
    ).toEqual({ ok: false, reason: 'after-claim-watermark' });
  });

  it('does not fall back to an older tag when the latest user frame has no provenance', () => {
    expect(
      recoverTrustedUserMessageSeq({
        cursorMessages: [tagDurableUserMessage(user('turn N'), 7), user('synthetic')],
        loggedMessages: [{ seq: 7 }],
        claimSeq: 8,
      }),
    ).toEqual({ ok: false, reason: 'missing-durable-tag' });
  });

  it.each([
    {
      label: 'there is no user frame',
      cursorMessages: [assistant('working')],
      loggedMessages: [{ seq: 7 }],
      claimSeq: 8,
      reason: 'no-user-frame',
    },
    {
      label: 'the tag is invalid',
      cursorMessages: [tagDurableUserMessage(user('turn N'), 0)],
      loggedMessages: [{ seq: 7 }],
      claimSeq: 8,
      reason: 'invalid-durable-tag',
    },
    {
      label: 'the claim watermark is invalid',
      cursorMessages: [tagDurableUserMessage(user('turn N'), 7)],
      loggedMessages: [{ seq: 7 }],
      claimSeq: -1,
      reason: 'invalid-claim-seq',
    },
    {
      label: 'the durable row is missing',
      cursorMessages: [tagDurableUserMessage(user('turn N'), 7)],
      loggedMessages: [{ seq: 8 }],
      claimSeq: 9,
      reason: 'durable-row-missing',
    },
    {
      label: 'the durable row is duplicated',
      cursorMessages: [tagDurableUserMessage(user('turn N'), 7)],
      loggedMessages: [{ seq: 7 }, { seq: 7 }],
      claimSeq: 9,
      reason: 'duplicate-durable-row',
    },
  ] as const)(
    'fails closed when $label',
    ({ cursorMessages, loggedMessages, claimSeq, reason }) => {
      expect(recoverTrustedUserMessageSeq({ cursorMessages, loggedMessages, claimSeq })).toEqual({
        ok: false,
        reason,
      });
    },
  );
});

describe('guarded cancellation event provenance', () => {
  it('round-trips one exact durable user seq through the internal marker', () => {
    const event = {
      type: GUARDED_COACH_CANCELLED_TURN_EVENT,
      data: buildGuardedCoachCancelledTurnEventData(7),
    };

    expect(isGuardedCoachCancelledTurnEventType(event.type)).toBe(true);
    expect(guardedCoachCancelledTurnEventSeq(event)).toBe(7);
    expect(guardedCoachCancelledTurnEventSeq({ type: 'session_end', data: {} })).toBeNull();
  });

  it.each([
    null,
    {},
    { schemaVersion: 2, userMessageSeq: 7 },
    { schemaVersion: 1, userMessageSeq: 0 },
    { schemaVersion: 1, userMessageSeq: '7' },
  ])('rejects malformed internal marker data %#', (data) => {
    expect(() =>
      guardedCoachCancelledTurnEventSeq({
        type: GUARDED_COACH_CANCELLED_TURN_EVENT,
        data,
      }),
    ).toThrow('marker is malformed');
  });

  it('inspects and redacts the claim-scan exact cancellation target', () => {
    const event = {
      type: 'session_end',
      data: { status: 'cancelled', cancelledUserMessageSeq: 7 },
    };

    expect(inspectClaimSettledCancellation(event)).toEqual({
      status: 'exact',
      userMessageSeq: 7,
    });
    expect(redactClaimSettledCancellationForPublicEventData(event.data)).toEqual({
      status: 'cancelled',
    });
    expect(
      inspectClaimSettledCancellation({ type: 'session_end', data: { status: 'cancelled' } }),
    ).toEqual({ status: 'legacy' });
  });

  it('rejects a malformed exact claim-scan target', () => {
    expect(() =>
      inspectClaimSettledCancellation({
        type: 'session_end',
        data: { status: 'cancelled', cancelledUserMessageSeq: '7' },
      }),
    ).toThrow('target is malformed');
  });
});
