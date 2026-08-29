import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentSessionUserMessage } from '@openmaic/storage';

const DURABLE_USER_MESSAGE_SEQ = 'openmaicDurableUserMessageSeq';
const CANCELLED_USER_MESSAGE_SEQ = 'cancelledUserMessageSeq';

/** Server-only event-log marker for a guarded turn consumed by cancellation. */
export const GUARDED_COACH_CANCELLED_TURN_EVENT =
  'openmaic.internal.guarded-coach-cancelled-turn.v1';

interface GuardedCoachCancelledTurnEventData {
  schemaVersion: 1;
  userMessageSeq: number;
}

export function buildGuardedCoachCancelledTurnEventData(
  userMessageSeq: number,
): GuardedCoachCancelledTurnEventData {
  if (!Number.isSafeInteger(userMessageSeq) || userMessageSeq < 1) {
    throw new Error('Guarded Coach cancellation marker requires a durable user message seq');
  }
  return { schemaVersion: 1, userMessageSeq };
}

export function isGuardedCoachCancelledTurnEventType(type: string): boolean {
  return type === GUARDED_COACH_CANCELLED_TURN_EVENT;
}

/** Return the exact cancelled turn, rejecting malformed server-owned markers. */
export function guardedCoachCancelledTurnEventSeq(event: {
  type: string;
  data: unknown;
}): number | null {
  if (!isGuardedCoachCancelledTurnEventType(event.type)) return null;
  const data = event.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Guarded Coach cancellation event marker is malformed');
  }
  const marker = data as Record<string, unknown>;
  if (
    marker.schemaVersion !== 1 ||
    !Number.isSafeInteger(marker.userMessageSeq) ||
    Number(marker.userMessageSeq) < 1
  ) {
    throw new Error('Guarded Coach cancellation event marker is malformed');
  }
  return Number(marker.userMessageSeq);
}

export type ClaimSettledCancellationInspection =
  | { status: 'not-cancelled' }
  | { status: 'legacy' }
  | { status: 'exact'; userMessageSeq: number };

/** Inspect the exact target recorded atomically by claim-time cancellation. */
export function inspectClaimSettledCancellation(event: {
  type: string;
  data: unknown;
}): ClaimSettledCancellationInspection {
  if (event.type !== 'session_end') return { status: 'not-cancelled' };
  if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) {
    return { status: 'not-cancelled' };
  }
  const data = event.data as Record<string, unknown>;
  if (data.status !== 'cancelled') return { status: 'not-cancelled' };
  if (!Object.hasOwn(data, CANCELLED_USER_MESSAGE_SEQ)) return { status: 'legacy' };
  const userMessageSeq = data[CANCELLED_USER_MESSAGE_SEQ];
  if (!Number.isSafeInteger(userMessageSeq) || Number(userMessageSeq) < 1) {
    throw new Error('Claim-settled cancellation target is malformed');
  }
  return { status: 'exact', userMessageSeq: Number(userMessageSeq) };
}

/** Strip claim-time turn provenance before a session event crosses SSE. */
export function redactClaimSettledCancellationForPublicEventData(eventData: unknown): unknown {
  if (typeof eventData !== 'object' || eventData === null || Array.isArray(eventData)) {
    return eventData;
  }
  const source = eventData as Record<string, unknown>;
  if (!Object.hasOwn(source, CANCELLED_USER_MESSAGE_SEQ)) return eventData;
  const { [CANCELLED_USER_MESSAGE_SEQ]: _seq, ...redacted } = source;
  return redacted;
}

export type TrustedUserMessageSeqFailureReason =
  | 'no-user-frame'
  | 'missing-durable-tag'
  | 'invalid-durable-tag'
  | 'invalid-claim-seq'
  | 'after-claim-watermark'
  | 'durable-row-missing'
  | 'duplicate-durable-row';

export type TrustedUserMessageSeqResolution =
  | { ok: true; userMessageSeq: number }
  | { ok: false; reason: TrustedUserMessageSeqFailureReason };

/** Tag the exact durable message represented by a user transcript frame. */
export function tagDurableUserMessage(message: AgentMessage, seq: number): AgentMessage {
  return { ...message, [DURABLE_USER_MESSAGE_SEQ]: seq } as unknown as AgentMessage;
}

/** Recover a delivery tag from a user frame without accepting another role. */
export function durableUserMessageSeq(message: AgentMessage): number | null {
  if (message.role !== 'user') return null;
  const value = (message as AgentMessage & Record<string, unknown>)[DURABLE_USER_MESSAGE_SEQ];
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

/** Remove the server-only delivery tag before an event crosses the SSE boundary. */
export function redactDurableUserMessageSeqForPublicEventData(eventData: unknown): unknown {
  if (typeof eventData !== 'object' || eventData === null || Array.isArray(eventData)) {
    return eventData;
  }
  const source = eventData as Record<string, unknown>;
  const redactMessage = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const message = value as Record<string, unknown>;
    if (!Object.hasOwn(message, DURABLE_USER_MESSAGE_SEQ)) return value;
    const { [DURABLE_USER_MESSAGE_SEQ]: _seq, ...redacted } = message;
    return redacted;
  };
  const redacted = { ...source };
  if (source.message !== undefined) redacted.message = redactMessage(source.message);
  if (Array.isArray(source.messages)) redacted.messages = source.messages.map(redactMessage);
  return redacted;
}

/**
 * Recover the in-progress turn from the raw active entry-tree branch.
 *
 * `cursorMessages` is deliberately used instead of the compacted model context
 * or the latest event-log row. A later queued message must not replace the user
 * frame that already started this run. Every mismatch fails closed so callers
 * can publish a server-owned notice without binding a tool to a guessed turn.
 */
export function recoverTrustedUserMessageSeq(input: {
  cursorMessages: readonly AgentMessage[];
  loggedMessages: readonly Pick<AgentSessionUserMessage, 'seq'>[];
  claimSeq: number;
}): TrustedUserMessageSeqResolution {
  if (!Number.isSafeInteger(input.claimSeq) || input.claimSeq < 0) {
    return { ok: false, reason: 'invalid-claim-seq' };
  }

  const userFrame = input.cursorMessages.findLast((message) => message.role === 'user');
  if (!userFrame) return { ok: false, reason: 'no-user-frame' };

  const tagged = userFrame as AgentMessage & Record<string, unknown>;
  if (!Object.hasOwn(tagged, DURABLE_USER_MESSAGE_SEQ)) {
    return { ok: false, reason: 'missing-durable-tag' };
  }
  const userMessageSeq = durableUserMessageSeq(userFrame);
  if (userMessageSeq === null) {
    return { ok: false, reason: 'invalid-durable-tag' };
  }
  if (userMessageSeq > input.claimSeq) {
    return { ok: false, reason: 'after-claim-watermark' };
  }

  const matchingRows = input.loggedMessages.filter((message) => message.seq === userMessageSeq);
  if (matchingRows.length === 0) {
    return { ok: false, reason: 'durable-row-missing' };
  }
  if (matchingRows.length > 1) {
    return { ok: false, reason: 'duplicate-durable-row' };
  }
  return { ok: true, userMessageSeq };
}
