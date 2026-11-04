import 'server-only';
import { maintainLearningEnvironments } from './lifecycle';
import {
  PBL_LIFECYCLE_INTERVAL_MS,
  pblIdleTimeoutMs,
  pblArchiveFailureGraceMs,
} from './lifecycle-config';

const KEY = Symbol.for('openmaic.pbl-lifecycle');
interface Schedule {
  stop(): Promise<void>;
  runNow(): Promise<void>;
}
const state = globalThis as typeof globalThis & { [key: symbol]: Schedule | undefined };

/** One process schedule, durable state, and existing PG locks across replicas. */
export function startLearningLifecycle(run = maintainLearningEnvironments): Schedule | undefined {
  if (state[KEY]) return state[KEY];
  if (!process.env.DATABASE_URL) return;
  pblIdleTimeoutMs();
  pblArchiveFailureGraceMs();
  let stopped = false;
  let pending: Promise<void> | undefined;
  const runNow = async () => {
    if (stopped || pending) return;
    pending = run().catch(() =>
      console.warn('[pbl-lifecycle] Reconciliation unavailable; retrying.'),
    );
    try {
      await pending;
    } finally {
      pending = undefined;
    }
  };
  const timer = setInterval(() => void runNow(), PBL_LIFECYCLE_INTERVAL_MS);
  timer.unref();
  const schedule: Schedule = {
    runNow,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
      if (state[KEY] === schedule) delete state[KEY];
    },
  };
  state[KEY] = schedule;
  void runNow();
  return schedule;
}
