import type { AgentRole } from '../project/project-schema';
import type {
  ArtifactRecord,
  CourseLifecycleStatus,
  EvaluationResult,
  PblSessionState,
  QuizAttempt,
  RemediationHint,
} from './types';

export type OrchestrationEvent =
  | { type: 'session.started'; projectId: string }
  | { type: 'teaching.completed'; milestoneId: string }
  | { type: 'recap.completed'; milestoneId: string }
  | { type: 'artifact.review.completed'; milestoneId: string; artifactKind: 'plan' | 'code' }
  | { type: 'milestone.entered'; milestoneId: string; milestoneIndex: number; title: string }
  | { type: 'stage.entered'; milestoneId: string; stageIndex: number; stageKind: string }
  | { type: 'agent.activated'; role: AgentRole; agentId: string }
  | {
      type: 'decision.recorded';
      milestoneId: string;
      decisionId: string;
      recordId: string;
      chosen?: string;
      rationale?: string;
      revision: number;
    }
  /**
   * A version of the plan or the code, and — separately from the record kept in state — what it
   * actually consisted of.
   *
   * The state carries the plan's hash and never its body: the canonical `PLAN.md` lives in the
   * workspace, and a copy in state was deliberately migrated out of it. But a report written after
   * the sandbox is gone has no workspace to read, and "提交了第 2 版方案" is not something a student
   * can check anything against. So the body rides on the event, which is the part that is banked
   * centrally, while state stays as small as it was.
   *
   * `content` is the plan as it stood at this revision, truncated if it is very long. `changedPaths`
   * is what the coder's writes actually landed on, which the overlay already computes and until now
   * only announced over the websocket; `changes` is the lines behind those paths, without which a
   * report can say a file was touched after the student asked for something and can never say
   * whether the thing asked for was written.
   */
  | {
      type: 'artifact.recorded';
      artifact: ArtifactRecord;
      content?: string;
      changedPaths?: string[];
      changes?: string;
    }
  | { type: 'evaluation.recorded'; evaluation: EvaluationResult }
  | { type: 'remediation.entered'; remediation: RemediationHint }
  | { type: 'quiz.recorded'; milestoneId: string; quiz: QuizAttempt }
  | {
      type: 'course.lifecycle.recorded';
      courseId: string;
      release: { releaseId: string; version: string; formatVersion: number };
      status: CourseLifecycleStatus;
      occurredAt: string;
      errorCode?: string;
    }
  | { type: 'stage.completed'; milestoneId: string; stageIndex: number }
  | { type: 'milestone.completed'; milestoneId: string; milestoneIndex: number }
  | { type: 'milestone.agents.released'; milestoneId: string; agentIds: string[] }
  | { type: 'session.completed' }
  | { type: 'session.failed'; reason: string }
  | { type: 'state.persisted'; milestoneId: string; stageIndex: number };

export interface EngineTransition {
  state: PblSessionState;
  events: OrchestrationEvent[];
}
