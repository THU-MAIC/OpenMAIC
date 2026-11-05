import 'server-only';
import { LearningStore } from './store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { fenceOwnerWrite, forwardOwnerWrite } from '@/lib/persistence/owner-merges';
import { AGENT_EXECUTION_IDLE_TIMEOUT } from '@/lib/agent/runtime/request-failure';

export const PBL_EXECUTION_IDLE_MS = 15 * 60 * 1000;
export const PBL_EXECUTION_SCAN_MS = 30_000;
const LOCK_WAIT_MS = 250;
interface ScanPass {
  cutoff: string;
  after?: { at: string; id: string };
}
let scanPass: ScanPass | undefined;

export interface TeachingClaim {
  sessionId: string;
  ownerId: string;
  workerId: string;
  attempt: number;
}

/** Only execution feedback calls this. Claims, SSE, lease heartbeats and renewals do not. */
export async function recordTeachingProgress(claim: TeachingClaim): Promise<boolean> {
  const store = await LearningStore.open();
  return store.transaction(async (db) => {
    await db.query("SET LOCAL statement_timeout='5s'");
    const ownerId = await forwardOwnerWrite(db, claim.ownerId, LOCK_WAIT_MS);
    await db.query("SET LOCAL lock_timeout='250ms'");
    const held = await db.query(
      `SELECT id FROM agent_sessions WHERE id=$1 AND owner_id=$2 AND lease_worker_id=$3
       AND attempt=$4 AND status='running' AND cancel_requested_at IS NULL AND deleted_at IS NULL FOR SHARE`,
      [claim.sessionId, ownerId, claim.workerId, claim.attempt],
    );
    if (!held.rows.length) return false;
    const touched = await db.query(
      `UPDATE pbl_v3_roles SET execution_progress_at=clock_timestamp()
       WHERE session_id=$1 AND execution_progress_at>clock_timestamp()-$2::bigint*interval '1 millisecond'
       RETURNING session_id`,
      [claim.sessionId, PBL_EXECUTION_IDLE_MS],
    );
    if (!touched.rows.length) return false;
    // Extend an existing delegation only. Never recreate a revoked grant or revive a released binding.
    await db.query(
      `UPDATE sandbox_session_grants g SET expires_at=clock_timestamp()+interval '1 hour'
       FROM pbl_v3_roles r JOIN pbl_v3_studies s ON s.id=r.study_id
       JOIN sandbox_environments e ON e.id=s.environment_id
       WHERE g.session_id=$1 AND r.session_id=g.session_id AND g.owner_id=$2
         AND s.owner_id=g.owner_id AND e.owner_id=g.owner_id AND e.state='running'
         AND g.environment_id=s.environment_id
         AND s.archive_discard->>'environmentId' IS DISTINCT FROM s.environment_id
         AND s.idle_turn_cleanup->>'releasing' IS DISTINCT FROM 'true'`,
      [claim.sessionId, ownerId],
    );
    return true;
  });
}

/** Independent of runner admission and study/provider locks, so a hung tool cannot block it. */
export async function expireStalledTeachingTurns(): Promise<void> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const exists = await pool.query<{ ready: boolean }>(
    "SELECT to_regclass('pbl_v3_roles') IS NOT NULL AS ready",
  );
  if (!exists.rows[0]?.ready) return;
  const store = await LearningStore.open();
  const newPass = async (): Promise<ScanPass> => ({
    cutoff: (
      await pool.query<{ cutoff: string }>(
        "SELECT (clock_timestamp()-$1::bigint*interval '1 millisecond')::text AS cutoff",
        [PBL_EXECUTION_IDLE_MS],
      )
    ).rows[0]!.cutoff,
  });
  const batch = (pass: ScanPass) =>
    pool.query<{ id: string; owner_id: string; at: string }>(
      `SELECT a.id,a.owner_id,r.execution_progress_at::text AS at
     FROM pbl_v3_roles r JOIN agent_sessions a ON a.id=r.session_id
     WHERE a.status IN ('queued','running') AND a.deleted_at IS NULL
       AND r.execution_progress_at<=$1::timestamptz
       AND ($2::timestamptz IS NULL OR (r.execution_progress_at,a.id)>($2::timestamptz,$3::text))
     ORDER BY r.execution_progress_at,a.id LIMIT 100 FOR UPDATE OF a SKIP LOCKED`,
      [pass.cutoff, pass.after?.at ?? null, pass.after?.id ?? null],
    );
  let pass = (scanPass ??= await newPass());
  let candidates = await batch(pass);
  if (!candidates.rows.length && pass.after) {
    // Finish a bounded pass before admitting newly expired work, then revisit deferrals.
    pass = scanPass = await newPass();
    candidates = await batch(pass);
  }
  const last = candidates.rows.at(-1);
  if (last) pass.after = { at: last.at, id: last.id };
  else if (scanPass === pass) scanPass = undefined;
  for (const candidate of candidates.rows) {
    try {
      await store.transaction(async (db) => {
        await db.query("SET LOCAL statement_timeout='5s'");
        await fenceOwnerWrite(db, candidate.owner_id, undefined, LOCK_WAIT_MS);
        await db.query("SET LOCAL lock_timeout='250ms'");
        // Serialize against progress publication and claim/settlement. Never wait for a busy writer.
        const locked = await db.query<{ attempt: number; cancel_requested_at: unknown }>(
          `SELECT attempt,cancel_requested_at FROM agent_sessions
         WHERE id=$1 AND owner_id=$2 AND status IN ('queued','running') AND deleted_at IS NULL
         FOR UPDATE SKIP LOCKED`,
          [candidate.id, candidate.owner_id],
        );
        const session = locked.rows[0];
        if (!session) return;
        // A new statement observes the latest committed progress after acquiring the session lock.
        const stale = await db.query(
          `SELECT 1 FROM pbl_v3_roles WHERE session_id=$1
         AND execution_progress_at<=clock_timestamp()-$2::bigint*interval '1 millisecond'`,
          [candidate.id, PBL_EXECUTION_IDLE_MS],
        );
        if (!stale.rows.length) return;
        // A worker may have flushed its terminal event but lost the separate status write.
        // The admission marker excludes earlier turns even when attended retry resets attempt.
        const terminal = (
          await db.query<{ data: { status?: string; error?: string } }>(
            `SELECT data FROM agent_session_events WHERE session_id=$1 AND attempt=$2 AND type='session_end'
           AND seq>COALESCE((SELECT max(seq) FROM agent_session_events WHERE session_id=$1
             AND type IN ('user_message','pbl_turn_retried')),0)
           ORDER BY seq DESC LIMIT 1`,
            [candidate.id, session.attempt],
          )
        ).rows[0]?.data;
        const terminalStatus = terminal?.status;
        const recorded =
          terminalStatus === 'succeeded' ||
          terminalStatus === 'failed' ||
          terminalStatus === 'cancelled';
        const status = recorded
          ? terminalStatus
          : session.cancel_requested_at == null
            ? 'failed'
            : 'cancelled';
        const error = recorded
          ? typeof terminal?.error === 'string'
            ? terminal.error.replaceAll('\0', '')
            : 'Teaching execution failed.'
          : `[${AGENT_EXECUTION_IDLE_TIMEOUT}] No execution progress for 15 minutes. Retry to continue.`;
        await db.query(
          `UPDATE agent_sessions SET status=$2,error=$3,lease_worker_id=NULL,lease_worker_pid=NULL,
         lease_heartbeat_at=NULL,cancel_requested_at=NULL,updated_at=clock_timestamp() WHERE id=$1`,
          [candidate.id, status, status === 'failed' ? error : null],
        );
        await db.query('DELETE FROM sandbox_session_grants WHERE session_id=$1', [candidate.id]);
        const agents = store.agentStore(db);
        await agents.append(
          {
            type: 'session_status',
            sessionId: candidate.id,
            ts: Date.now(),
            status,
            attempt: session.attempt,
          },
          db,
        );
        if (!recorded)
          await agents.appendControlEvent(candidate.id, {
            ts: Date.now(),
            type: 'session_end',
            data: {
              status,
              ...(status === 'failed' ? { error, errorCode: AGENT_EXECUTION_IDLE_TIMEOUT } : {}),
            },
          });
      });
    } catch {
      console.warn('[pbl-execution] Session verdict deferred; retrying.');
    }
  }
}

const KEY = Symbol.for('openmaic.pbl-execution-watchdog');
interface Schedule {
  stop(): Promise<void>;
  runNow(): Promise<void>;
}
const state = globalThis as typeof globalThis & { [key: symbol]: Schedule | undefined };

/** Runs even when Agent workers are disabled or all their slots are occupied. */
export function startTeachingExecutionWatchdog(
  run = expireStalledTeachingTurns,
): Schedule | undefined {
  if (state[KEY]) return state[KEY];
  if (!process.env.DATABASE_URL) return;
  let stopped = false,
    pending: Promise<void> | undefined;
  const runNow = async () => {
    if (stopped || pending) return;
    pending = run().catch(() => console.warn('[pbl-execution] Watchdog unavailable; retrying.'));
    try {
      await pending;
    } finally {
      pending = undefined;
    }
  };
  const timer = setInterval(() => void runNow(), PBL_EXECUTION_SCAN_MS);
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
