import 'server-only';
import type { StageDefinition } from '@/lib/pbl/v3/domain/project/project-schema';

import type { PblSessionState } from '@/lib/pbl/v3/domain/orchestration/types';
import type { EngineTransition } from '@/lib/pbl/v3/domain/orchestration/events';
import { currentStage } from '@/lib/pbl/v3/domain/orchestration/state';
import type { InstalledProject } from './catalog';

/**
 * Host-driven teaching protocol. The host advances the stage; the tutor
 * writes ordinary streaming prose and never registers progress. Opt-in per
 * deployment so courses that still carry the receipt protocol keep working.
 */
export function teachingLiteEnabled() {
  return ['true', '1'].includes(process.env.OPENMAIC_PBL_V3_TEACHING_LITE ?? '');
}

/** Discussion teaching only. Plan, code, recap and assessments keep the existing path. */
export function isLiteTeachingStage(stage: StageDefinition | undefined) {
  return (
    !!stage &&
    stage.kind === 'mentor_say' &&
    stage.agent === 'discussion' &&
    stage.skill !== 'recap'
  );
}

export function usesHostTeaching(state: PblSessionState) {
  return state.hostTeachingStage === `${state.position.milestoneId}:${state.position.stageIndex}`;
}

/** Choose once, in the same commit as the stage entry. No marker means receipt-based. */
export function selectTeachingProtocol(project: InstalledProject, next: EngineTransition) {
  if (!next.events.some((event) => event.type === 'stage.entered')) return next;
  return { ...next, state: teachingProtocolAtEntry(project, next.state) };
}

export function teachingProtocolAtEntry(project: InstalledProject, entered: PblSessionState) {
  const state = { ...entered };
  delete state.hostTeachingStage;
  const key = `${state.position.milestoneId}:${state.position.stageIndex}`;
  const course = project.coursePackage;
  if (
    teachingLiteEnabled() &&
    course &&
    isLiteTeachingStage(currentStage(project.definition, state))
  ) {
    const binding = course.descriptor.teaching.find(
      (s) => s.stage === key && s.role === 'discussion',
    );
    if (
      binding &&
      binding.entrypoint.split('/').at(-1) === 'OPENING.md' &&
      course.bundle.files[binding.entrypoint]?.trim()
    )
      state.hostTeachingStage = key;
  }
  return state;
}

/** A turn counts only when the learner can see prose; tool-only or empty output does not. */
export function hasAssistantText(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const block = part as { type?: string; text?: string };
    return block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '';
  });
}

interface TeachingEvent {
  type: string;
  attempt?: number;
  ts?: number | string;
  data: unknown;
}

const record = (data: unknown): Record<string, unknown> =>
  data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};

export interface TeachingVisitFacts {
  entered: boolean;
  openingDeliveredAt?: number;
  openingDelivered: boolean;
  learnerTurns: number;
  tutorTurns: number;
}

/**
 * Facts for one visit to a teaching stage, read from its durable events.
 * `openingDelivered` never becomes false again: a failed follow-up must not
 * revoke the departure the learner already earned after the opening.
 */
export function teachingVisitFacts(
  events: readonly TeachingEvent[],
  entry: { stageKey: string },
): TeachingVisitFacts {
  const facts: TeachingVisitFacts = {
    entered: false,
    openingDelivered: false,
    learnerTurns: 0,
    tutorTurns: 0,
  };
  let input: 'opening' | 'learner' | undefined;
  let attempt: number | undefined;
  let textDelivered = false;
  for (const e of events) {
    const d = record(e.data);
    if (!facts.entered) {
      if (
        e.type === 'pbl_stage_entered' &&
        d.step === 'teaching' &&
        `${d.milestoneId}:${d.stageIndex}` === entry.stageKey
      )
        facts.entered = true;
      continue;
    }
    if (e.type === 'pbl_stage_entered') break;
    if (e.type === 'user_message') {
      input = d.pblOpening === true ? 'opening' : 'learner';
      if (input === 'learner') facts.learnerTurns++;
      attempt = undefined;
      textDelivered = false;
    }
    if (!input) continue;
    if (e.type === 'pbl_turn_retried' || e.type === 'session_interrupted') {
      attempt = undefined;
      textDelivered = false;
    }
    if (e.type === 'session_start' || e.type === 'session_resumed') {
      attempt = e.attempt;
      textDelivered = false;
    }
    if (attempt == null || attempt !== e.attempt) continue;
    if (e.type === 'message_end') {
      const message = record(d.message);
      if (message.role === 'assistant') textDelivered ||= hasAssistantText(message.content);
    }
    if (e.type === 'session_end') {
      if (d.status === 'succeeded' && textDelivered) {
        facts.tutorTurns++;
        if (input === 'opening') {
          facts.openingDelivered = true;
          if (e.ts != null) facts.openingDeliveredAt ??= Number(e.ts);
        }
      }
      attempt = undefined;
      textDelivered = false;
    }
  }
  return facts;
}

/** Read one role session's teaching events and decide whether the opening landed. */
export async function readTeachingVisit(
  pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  sessionId: string,
  stageKey: string,
) {
  const { rows } = await pool.query(
    `SELECT type, attempt, ts, data FROM agent_session_events
      WHERE session_id=$1 AND seq >= (
        SELECT max(seq) FROM agent_session_events WHERE session_id=$1 AND type='pbl_stage_entered'
      ) AND type IN ('pbl_stage_entered','user_message','pbl_turn_retried',
        'session_interrupted','session_start','session_resumed','message_end','session_end')
      ORDER BY seq`,
    [sessionId],
  );
  return teachingVisitFacts(rows as TeachingEvent[], { stageKey });
}

export async function openingDelivered(...args: Parameters<typeof readTeachingVisit>) {
  return (await readTeachingVisit(...args)).openingDelivered;
}
