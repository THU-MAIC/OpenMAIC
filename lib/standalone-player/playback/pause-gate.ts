/**
 * Pause/cancel plumbing of the standalone player's sequencer. Pure (timers
 * only), so the sequencing rules are unit-testable with fake timers.
 */

export type PauseListener = (paused: boolean) => void;

/** Shared pause state every running step observes. */
export class PauseGate {
  private pausedState = false;
  private readonly listeners = new Set<PauseListener>();

  get paused(): boolean {
    return this.pausedState;
  }

  set(paused: boolean): void {
    if (paused === this.pausedState) return;
    this.pausedState = paused;
    for (const listener of [...this.listeners]) listener(paused);
  }

  subscribe(listener: PauseListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once the gate is open (immediately when it is) or the run is cancelled. */
  whenOpen(signal: AbortSignal): Promise<void> {
    if (!this.pausedState || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        unsubscribe();
        signal.removeEventListener('abort', done);
        resolve();
      };
      const unsubscribe = this.subscribe((paused) => {
        if (!paused) done();
      });
      signal.addEventListener('abort', done, { once: true });
    });
  }
}

/** What a running step needs to honour pause and cancellation. */
export interface StepControl {
  readonly signal: AbortSignal;
  readonly gate: PauseGate;
}

/**
 * Wait `ms` of playing time: the countdown stops while the gate is paused and
 * the wait resolves early (without error) when the run is cancelled.
 * `skip` resolves it early on demand (e.g. the learner dismisses a card).
 */
export function pausableDelay(
  ms: number,
  control: StepControl,
  skip?: (resolveEarly: () => void) => void,
): Promise<void> {
  const { signal, gate } = control;
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let remaining = Math.max(0, ms);
    let startedAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const stop = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
    };
    const start = () => {
      if (timer !== null || settled) return;
      startedAt = Date.now();
      timer = setTimeout(finish, remaining);
    };
    function finish() {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      unsubscribe();
      signal.removeEventListener('abort', finish);
      resolve();
    }
    const unsubscribe = gate.subscribe((paused) => (paused ? stop() : start()));
    signal.addEventListener('abort', finish, { once: true });
    skip?.(finish);
    if (!gate.paused) start();
  });
}
