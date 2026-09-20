/**
 * Model schedule & complexity escalation config.
 *
 * Reads data/model-schedule.json (hot-reload per call) and exposes:
 *  - getEscalationFor(stage): per-stage auto-switch policy
 *  - appendScheduleEvent(evt): durable suggestion/decision ledger
 *  - isEscalationBudgetExhausted(): daily cap guard
 *
 * Missing/invalid config → null policy (original upstream behavior, zero impact).
 * This file lives in lib/server — Node-only, safe to use node:fs directly.
 */

import { readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@/lib/logger';

const log = createLogger('Model Schedule');

export interface EscalationPolicy {
  base?: string;
  escalateTo: string;
  trigger: 'onTimeout' | 'onRetryableError';
  max: number;
}

export interface ModelScheduleConfig {
  models?: Record<string, { tier?: 'cheap' | 'standard' | 'premium'; label?: string }>;
  budget?: { monthlyCapCny?: number; hardLock?: boolean; dailyEscalationCap?: number };
  escalation?: Record<string, EscalationPolicy>;
  strictMode?: boolean;
}

let cached: ModelScheduleConfig | null | undefined;
let lastTry = 0;

function schedulePath(): string {
  return process.env.OPENMAIC_MODEL_SCHEDULE
    ? process.env.OPENMAIC_MODEL_SCHEDULE
    : join(process.cwd(), 'data', 'model-schedule.json');
}

/** Hot-read the schedule file; null on missing/invalid (never throws). */
export async function loadModelSchedule(): Promise<ModelScheduleConfig | null> {
  const now = Date.now();
  // 250ms read cache — panel edits take effect on the next call after it expires.
  if (cached !== undefined && lastTry > now - 250) return cached;
  lastTry = now;
  try {
    const raw = await readFile(schedulePath(), 'utf8');
    const parsed = JSON.parse(raw) as ModelScheduleConfig;
    cached = parsed;
    return parsed;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`model-schedule.json could not be parsed (ignored, original behavior):`, error);
    }
    cached = null;
    return null;
  }
}

/** Escalation policy for a stage (e.g. 'scene-content:interactive'), or null. */
export async function getEscalationFor(stage: string): Promise<EscalationPolicy | null> {
  const schedule = await loadModelSchedule();
  if (!schedule?.escalation) return null;
  const policy = schedule.escalation[stage];
  if (!policy || !policy.escalateTo) return null;
  if (policy.max < 1) return null;
  return policy;
}

/** Daily escalation cap from budget config; null = unlimited. */
export async function isEscalationBudgetExhausted(): Promise<boolean> {
  const schedule = await loadModelSchedule();
  const cap = schedule?.budget?.dailyEscalationCap;
  if (!cap || cap < 1) return false;
  const today = new Date().toISOString().slice(0, 10);
  const count = await countScheduleEvents(
    (e) => (e.ts as string | undefined)?.startsWith(today) === true && e.kind === 'escalation',
  );
  return count >= cap;
}

/** Append one line to data/schedule-events.jsonl (fire-and-forget, never throws). */
export async function appendScheduleEvent(event: {
  ts: string;
  kind: 'escalation' | 'suggestion' | 'decision';
  stage: string;
  scene?: string;
  base?: string;
  used?: string;
  errorClass?: string;
  reason?: string;
  costEstCny?: number;
}): Promise<void> {
  try {
    await appendFile(
      join(process.cwd(), 'data', 'schedule-events.jsonl'),
      JSON.stringify(event) + '\n',
      'utf8',
    );
  } catch (error: unknown) {
    log.warn('schedule-events append failed (ignored):', error);
  }
}

async function countScheduleEvents(
  predicate: (e: Record<string, unknown>) => boolean,
): Promise<number> {
  try {
    const raw = await readFile(join(process.cwd(), 'data', 'schedule-events.jsonl'), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null && predicate(e)).length;
  } catch {
    return 0;
  }
}
