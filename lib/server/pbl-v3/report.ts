import 'server-only';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { sandboxConflict } from '@/lib/sandbox/errors';
import { analyzeLearningReport } from './report-analysis';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
import type { OrchestrationEvent } from '@/lib/pbl/v3/domain/orchestration/events';
import type { LearningReport } from '@/lib/pbl/v3/report';
import { handoffEchoes } from '@/lib/pbl/v3/conversation';
import { LearningStore, type Study, type RoleBinding } from './store';
import { projectFor } from './runtime';
import { reviewQuestions } from './review-question';
import { canViewProjectReport } from './stage-progress';

const HISTORY_LIMIT = 1000;
const RECORD_BYTES = 32768;
const TEXT_LIMIT = 240000;
const DETAIL_LIMIT = 12000;

/** Bounded presentation of durable evidence; the underlying append-only history is retained. */
async function buildLearningEvidence(db: PoolClient, row: Study): Promise<LearningReport> {
  const id = row.id;
  const project = projectFor(row);
  let truncated = false;
  let remaining = TEXT_LIMIT / 3;
  const boundedText = (text: string) => {
    const clipped = text.slice(0, Math.min(DETAIL_LIMIT, remaining));
    remaining -= clipped.length;
    if (clipped.length < text.length) truncated = true;
    return clipped;
  };
  const evidence: LearningReport['evidence'] = [];
  const records = await db.query<{
    sequence: number;
    at: number;
    event: OrchestrationEvent | null;
  }>(
    `SELECT sequence,(extract(epoch FROM recorded_at)*1000)::float8 AS at,
       CASE WHEN octet_length(event::text)<=$4 THEN event END AS event
     FROM pbl_v3_events WHERE study_id=$1 AND sequence<=$2 ORDER BY sequence DESC LIMIT $3`,
    [id, row.state.lastSequence, HISTORY_LIMIT + 1, RECORD_BYTES],
  );
  if (records.rows.length > HISTORY_LIMIT) truncated = true;
  const versions = new Map<string, string>();
  for (const { event } of records.rows.slice(0, HISTORY_LIMIT).toReversed()) {
    const hash =
      event?.type === 'artifact.recorded'
        ? event.artifact.workspaceRevisionId
        : event?.type === 'evaluation.recorded'
          ? event.evaluation.revision.id
          : undefined;
    if (hash && !versions.has(hash)) versions.set(hash, `v${versions.size + 1}`);
  }
  const versionLabel = (hash: string) => versions.get(hash);
  for (const { sequence, at, event } of records.rows.slice(0, HISTORY_LIMIT)) {
    if (!event) {
      truncated = true;
      continue;
    }
    let detail: string | undefined, version: string | undefined;
    let milestoneId = 'milestoneId' in event ? event.milestoneId : undefined;
    switch (event.type) {
      case 'decision.recorded': {
        const d = project.definition.decisions.find((d) => d.id === event.decisionId);
        detail = `${d?.decisionPrompt ?? event.decisionId}: ${d?.options.find((o) => o.id === event.chosen)?.label ?? event.chosen ?? ''}`;
        if (event.rationale) detail += `\nRationale: ${event.rationale}`;
        break;
      }
      case 'artifact.recorded':
        milestoneId = event.artifact.milestoneId;
        detail =
          event.artifact.kind === 'plan'
            ? (event.content ?? '')
            : (event.changedPaths?.join('\n') ?? event.artifact.value);
        version = event.artifact.workspaceRevisionId
          ? versionLabel(event.artifact.workspaceRevisionId)
          : undefined;
        break;
      case 'evaluation.recorded':
        milestoneId = event.evaluation.milestoneId;
        detail = `${event.evaluation.status}\n${event.evaluation.publicFeedback ?? ''}`;
        version = versionLabel(event.evaluation.revision.id);
        break;
      case 'quiz.recorded':
        detail = `${event.quiz.score}/${event.quiz.total} · attempt ${event.quiz.attempt}`;
        break;
      case 'milestone.completed':
        detail =
          project.definition.milestones.find((m) => m.id === event.milestoneId)?.title ??
          event.milestoneId;
        break;
      case 'recap.completed':
      case 'teaching.completed':
      case 'artifact.review.completed':
        detail = event.type;
        break;
    }
    if (detail !== undefined) {
      const text = boundedText(detail);
      if (!text && detail) continue;
      evidence.push({
        sequence,
        at,
        milestoneId,
        kind: event.type,
        detail: text,
        ...(text.length < detail.length ||
        (detail.length >= 12000 &&
          event.type === 'artifact.recorded' &&
          event.content?.endsWith('…（后略）'))
          ? { truncated: true }
          : {}),
        ...(version ? { version } : {}),
      });
    }
  }
  evidence.reverse();
  const counts = Object.fromEntries(
    (
      await db.query<{ kind: string; count: number }>(
        "SELECT event->>'type' AS kind,count(*)::int AS count FROM pbl_v3_events WHERE study_id=$1 AND sequence<=$2 GROUP BY event->>'type'",
        [id, row.state.lastSequence],
      )
    ).rows.map((r) => [r.kind, r.count]),
  );
  const conversations: LearningReport['conversations'] = [];
  remaining = TEXT_LIMIT / 3;
  const bindings = await db.query<
    RoleBinding & { available: boolean; last: number; omitted: boolean }
  >(
    `SELECT r.session_id,r.role,r.context_key,r.stage_key,
       CASE WHEN octet_length(r.guided::text)<=$3 THEN r.guided END AS guided,
       COALESCE(octet_length(r.guided::text)>$3,false) AS omitted,
       a.id IS NOT NULL AND a.deleted_at IS NULL AS available,
       COALESCE((SELECT max(seq) FROM agent_session_events WHERE session_id=r.session_id),0) AS last
     FROM pbl_v3_roles r LEFT JOIN agent_sessions a ON a.id=r.session_id
     WHERE r.study_id=$1 ORDER BY a.updated_at DESC NULLS LAST,r.session_id LIMIT $2`,
    [id, HISTORY_LIMIT + 1, RECORD_BYTES],
  );
  if (bindings.rows.length > HISTORY_LIMIT) truncated = true;
  let eventsRemaining = HISTORY_LIMIT;
  for (const binding of bindings.rows.slice(0, HISTORY_LIMIT)) {
    if (binding.omitted) truncated = true;
    if (!binding.available) {
      truncated = true;
      continue;
    }
    const entries = await db.query<{ id: number; at: number; type: string; data: unknown }>(
      `SELECT e.seq AS id,e.ts::float8 AS at,e.type,
         CASE WHEN octet_length(e.data::text)<=$4 THEN e.data || jsonb_build_object(
           'pblInputId',(SELECT input.seq FROM agent_session_events input
             WHERE input.session_id=e.session_id AND input.seq<=e.seq AND input.type='user_message'
             ORDER BY input.seq DESC LIMIT 1)) END AS data
       FROM agent_session_events e WHERE e.session_id=$1 AND e.seq<=$2
         AND (type IN ('user_message','message_end','pbl_learner_handoff')
           OR (type='tool_execution_end' AND data->>'toolName' IN
             ('request_skill_review','request_learner_help','respond_to_learner')))
       ORDER BY e.seq DESC LIMIT $3`,
      [binding.session_id, binding.last, eventsRemaining + 1, RECORD_BYTES],
    );
    let conversationTruncated = entries.rows.length > eventsRemaining;
    const selected = entries.rows.slice(0, eventsRemaining);
    eventsRemaining -= selected.length;
    const messages: Array<
      LearningReport['conversations'][number]['messages'][number] & {
        scope: string;
        inputId?: number;
        messageId?: number;
        handoff: boolean;
      }
    > = [];
    const pushMessage = (
      sequence: number,
      at: number,
      role: 'user' | 'assistant',
      text: string,
      source: { inputId?: number; messageId?: number; handoff?: boolean } = {},
    ) => {
      if (text)
        messages.push({
          sequence,
          at,
          role,
          text,
          scope: binding.session_id,
          handoff: source.handoff === true,
          inputId: source.inputId,
          messageId: source.messageId,
        });
    };
    let latestInputSequence: number | undefined;
    let latestInputAt = 0;
    const questions = reviewQuestions(selected);
    for (const entry of selected) {
      if (!entry.data) {
        conversationTruncated = true;
        continue;
      }
      const data = entry.data as {
        text?: string;
        pblOpening?: boolean;
        pblInputId?: number;
        message?: { role?: string; content?: { type: string; text?: string }[] };
      };
      const inputId =
        typeof data.pblInputId === 'number' && Number.isSafeInteger(data.pblInputId)
          ? data.pblInputId
          : undefined;
      const question = questions.get(entry.id);
      if (question !== undefined)
        pushMessage(entry.id, entry.at, 'assistant', question, { inputId, handoff: true });
      if (entry.type === 'user_message') {
        // Review recovery follows the actual queued input, including automatic
        // openings. Only real learner messages belong in the visible transcript.
        if (latestInputSequence === undefined || entry.id > latestInputSequence) {
          latestInputSequence = entry.id;
          latestInputAt = entry.at;
        }
        if (!data.pblOpening && typeof data.text === 'string')
          pushMessage(entry.id, entry.at, 'user', data.text);
      }
      if (
        entry.type === 'message_end' &&
        data.message?.role === 'assistant' &&
        Array.isArray(data.message.content)
      ) {
        const text = data.message.content
          .filter((p) => p.type === 'text')
          .map((p) => p.text ?? '')
          .join('\n');
        if (text)
          pushMessage(entry.id, entry.at, 'assistant', text, { inputId, messageId: entry.id });
      }
    }
    for (const pending of [binding.guided?.pending, binding.guided?.handoff]) {
      if (
        latestInputSequence !== undefined &&
        pending?.runId === `${binding.stage_key}:${latestInputSequence}` &&
        !messages.some(
          (m) =>
            m.sequence > latestInputSequence &&
            m.role === 'assistant' &&
            m.text === pending.question,
        )
      )
        pushMessage(
          binding.last + 1,
          selected[0]?.at ?? latestInputAt,
          'assistant',
          pending.question,
          { inputId: latestInputSequence, handoff: true },
        );
    }
    const duplicates = handoffEchoes(messages);
    conversations.push({
      role: binding.role,
      milestone: binding.context_key,
      messages: messages
        .filter((message) => !duplicates.has(message))
        .flatMap((message) => {
          const text = boundedText(message.text);
          if (text.length < message.text.length) conversationTruncated = true;
          return text
            ? [{ sequence: message.sequence, at: message.at, role: message.role, text }]
            : [];
        })
        .sort((a, b) => a.sequence - b.sequence),
      truncated: conversationTruncated,
    });
  }
  remaining = TEXT_LIMIT / 3;
  const saved = await db.query<{
    id: string;
    at: number;
    milestone_id: string;
    kind: string;
    actor: string;
    detail: Record<string, unknown> | null;
  }>(
    `SELECT id,(extract(epoch FROM created_at)*1000)::float8 AS at,milestone_id,kind,actor,
       CASE WHEN octet_length(detail::text)<=$3 THEN detail END AS detail
     FROM pbl_v3_evidence WHERE study_id=$1 ORDER BY id DESC LIMIT $2`,
    [id, HISTORY_LIMIT + 1, RECORD_BYTES],
  );
  if (saved.rows.length > HISTORY_LIMIT) truncated = true;
  const savedEvidence: LearningReport['evidence'] = [];
  for (const item of saved.rows.slice(0, HISTORY_LIMIT)) {
    if (!item.detail) {
      truncated = true;
      continue;
    }
    const detail = JSON.stringify(
      {
        actor: item.actor,
        ...Object.fromEntries(
          Object.entries(item.detail).filter(
            ([key]) => !['fingerprint', 'previousHash', 'expectedHash', 'requestId'].includes(key),
          ),
        ),
      },
      null,
      2,
    );
    const text = boundedText(detail);
    if (!text && detail) continue;
    savedEvidence.push({
      sequence: -Number(item.id),
      at: item.at,
      milestoneId: item.milestone_id,
      kind: item.kind,
      detail: text,
      ...(text.length < detail.length ? { truncated: true } : {}),
      ...(typeof item.detail.fingerprint === 'string' && versions.has(item.detail.fingerprint)
        ? { version: versionLabel(item.detail.fingerprint) }
        : {}),
    });
  }
  evidence.push(...savedEvidence.reverse());
  evidence.sort((a, b) => a.at - b.at);
  conversations.sort((a, b) => (a.messages[0]?.at ?? Infinity) - (b.messages[0]?.at ?? Infinity));
  const decisions = (
    await db.query<{ decisions: number; changes: number }>(
      `WITH choices AS (
       SELECT event->>'milestoneId' AS milestone,event->>'decisionId' AS decision,
         jsonb_build_array(event->>'chosen',event->>'rationale') AS chosen,
         row_number() OVER w AS n,lag(jsonb_build_array(event->>'chosen',event->>'rationale')) OVER w AS previous
       FROM pbl_v3_events WHERE study_id=$1 AND sequence<=$2 AND event->>'type'='decision.recorded'
       WINDOW w AS (PARTITION BY event->>'milestoneId',event->>'decisionId' ORDER BY sequence)
     ) SELECT count(DISTINCT (milestone,decision))::int AS decisions,
       count(*) FILTER (WHERE n>1 AND chosen IS DISTINCT FROM previous)::int AS changes FROM choices`,
      [id, row.state.lastSequence],
    )
  ).rows[0]!;
  const totals = (
    await db.query<{
      learner: number;
      assistant: number;
      interrupted: number;
      edits: number;
    }>(
      `SELECT
       count(*) FILTER (WHERE e.type='user_message' AND jsonb_typeof(e.data->'text')='string'
         AND COALESCE(e.data->>'pblOpening','false')<>'true')::int AS learner,
       count(*) FILTER (WHERE e.type='message_end' AND e.data#>>'{message,role}'='assistant'
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE
           WHEN jsonb_typeof(e.data#>'{message,content}')='array' THEN e.data#>'{message,content}' ELSE '[]'::jsonb END) p
           WHERE p->>'type'='text' AND COALESCE(p->>'text','')<>''))::int AS assistant,
       count(*) FILTER (WHERE e.type='session_interrupted' OR
         (e.type='session_end' AND e.data->>'status'='failed'))::int AS interrupted,
       (SELECT count(*)::int FROM pbl_v3_evidence WHERE study_id=$1 AND kind='file-edit') AS edits
     FROM pbl_v3_roles r JOIN agent_sessions a ON a.id=r.session_id AND a.deleted_at IS NULL
       JOIN agent_session_events e ON e.session_id=r.session_id WHERE r.study_id=$1`,
      [id],
    )
  ).rows[0]!;
  return {
    facts: {
      learnerTurns: totals.learner,
      assistantTurns: totals.assistant,
      decisions: decisions.decisions,
      decisionChanges: decisions.changes,
      testRuns: counts['evaluation.recorded'] ?? 0,
      quizAttempts: counts['quiz.recorded'] ?? 0,
      fileEdits: totals.edits,
      interruptedRuns: totals.interrupted,
    },
    studyId: id,
    project: { id: project.ref.id, version: project.ref.version, title: project.definition.title },
    revision: row.revision,
    requiredComplete: canViewProjectReport(row.state),
    milestones: project.definition.milestones.map((m, i) => ({
      id: m.id,
      title: m.title,
      optional: !!m.optional,
      status: row.state.milestones[i]?.status ?? 'pending',
      stages: m.stages.map((s) =>
        s.kind === 'check' ? s.checker : s.kind === 'produce' ? s.writes : s.kind,
      ),
    })),
    outcomes: project.definition.milestones.map((m) => {
      const collected = row.state.collected[m.id];
      return {
        milestoneId: m.id,
        tests: collected?.tests?.status ?? null,
        quiz: collected?.quiz
          ? {
              score: collected.quiz.score,
              total: collected.quiz.total,
              attempt: collected.quiz.attempt,
            }
          : null,
        reflected: collected?.recapCompleted === true,
      };
    }),
    evidence,
    counts,
    conversations,
    truncated:
      truncated ||
      conversations.some((c) => c.truncated) ||
      evidence.some((e) => e.truncated === true),
  };
}

/** A short read-only snapshot keeps counts and excerpts consistent; completed projects are immutable. */
async function readReport(principal: OwnerPrincipal, id: string, evidenceOnly = false) {
  const store = await LearningStore.open();
  const db = await store.pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await readReportSnapshot(store, db, principal, id, evidenceOnly);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

async function readReportSnapshot(
  store: LearningStore,
  db: PoolClient,
  principal: OwnerPrincipal,
  id: string,
  evidenceOnly: boolean,
) {
  const row = await store.get(id, principal.ownerId, db);
  if (!evidenceOnly && !canViewProjectReport(row.state))
    throw sandboxConflict(
      'Complete the final project reflection before viewing the report.',
      'WORKBENCH_ACCESS_DENIED',
    );
  const completionRevision = row.revision;
  if (evidenceOnly) return { report: await buildLearningEvidence(db, row), completionRevision };
  const active = await db.query(
    `SELECT 1 FROM pbl_v3_roles r JOIN agent_sessions a ON a.id=r.session_id
     WHERE r.study_id=$1 AND a.deleted_at IS NULL AND a.status IN ('queued','running') LIMIT 1`,
    [id],
  );
  if (active.rows.length)
    throw sandboxConflict(
      'Wait for the final teaching response to finish before generating the report.',
      'PBL_REPORT_PENDING',
    );
  const saved = (
    await db.query<{ status: string; document: LearningReport | null; updated_at: Date }>(
      'SELECT status,document,updated_at FROM pbl_v3_reports WHERE study_id=$1 AND completion_revision=$2',
      [id, completionRevision],
    )
  ).rows[0];
  if (saved?.status === 'ready' && saved.document)
    return { report: saved.document, completionRevision };
  const evidence = await buildLearningEvidence(db, row);
  const stale = !!saved && Date.now() - saved.updated_at.getTime() > 120000;
  const report: LearningReport = {
    ...evidence,
    analysis: {
      status: stale
        ? 'failed'
        : saved?.status === 'generating'
          ? 'generating'
          : saved?.status === 'failed'
            ? 'failed'
            : 'not_generated',
      findings: [],
      omitted: evidence.truncated,
      canRetry: !saved || saved.status === 'failed' || stale,
    },
  };
  return { report, completionRevision };
}

/** Facts come from durable events without requiring an execution environment or changing progress. */
export async function learningEvidence(
  principal: OwnerPrincipal,
  id: string,
): Promise<LearningReport> {
  return (await readReport(principal, id, true)).report;
}

/** Reading is always token-free; unfinished projects have no report surface. */
export async function learningReport(
  principal: OwnerPrincipal,
  id: string,
): Promise<LearningReport> {
  return (await readReport(principal, id)).report;
}

/** Explicit report-button action. One bounded model call; no new queue or sandbox. */
export async function generateLearningReport(
  principal: OwnerPrincipal,
  id: string,
  signal: AbortSignal,
) {
  const { report, completionRevision } = await readReport(principal, id);
  if (report.analysis?.status === 'ready' || report.analysis?.status === 'generating')
    return report;
  const store = await LearningStore.open();
  const attempt = randomUUID();
  const claimed = await store.transaction(async (db) => {
    // Serialize only the short claim. No database lock is held during the model call.
    await db.query('SELECT id FROM pbl_v3_studies WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
      id,
      principal.ownerId,
    ]);
    const current = await store.get(id, principal.ownerId, db);
    if (current.revision !== completionRevision || !canViewProjectReport(current.state))
      return false;
    const claim = await db.query(
      `INSERT INTO pbl_v3_reports(study_id,completion_revision,attempt,status) VALUES($1,$2,$3,'generating')
     ON CONFLICT(study_id) DO UPDATE SET completion_revision=$2,attempt=$3,status='generating',document=NULL,updated_at=now()
     WHERE pbl_v3_reports.status='failed' OR pbl_v3_reports.updated_at<now()-interval '2 minutes'
       OR pbl_v3_reports.completion_revision<>$2 RETURNING study_id`,
      [id, completionRevision, attempt],
    );
    return claim.rows.length > 0;
  });
  if (!claimed) return learningReport(principal, id);
  try {
    const analysis = await analyzeLearningReport(principal.ownerId, report, signal);
    const document: LearningReport = {
      ...report,
      analysis: {
        ...analysis,
        omitted: report.truncated || analysis.omitted,
        status: 'ready',
        generatedAt: new Date().toISOString(),
        canRetry: false,
      },
    };
    await store.pool.query(
      `UPDATE pbl_v3_reports SET status='ready',document=$3,updated_at=now() WHERE study_id=$1 AND attempt=$2`,
      [id, attempt, JSON.stringify(document)],
    );
    return learningReport(principal, id);
  } catch {
    await store.pool.query(
      `UPDATE pbl_v3_reports SET status='failed',updated_at=now() WHERE study_id=$1 AND attempt=$2`,
      [id, attempt],
    );
    return learningReport(principal, id);
  }
}
