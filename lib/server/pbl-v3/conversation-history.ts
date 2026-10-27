import 'server-only';
import type { Queryable } from '@openmaic/storage/agent-session/pg';
import type { PersistedAgentSessionEvent } from '@openmaic/storage';

export const CONVERSATION_BYTES = 512 * 1024;

// Local empty stops and tool-call-only frames have no learner-visible model content.
const visibleContent = (alias: string) => `${alias}.data->'message'->'content' @?
  '$[*] ? ((@.type == "text" && @.text != "") || (@.type == "thinking" && @.thinking != ""))'`;

// Compact snapshots before pagination, against a fixed high-water mark. Applying
// the cursor first would replay older snapshots of the same message on each page.
const historyWindow = (live = false) => `WITH boundary AS (
  SELECT COALESCE((SELECT seq FROM agent_session_events
    WHERE session_id=$1 AND seq<=$2 AND type='user_message' ORDER BY seq DESC LIMIT 1),0) AS first
), framed AS (
  SELECT e.seq,e.attempt,e.type,
    GREATEST(
      COALESCE(max(e.seq) FILTER (WHERE e.type='message_start') OVER (
        PARTITION BY e.attempt ORDER BY e.seq),0),
      COALESCE(max(e.seq+1) FILTER (WHERE e.type='message_end') OVER (
        PARTITION BY e.attempt ORDER BY e.seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)
    ) AS message_id
  FROM agent_session_events e JOIN agent_sessions a ON a.id=e.session_id
  ${live ? 'CROSS JOIN boundary b' : ''}
  WHERE e.session_id=$1 AND e.seq<=$2 AND a.deleted_at IS NULL
  ${
    live
      ? `AND (e.seq>=b.first OR e.seq IN (SELECT seq FROM agent_session_events
    WHERE session_id=$1 AND seq<b.first ORDER BY seq DESC LIMIT $3))`
      : ''
  }
), snapshots AS (
  SELECT DISTINCT ON (attempt,message_id) seq FROM framed
  WHERE type IN ('message_start','message_update','message_end')
  ORDER BY attempt,message_id,seq DESC
), recent AS (
  SELECT f.* FROM framed f WHERE ($5::bigint IS NULL OR f.seq<$5)
    AND (f.type NOT IN ('message_start','message_update','message_end')
      OR f.seq IN (SELECT seq FROM snapshots))
  ORDER BY f.seq DESC LIMIT $3
), sized AS (
  SELECT r.*,e.ts,e.data,octet_length(e.data::text) AS bytes,
    (e.data->'message'->>'role'='assistant' AND ${visibleContent('e')}) AS assistant
  FROM ${
    live
      ? `(SELECT * FROM recent UNION SELECT * FROM framed
    WHERE seq=(SELECT max(seq) FROM framed WHERE type='user_message')
    OR ($6::boolean AND seq=(SELECT e.seq FROM agent_session_events e
      WHERE e.session_id=$1 AND e.seq<=$2
        AND e.type IN ('message_start','message_update','message_end')
        AND e.data->'message'->>'role'='assistant' AND ${visibleContent('e')}
        ORDER BY e.seq DESC LIMIT 1)))`
      : 'recent'
  } r JOIN agent_session_events e ON e.session_id=$1 AND e.seq=r.seq
)`;

type EventRow = {
  id: number;
  ts: string | number;
  attempt: number;
  type: string;
  data: unknown;
};
const eventsFrom = (rows: EventRow[]): PersistedAgentSessionEvent[] =>
  rows.map((event) => ({ ...event, ts: Number(event.ts) }));

/** Bound every earlier message and event; only the newest assistant snapshot is exempt. */
export async function readConversationHistory(
  db: Queryable,
  sessionId: string,
  through: number,
  limit: number,
  preserveLatest = true,
): Promise<PersistedAgentSessionEvent[]> {
  const result = await db.query<EventRow>(
    `${historyWindow(true)}, protected AS (
       SELECT *,COALESCE(seq=(SELECT max(seq) FROM sized WHERE assistant),false)
         AND $6::boolean AND seq>COALESCE((SELECT max(seq) FROM framed WHERE type='user_message'),0)
         AS current_reply FROM sized
     ), bounded AS (
       SELECT *,sum(CASE WHEN NOT current_reply AND bytes<=$4 THEN bytes ELSE 0 END)
         OVER (ORDER BY seq DESC) AS total FROM protected
     ) SELECT seq AS id,ts,attempt,type,
       (CASE WHEN current_reply OR (bytes<=$4 AND total<=$4) THEN data ELSE jsonb_build_object(
         'pblContentOmitted',true,'toolName',left(data->>'toolName',100),
         'toolCallId',left(data->>'toolCallId',200),'isError',data->'isError',
         'status',data->'status','pblOpening',data->'pblOpening') END)
       || jsonb_build_object('pblMessageId',CASE WHEN assistant THEN message_id ELSE NULL END,
         'pblHistoryBefore',seq=(SELECT min(seq) FROM sized)
           AND EXISTS(SELECT 1 FROM agent_session_events
             WHERE session_id=$1 AND seq<(SELECT min(seq) FROM recent))) AS data
     FROM bounded ORDER BY seq`,
    [sessionId, through, limit, CONVERSATION_BYTES, null, preserveLatest],
  );
  return eventsFrom(result.rows);
}

/** Explicit history reads return whole records, one oversized record at a time if necessary. */
export async function readConversationPage(
  db: Queryable,
  sessionId: string,
  through: number,
  before: number | null,
) {
  const limit = 80;
  const result = await db.query<EventRow & { next_before: number | null }>(
    `${historyWindow()}, budgeted AS (
       SELECT *,row_number() OVER (ORDER BY seq DESC) AS n,
         sum(bytes) OVER (ORDER BY seq DESC) AS total FROM sized
     ), selected AS (
       SELECT * FROM budgeted WHERE n<=$6 AND (n=1 OR total<=$4)
     ) SELECT seq AS id,ts,attempt,type,
       data || jsonb_build_object('pblMessageId',CASE WHEN assistant THEN message_id ELSE NULL END) AS data,
       CASE WHEN EXISTS(SELECT 1 FROM budgeted WHERE seq<(SELECT min(seq) FROM selected))
         THEN (SELECT min(seq) FROM selected) ELSE NULL END AS next_before
     FROM selected ORDER BY seq`,
    [sessionId, through, limit + 1, CONVERSATION_BYTES, before, limit],
  );
  return {
    events: eventsFrom(result.rows.map(({ next_before: _cursor, ...event }) => event)),
    nextBefore: result.rows[0]?.next_before == null ? null : Number(result.rows[0].next_before),
  };
}
