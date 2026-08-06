/**
 * Detects whether another browsing realm currently has a stage open.
 *
 * A peer's unflushed edits cannot be observed: its Zustand aggregate lives in a
 * different realm and leaves no persisted trace during its save debounce. So
 * rather than trying to read that state, writers that would mutate a globally
 * keyed asset ask whether anyone else is editing at all, and fall back to
 * allocating a fresh id when the answer is yes or unknown.
 */
const PRESENCE_CHANNEL = 'maic-stage-presence';
const PROBE_TIMEOUT_MS = 60;

type PresenceMessage =
  | { readonly kind: 'probe'; readonly stageId: string; readonly probeId: string }
  | { readonly kind: 'present'; readonly stageId: string; readonly probeId: string };

let channel: BroadcastChannel | undefined;
let openStageId: (() => string | undefined) | undefined;

/**
 * Announces which stage this realm has open, so peers probing for owners get an
 * answer. Called once where the stage store is available.
 */
export function bindStageRealmPresence(currentStageId: () => string | undefined): void {
  openStageId = currentStageId;
  if (channel || typeof BroadcastChannel !== 'function') return;
  try {
    channel = new BroadcastChannel(PRESENCE_CHANNEL);
    channel.onmessage = (event: MessageEvent<PresenceMessage>) => {
      const message = event.data;
      if (!message || message.kind !== 'probe') return;
      if (openStageId?.() !== message.stageId) return;
      channel?.postMessage({
        kind: 'present',
        stageId: message.stageId,
        probeId: message.probeId,
      } satisfies PresenceMessage);
    };
  } catch {
    channel = undefined;
  }
}

/**
 * True when another realm answers that it has this stage open, and also true
 * when presence cannot be established at all — an unanswerable question must
 * not be read as "nobody else is editing".
 */
export async function isStageOpenInAnotherRealm(stageId: string): Promise<boolean> {
  if (typeof BroadcastChannel !== 'function') return false;
  if (!channel) return false;
  const probeId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (present: boolean) => {
      if (settled) return;
      settled = true;
      channel?.removeEventListener('message', listener);
      clearTimeout(timer);
      resolve(present);
    };
    const listener = (event: MessageEvent<PresenceMessage>) => {
      const message = event.data;
      if (message?.kind === 'present' && message.probeId === probeId) finish(true);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    try {
      channel!.addEventListener('message', listener);
      channel!.postMessage({ kind: 'probe', stageId, probeId } satisfies PresenceMessage);
    } catch {
      finish(false);
    }
  });
}

/** Test seam: drops the channel so a suite can model separate realms. */
export function __resetStageRealmPresenceForTesting(): void {
  channel?.close();
  channel = undefined;
  openStageId = undefined;
}
