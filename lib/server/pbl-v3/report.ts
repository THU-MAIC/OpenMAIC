import 'server-only';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
import type { OrchestrationEvent } from '@/lib/pbl/v3/domain/orchestration/events';
import type { LearningReport } from '@/lib/pbl/v3/report';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { LearningStore } from './store';
import { projectFor } from './runtime';
import { reviewQuestion } from './review-question';

/** Facts come from durable events. This read does not require an execution environment or change progress. */
export async function learningReport(
  principal: OwnerPrincipal,
  id: string,
): Promise<LearningReport> {
  const store = await LearningStore.open(),
    row = await store.get(id, principal.ownerId);
  const project = projectFor(row);
  const evidence: LearningReport['evidence'] = [];
  const records = await store.pool.query<{ sequence: number; event: OrchestrationEvent }>(
    'SELECT sequence,event FROM pbl_v3_events WHERE study_id=$1 AND sequence<=$2 ORDER BY sequence DESC LIMIT 5001',
    [id, row.state.lastSequence],
  );
  for (const { sequence, event } of records.rows.slice(0, 5000).reverse()) {
    let detail: string | undefined, version: string | undefined;
    let milestoneId = 'milestoneId' in event ? event.milestoneId : undefined;
    switch (event.type) {
      case 'decision.recorded': {
        const d = project.definition.decisions.find((d) => d.id === event.decisionId);
        detail = `${d?.decisionPrompt ?? event.decisionId}: ${d?.options.find((o) => o.id === event.chosen)?.label ?? event.chosen ?? ''}`;
        break;
      }
      case 'artifact.recorded':
        milestoneId = event.artifact.milestoneId;
        detail =
          event.artifact.kind === 'plan'
            ? (event.content ?? '')
            : (event.changedPaths?.join('\n') ?? event.artifact.value);
        version = event.artifact.workspaceRevisionId;
        break;
      case 'evaluation.recorded':
        milestoneId = event.evaluation.milestoneId;
        detail = `${event.evaluation.status}\n${event.evaluation.publicFeedback ?? ''}`;
        version = event.evaluation.revision.id;
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
    if (detail !== undefined)
      evidence.push({
        sequence,
        milestoneId,
        kind: event.type,
        detail: detail.slice(0, 16000),
        ...(version ? { version } : {}),
      });
  }
  const counts = Object.fromEntries(
    (
      await store.pool.query<{ kind: string; count: number }>(
        "SELECT event->>'type' AS kind,count(*)::int AS count FROM pbl_v3_events WHERE study_id=$1 AND sequence<=$2 GROUP BY event->>'type'",
        [id, row.state.lastSequence],
      )
    ).rows.map((r) => [r.kind, r.count]),
  );
  const agents = await getAgentSessionStore();
  const conversations: LearningReport['conversations'] = [];
  for (const binding of await store.roles(id)) {
    if (!(await agents.getSession(binding.session_id))) continue;
    const last = await agents.lastEventSeq(binding.session_id);
    const entries = await agents.readEventsAfter(binding.session_id, Math.max(0, last - 500), 500);
    const messages: LearningReport['conversations'][number]['messages'] = [];
    let latestInputSequence: number | undefined;
    for (const entry of entries) {
      const data = entry.data as {
        text?: string;
        pblOpening?: boolean;
        message?: { role?: string; content?: { type: string; text?: string }[] };
      };
      const question = reviewQuestion(entry);
      if (question !== null)
        messages.push({ sequence: entry.id, role: 'assistant', text: question });
      if (entry.type === 'user_message') {
        // Review recovery follows the actual queued input, including automatic
        // openings. Only real learner messages belong in the visible transcript.
        latestInputSequence = entry.id;
        if (!data.pblOpening && typeof data.text === 'string')
          messages.push({ sequence: entry.id, role: 'user', text: data.text.slice(0, 8000) });
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
          messages.push({ sequence: entry.id, role: 'assistant', text: text.slice(0, 8000) });
      }
    }
    const pending = binding.guided?.pending;
    if (
      latestInputSequence !== undefined &&
      pending?.runId === `${binding.stage_key}:${latestInputSequence}` &&
      !messages.some(
        (m) =>
          m.sequence > latestInputSequence && m.role === 'assistant' && m.text === pending.question,
      )
    )
      messages.push({ sequence: last + 1, role: 'assistant', text: pending.question });
    conversations.push({
      role: binding.role,
      milestone: binding.context_key,
      messages,
      truncated: last > 500,
    });
  }
  return {
    studyId: id,
    project: { id: project.ref.id, version: project.ref.version, title: project.definition.title },
    revision: row.revision,
    requiredComplete: project.definition.milestones.every(
      (m, i) => m.optional || row.state.milestones[i]?.status === 'completed',
    ),
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
    truncated: records.rows.length > 5000,
  };
}
