/**
 * Server-only configuration of generation runs. The lease timing is the agent
 * runtime's (one set of numbers for every lease-coordinated worker in a
 * process); the limits are the runs' own.
 */
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export interface GenerationRunConfig {
  scanIntervalMs: number;
  heartbeatIntervalMs: number;
  /** A lease with an older heartbeat is orphaned and taken over. */
  leaseTtlMs: number;
  /** Runs one process executes at once. */
  maxConcurrent: number;
  /**
   * Takeovers of one step in a row (its worker died each time) before the run
   * pauses there instead of being taken over again.
   */
  maxTakeovers: number;
  /**
   * Runs one owner may have in progress at once: any state but completed,
   * ended, or waiting for its outline to be confirmed (which holds no worker).
   */
  maxActiveRunsPerOwner: number;
  /** Runs one owner may have waiting for outline confirmation at once. */
  maxWaitingRunsPerOwner: number;
  /**
   * How long a finished run keeps its full log (checkpoints and every event)
   * before the sweep compacts it to what its final snapshot needs.
   */
  finishedRetentionMs: number;
  /** How often a process sweeps finished runs. */
  compactionIntervalMs: number;
}

/** Read on every call, so a test (or an operator restart) sees the environment as it is. */
export function generationRunConfig(): GenerationRunConfig {
  return {
    scanIntervalMs: agentRuntimeConfig.scanIntervalMs,
    heartbeatIntervalMs: agentRuntimeConfig.heartbeatIntervalMs,
    leaseTtlMs: agentRuntimeConfig.leaseTtlMs,
    maxConcurrent: positiveIntegerFromEnv('OPENMAIC_GENERATION_RUN_MAX_CONCURRENT', 4),
    maxTakeovers: agentRuntimeConfig.maxAttempts,
    maxActiveRunsPerOwner: positiveIntegerFromEnv('OPENMAIC_MAX_ACTIVE_RUNS_PER_OWNER', 2),
    maxWaitingRunsPerOwner: positiveIntegerFromEnv('OPENMAIC_MAX_WAITING_RUNS_PER_OWNER', 10),
    finishedRetentionMs:
      positiveIntegerFromEnv('OPENMAIC_GENERATION_RUN_RETENTION_HOURS', 24) * 60 * 60 * 1000,
    compactionIntervalMs: 60 * 60 * 1000,
  };
}
