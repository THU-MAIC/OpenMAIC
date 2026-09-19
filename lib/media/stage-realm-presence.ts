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
/** Resolves once binding has been attempted, so a probe never races the load-time bind. */
let binding: Promise<void> | undefined;
let bindingSettled: (() => void) | undefined;

/**
 * Declares that binding is about to be attempted. The pool binds asynchronously
 * at module load, so without this a probe issued in that window would see no
 * channel and report `unknown` even though presence works moments later.
 */
export function expectStageRealmPresenceBinding(): void {
  if (binding) return;
  binding = new Promise<void>((resolve) => {
    bindingSettled = resolve;
  });
}

/** Opens the gate when binding will never happen, so probes fall through to `unknown`. */
export function releaseStageRealmPresenceBinding(): void {
  bindingSettled?.();
  bindingSettled = undefined;
}

/**
 * Announces which stage this realm has open, so peers probing for owners get an
 * answer. Called once where the stage store is available.
 */
export function bindStageRealmPresence(currentStageId: () => string | undefined): void {
  openStageId = currentStageId;
  bindingSettled?.();
  bindingSettled = undefined;
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
 * Outcome of a presence probe. `unknown` is distinct from `absent` on purpose:
 * a question we could not ask must never be read as "nobody else is editing",
 * and keeping it in the type stops a caller from collapsing the two.
 */
export type StageRealmPresence = 'present' | 'absent' | 'unknown';

/**
 * Ask whether another realm has this stage open.
 *
 * Returns `unknown` whenever the transport cannot carry the question — no
 * `BroadcastChannel` in this environment, binding not completed yet (the pool
 * binds asynchronously at load), a channel constructor that threw, or a send
 * that failed. Callers must treat `unknown` the way they treat `present`.
 */
export async function probeStageRealmPresence(stageId: string): Promise<StageRealmPresence> {
  if (typeof BroadcastChannel !== 'function') return 'unknown';
  if (binding) await binding;
  if (!channel) return 'unknown';
  const probe = channel;
  const probeId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<StageRealmPresence>((resolve) => {
    let settled = false;
    const finish = (presence: StageRealmPresence) => {
      if (settled) return;
      settled = true;
      probe.removeEventListener('message', listener);
      clearTimeout(timer);
      resolve(presence);
    };
    const listener = (event: MessageEvent<PresenceMessage>) => {
      const message = event.data;
      if (message?.kind === 'present' && message.probeId === probeId) finish('present');
    };
    // Only a probe that was actually sent and went unanswered means "absent".
    const timer = setTimeout(() => finish('absent'), PROBE_TIMEOUT_MS);
    try {
      probe.addEventListener('message', listener);
      probe.postMessage({ kind: 'probe', stageId, probeId } satisfies PresenceMessage);
    } catch {
      finish('unknown');
    }
  });
}

/** Test seam: drops the channel so a suite can model separate realms. */
export function __resetStageRealmPresenceForTesting(): void {
  channel?.close();
  channel = undefined;
  openStageId = undefined;
}
