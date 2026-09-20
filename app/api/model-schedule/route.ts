import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@/lib/logger';

const log = createLogger('Model Schedule API');

export const dynamic = 'force-dynamic';

function schedulePath() {
  return process.env.OPENMAIC_MODEL_SCHEDULE
    ? process.env.OPENMAIC_MODEL_SCHEDULE
    : join(process.cwd(), 'data', 'model-schedule.json');
}

function eventsPath() {
  return join(process.cwd(), 'data', 'schedule-events.jsonl');
}

/**
 * GET /api/model-schedule
 * Returns the current schedule config (null when unconfigured) plus the most
 * recent escalation/suggestion events. The engine hot-reads the file per call,
 * so a PUT takes effect immediately without a server restart.
 */
export async function GET() {
  let config: unknown = null;
  try {
    config = JSON.parse(await readFile(schedulePath(), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('model-schedule.json read failed:', error);
    }
  }
  let events: unknown[] = [];
  try {
    const lines = (await readFile(eventsPath(), 'utf8')).split('\n').filter(Boolean);
    events = lines
      .slice(-20)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })
      .filter((e) => e !== null)
      .reverse();
  } catch {
    // No ledger yet — empty list is fine.
  }
  return NextResponse.json({ config, events });
}

/**
 * DELETE /api/model-schedule
 * Removes the schedule file so the engine falls back to the original
 * (no-escalation) behavior. Mirrors the GET null-config state.
 */
export async function DELETE() {
  try {
    await rm(schedulePath(), { force: true });
    log.info('model-schedule.json removed (escalation disabled)');
    return NextResponse.json({ ok: true });
  } catch (error) {
    log.warn('model-schedule.json delete failed:', error);
    return NextResponse.json({ ok: false, error: 'delete-failed' }, { status: 500 });
  }
}

/**
 * PUT /api/model-schedule
 * Validates and persists the schedule config JSON. The engine picks the new
 * policy up on its next per-call read (250ms cache); no rebuild required.
 */
export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid-json' }, { status: 400 });
  }
  const config = body as {
    models?: Record<string, unknown>;
    budget?: Record<string, unknown>;
    escalation?: Record<string, unknown>;
    strictMode?: unknown;
  };
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return NextResponse.json({ ok: false, error: 'expected-object' }, { status: 400 });
  }
  if (config.escalation && typeof config.escalation !== 'object') {
    return NextResponse.json({ ok: false, error: 'escalation-object' }, { status: 400 });
  }
  if (config.budget && typeof config.budget !== 'object') {
    return NextResponse.json({ ok: false, error: 'budget-object' }, { status: 400 });
  }
  try {
    await mkdir(join(process.cwd(), 'data'), { recursive: true });
    await writeFile(schedulePath(), JSON.stringify(config, null, 2) + '\n', 'utf8');
    log.info('model-schedule.json saved (hot-reload effective)');
    return NextResponse.json({ ok: true });
  } catch (error) {
    log.warn('model-schedule.json write failed:', error);
    return NextResponse.json({ ok: false, error: 'write-failed' }, { status: 500 });
  }
}
