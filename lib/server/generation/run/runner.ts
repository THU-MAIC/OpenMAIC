/**
 * The process-scoped generation run worker: every application process runs
 * one, whether or not the agent runtime is enabled, because classic
 * generation is the default product.
 *
 * It follows the agent runner's loop (`lib/server/agent-runtime/runner.ts`):
 * scan for claimable runs up to a local concurrency, execute each under a
 * heartbeat, and abort the local execution as soon as the heartbeat finds the
 * lease gone. PostgreSQL decides who executes a run; this process only keeps
 * its own count.
 */
import { randomUUID } from 'node:crypto';

import { createLogger } from '@/lib/logger';

import { generationRunConfig, type GenerationRunConfig } from './config';
import { executeGenerationRun } from './engine';
import { defaultRunStepServices, type RunStepServices } from './services';
import {
  claimNextGenerationRun,
  heartbeatGenerationRun,
  releaseGenerationRunLease,
  type ClaimedRun,
} from './store';

const log = createLogger('GenerationRunner');

const RUNNER_KEY = Symbol.for('openmaic.generation-runs.runner');
const runnerState = globalThis as typeof globalThis & {
  [RUNNER_KEY]?: GenerationRunnerHandle;
};

/** Ask this process's runner to scan now (a command just released a run). */
export function wakeGenerationRunner(): void {
  runnerState[RUNNER_KEY]?.wake();
}

export interface GenerationRunnerHandle {
  workerId: string;
  /** Scan now (a command released a run). */
  wake(): void;
  stop(options?: { timeoutMs?: number }): Promise<void>;
}

export interface GenerationRunnerOptions {
  services?: RunStepServices;
  workerId?: string;
  /** Overrides of the configuration (tests). */
  config?: Partial<GenerationRunConfig>;
}

/** Execute one claimed run to its next stop, under a heartbeat. Exported for the contract tests. */
export async function runClaimedGenerationRun(
  claim: ClaimedRun,
  services: RunStepServices,
  abort: AbortController,
  heartbeatIntervalMs: number,
): Promise<string> {
  const heartbeat = setInterval(() => {
    void heartbeatGenerationRun(claim.lease)
      .then((held) => {
        if (!held && !abort.signal.aborted) {
          log.warn(`run ${claim.run.id}: lease lost; aborting local execution`);
          abort.abort();
        }
      })
      .catch((error) => log.warn(`run ${claim.run.id}: heartbeat failed`, error));
  }, heartbeatIntervalMs);
  heartbeat.unref?.();
  try {
    return await executeGenerationRun(claim, { services, signal: abort.signal });
  } finally {
    clearInterval(heartbeat);
  }
}

export function startGenerationRunner(
  options: GenerationRunnerOptions = {},
): GenerationRunnerHandle {
  const workerId = options.workerId ?? `${process.pid}:${randomUUID()}`;
  const services = options.services ?? defaultRunStepServices;
  const running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  let stopping = false;
  let scanning = false;
  let rescan = false;

  const scan = async (): Promise<void> => {
    if (stopping) return;
    if (scanning) {
      rescan = true;
      return;
    }
    scanning = true;
    try {
      do {
        rescan = false;
        const config = { ...generationRunConfig(), ...options.config };
        while (running.size < config.maxConcurrent && !stopping) {
          const claim = await claimNextGenerationRun(workerId, {
            leaseTtlMs: config.leaseTtlMs,
            maxTakeovers: config.maxTakeovers,
          });
          if (!claim) break;
          if (stopping || running.has(claim.run.id)) {
            // Stopping, or this process still executes the run under a lease
            // that went stale (its heartbeat stalled) and the claim just took
            // it over: hand the claim back. The stale execution is fenced and
            // stops at its next commit; the next scan claims the run afresh.
            running.get(claim.run.id)?.abort.abort();
            await releaseGenerationRunLease(claim.lease).catch(() => undefined);
            // Not again in this scan: the stale execution settles first.
            break;
          }
          log.info(
            `claimed ${claim.run.id} (generation ${claim.lease.generation}${claim.takeover ? ', takeover' : ''})`,
          );
          const abort = new AbortController();
          const done = runClaimedGenerationRun(claim, services, abort, config.heartbeatIntervalMs)
            .then(async (outcome) => {
              log.info(`run ${claim.run.id}: ${outcome}`);
              if (outcome === 'interrupted' && stopping) {
                // A clean park: the next claim resumes from the last checkpoint.
                await releaseGenerationRunLease(claim.lease).catch(() => undefined);
              }
            })
            .catch((error) => {
              log.error(`run ${claim.run.id} crashed`, error);
            })
            .finally(() => {
              running.delete(claim.run.id);
              if (!stopping) void scan();
            });
          running.set(claim.run.id, { abort, done });
        }
      } while (rescan && !stopping);
    } catch (error) {
      log.error('claim scan failed', error);
    } finally {
      scanning = false;
    }
  };

  const config = { ...generationRunConfig(), ...options.config };
  const timer = setInterval(() => void scan(), config.scanIntervalMs);
  timer.unref?.();
  void scan();
  log.info(
    `generation runner ${workerId} started (scan=${config.scanIntervalMs}ms, ` +
      `heartbeat=${config.heartbeatIntervalMs}ms, leaseTtl=${config.leaseTtlMs}ms, ` +
      `maxConcurrent=${config.maxConcurrent})`,
  );

  const handle: GenerationRunnerHandle = {
    workerId,
    wake: () => void scan(),
    async stop(stopOptions) {
      stopping = true;
      if (runnerState[RUNNER_KEY] === handle) delete runnerState[RUNNER_KEY];
      clearInterval(timer);
      for (const execution of running.values()) execution.abort.abort();
      const deadline = Date.now() + (stopOptions?.timeoutMs ?? 15_000);
      while (running.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (running.size > 0) {
        log.warn(`stop() timed out with ${running.size} run(s) still settling`);
      }
    },
  };
  runnerState[RUNNER_KEY] = handle;
  return handle;
}
