import 'server-only';
import { SandboxStore } from './store';

const KEY = Symbol.for('openmaic.sandbox-checkpoint-collector');
interface Schedule {
  stop(): Promise<void>;
  collectNow(): Promise<void>;
}
const state = globalThis as typeof globalThis & { [key: symbol]: Schedule | undefined };
/** Own schedule and metadata. No course asset registry/collector participation. */
export function startCheckpointCollector(
  collect = async () => (await SandboxStore.open()).collectCheckpoints(),
): Schedule | undefined {
  if (state[KEY]) return state[KEY];
  // Saved settings can enable sandboxes without environment variables. Continue
  // collecting old checkpoints even if the administrator later disables creation.
  if (!process.env.DATABASE_URL) return;
  let stopped = false;
  let pending: Promise<void> | undefined;
  const collectNow = async () => {
    if (stopped || pending) return;
    pending = (async () => {
      try {
        const result = await collect();
        if (result.deferred)
          console.warn('[sandbox-checkpoints] Collection deferred; retrying next pass.');
      } catch {
        console.warn('[sandbox-checkpoints] Collection unavailable; retrying next pass.');
      }
    })();
    try {
      await pending;
    } finally {
      pending = undefined;
    }
  };
  const timer = setInterval(() => void collectNow(), 15 * 60 * 1000);
  timer.unref();
  const schedule: Schedule = {
    collectNow,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
      if (state[KEY] === schedule) delete state[KEY];
    },
  };
  state[KEY] = schedule;
  void collectNow();
  return schedule;
}
