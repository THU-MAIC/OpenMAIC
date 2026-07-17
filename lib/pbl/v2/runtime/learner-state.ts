import type {
  PBLEngagementEvent,
  PBLEngagementSummary,
  PBLEvaluation,
  PBLAgentThread,
  PBLChatMessage,
  PBLHandover,
  PBLInternalAssessment,
  PBLMicrotaskStatus,
  PBLMilestoneStatus,
  PBLPendingTaskCompletion,
  PBLProficiencyAssessment,
  PBLProjectStatus,
  PBLProjectV2,
  PBLSubmission,
  PBLUiPhase,
} from '@/lib/pbl/v2/types';
import { clone } from './clone';

export interface PBLLearnerMicrotaskState {
  id: string;
  status: PBLMicrotaskStatus;
  internalAssessment?: PBLInternalAssessment;
  completionReason?: string;
  engagement?: PBLEngagementSummary;
}

export interface PBLLearnerMilestoneState {
  id: string;
  status: PBLMilestoneStatus;
  internalAssessment?: PBLInternalAssessment;
  microtasks: PBLLearnerMicrotaskState[];
}

export interface PBLLearnerThreadState {
  agentId: string;
  messages: PBLChatMessage[];
  // Extracted for forward compatibility. Today instructor memory compression
  // is request-local on the server and no persisted reducer/patch truncates
  // client-held threads or sets this field.
  earlierSummary?: string;
}

export interface PBLLearnerState {
  uiPhase: PBLUiPhase;
  status: PBLProjectStatus;
  milestones: PBLLearnerMilestoneState[];
  submissions: PBLSubmission[];
  evaluations: PBLEvaluation[];
  threads: PBLLearnerThreadState[];
  engagementEvents: PBLEngagementEvent[];
  proficiencyAssessment?: PBLProficiencyAssessment;
  pendingHandover?: PBLHandover;
  pendingTaskCompletion?: PBLPendingTaskCompletion;
  runtimeResetEpoch?: number;
}

function assignOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value === undefined) return;
  target[key] = clone(value);
}

export function extractLearnerState(project: PBLProjectV2): PBLLearnerState {
  const state: PBLLearnerState = {
    uiPhase: project.uiPhase,
    status: project.status,
    milestones: project.milestones.map((milestone) => {
      const milestoneState: PBLLearnerMilestoneState = {
        id: milestone.id,
        status: milestone.status,
        microtasks: milestone.microtasks.map((microtask) => {
          const microtaskState: PBLLearnerMicrotaskState = {
            id: microtask.id,
            status: microtask.status,
          };
          assignOptional(microtaskState, 'internalAssessment', microtask.internalAssessment);
          assignOptional(microtaskState, 'completionReason', microtask.completionReason);
          assignOptional(microtaskState, 'engagement', microtask.engagement);
          return microtaskState;
        }),
      };
      assignOptional(milestoneState, 'internalAssessment', milestone.internalAssessment);
      return milestoneState;
    }),
    submissions: clone(project.submissions),
    evaluations: clone(project.evaluations),
    threads: project.threads.map((thread) => {
      const threadState: PBLLearnerThreadState = {
        agentId: thread.agentId,
        messages: clone(thread.messages),
      };
      assignOptional(threadState, 'earlierSummary', thread.earlierSummary);
      return threadState;
    }),
    engagementEvents: clone(project.engagementEvents),
  };

  assignOptional(state, 'proficiencyAssessment', project.proficiencyAssessment);
  assignOptional(state, 'pendingHandover', project.pendingHandover);
  assignOptional(state, 'pendingTaskCompletion', project.pendingTaskCompletion);
  assignOptional(state, 'runtimeResetEpoch', project.runtimeResetEpoch);
  return state;
}

export function stripToDesignTemplate(project: PBLProjectV2): PBLProjectV2 {
  const template = clone(project);
  const authoredProficiency =
    template.proficiencyAssessment?.transitions[0]?.from ?? template.proficiency;
  template.uiPhase = 'hero';
  template.status = 'active';
  template.submissions = [];
  template.evaluations = [];
  template.engagementEvents = [];
  template.proficiencyAssessment = undefined;
  template.proficiency = authoredProficiency;
  template.runtimeEvents = undefined;
  template.runtimeResetEpoch = undefined;
  template.pendingHandover = undefined;
  template.pendingTaskCompletion = undefined;
  template.pendingOpenTaskPriorQuizResults = undefined;

  template.threads = template.threads.map(
    (thread): PBLAgentThread => ({
      agentId: thread.agentId,
      messages: [],
    }),
  );

  template.milestones = template.milestones.map((milestone, index) => ({
    ...milestone,
    status: index === 0 ? 'active' : 'locked',
    internalAssessment: undefined,
    microtasks: milestone.microtasks.map((microtask) => ({
      ...microtask,
      status: 'todo',
      internalAssessment: undefined,
      completionReason: undefined,
      engagement: undefined,
    })),
  }));

  return template;
}

export function applyLearnerState(
  designTemplate: PBLProjectV2,
  learnerState: PBLLearnerState,
): PBLProjectV2 {
  const next = stripToDesignTemplate(designTemplate);
  next.uiPhase = learnerState.uiPhase;
  next.status = learnerState.status;
  next.submissions = clone(learnerState.submissions);
  next.evaluations = clone(learnerState.evaluations);
  next.engagementEvents = clone(learnerState.engagementEvents);
  next.runtimeResetEpoch = learnerState.runtimeResetEpoch;
  next.pendingHandover = clone(learnerState.pendingHandover);
  next.pendingTaskCompletion = clone(learnerState.pendingTaskCompletion);

  if (learnerState.proficiencyAssessment) {
    next.proficiencyAssessment = clone(learnerState.proficiencyAssessment);
    next.proficiency = learnerState.proficiencyAssessment.tier;
  }

  const milestonesById = new Map(
    learnerState.milestones.map((milestone) => [milestone.id, milestone]),
  );
  next.milestones = next.milestones.map((milestone) => {
    const milestoneState = milestonesById.get(milestone.id);
    if (!milestoneState) return milestone;
    const microtasksById = new Map(
      milestoneState.microtasks.map((microtask) => [microtask.id, microtask]),
    );
    return {
      ...milestone,
      status: milestoneState.status,
      internalAssessment: clone(milestoneState.internalAssessment),
      microtasks: milestone.microtasks.map((microtask) => {
        const microtaskState = microtasksById.get(microtask.id);
        if (!microtaskState) return microtask;
        return {
          ...microtask,
          status: microtaskState.status,
          internalAssessment: clone(microtaskState.internalAssessment),
          completionReason: microtaskState.completionReason,
          engagement: clone(microtaskState.engagement),
        };
      }),
    };
  });

  const existingThreadIds = new Set(next.threads.map((thread) => thread.agentId));
  const threadsById = new Map(learnerState.threads.map((thread) => [thread.agentId, thread]));
  next.threads = next.threads.map((thread) => {
    const threadState = threadsById.get(thread.agentId);
    if (!threadState) return thread;
    return {
      agentId: thread.agentId,
      messages: clone(threadState.messages),
      earlierSummary: threadState.earlierSummary,
    };
  });
  for (const threadState of learnerState.threads) {
    if (existingThreadIds.has(threadState.agentId)) continue;
    next.threads.push({
      agentId: threadState.agentId,
      messages: clone(threadState.messages),
      earlierSummary: threadState.earlierSummary,
    });
  }

  return next;
}
