import 'server-only';
import type { Queryable } from '@openmaic/storage/agent-session/pg';
import type { PersistedAgentSessionEvent } from '@openmaic/storage';

export const CONVERSATION_BYTES = 512 * 1024;

/** Page older history and bound tool data; keep the current assistant reply whole. */
export async function readConversationHistory(
  db: Queryable,
  sessionId: string,
  through: number,
  limit: number,
): Promise<PersistedAgentSessionEvent[]> {
  const result = await db.query<{
    id: number;
    ts: string | number;
    attempt: number;
    type: string;
    data: unknown;
  }>(
    `WITH boundary AS (
       SELECT COALESCE(max(seq),0) AS first FROM agent_session_events
       WHERE session_id=$1 AND seq<=$2 AND type='user_message'
     ), current_events AS (
       SELECT e.seq,e.attempt,e.type,sum(CASE WHEN type='message_start' THEN 1 ELSE 0 END)
         OVER (PARTITION BY attempt ORDER BY seq) AS message_group
       FROM agent_session_events e,boundary b
       WHERE e.session_id=$1 AND e.seq>=b.first AND e.seq<=$2
     ), latest_updates AS (
       SELECT DISTINCT ON (attempt,message_group) seq FROM current_events
       WHERE type='message_update' ORDER BY attempt,message_group,seq DESC
     ), recent AS (
       (SELECT e.* FROM agent_session_events e,boundary b
        WHERE e.session_id=$1 AND e.seq<b.first ORDER BY seq DESC LIMIT $3)
       UNION ALL
       SELECT e.* FROM agent_session_events e,boundary b
        WHERE e.session_id=$1 AND e.seq>=b.first AND e.seq<=$2
          AND (e.type<>'message_update' OR e.seq IN (SELECT seq FROM latest_updates))
     ), sized AS (
       SELECT e.*,octet_length(e.data::text) AS bytes,
         (e.seq>=b.first AND e.type IN ('message_start','message_update','message_end')
           AND e.data->'message'->>'role'='assistant') IS TRUE AS current_reply
       FROM recent e,boundary b,agent_sessions a
       WHERE a.id=e.session_id AND a.deleted_at IS NULL
     ), bounded AS (
       SELECT *,sum(CASE WHEN NOT current_reply AND bytes<=$4 THEN bytes ELSE 0 END)
         OVER (ORDER BY seq DESC) AS total FROM sized
     ) SELECT seq AS id,ts,attempt,type,
       CASE WHEN current_reply OR (bytes<=$4 AND total<=$4) THEN data ELSE jsonb_build_object(
         'pblContentOmitted',true,'toolName',left(data->>'toolName',100),
         'toolCallId',left(data->>'toolCallId',200),'isError',data->'isError',
         'status',data->'status','pblOpening',data->'pblOpening') END AS data
     FROM bounded ORDER BY seq`,
    [sessionId, through, limit, CONVERSATION_BYTES],
  );
  return result.rows.map((event) => ({ ...event, ts: Number(event.ts) }));
}
