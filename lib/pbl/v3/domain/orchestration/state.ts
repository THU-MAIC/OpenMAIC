import type { ProjectDefinition } from '../project/project-schema';
import type { CollectedMilestoneState, PblSessionState } from './types';

export function createCollectedMilestoneState(): CollectedMilestoneState {
  return {
    teachingCompleted: false,
    planReviewCompleted: false,
    codeReviewCompleted: false,
    decisions: [],
    decisionRecordIds: {},
    plan: null,
    code: null,
    tests: null,
    quiz: null,
    remediation: null,
  };
}

export function createPblSessionState(project: ProjectDefinition): PblSessionState {
  return {
    status: 'created',
    position: { milestoneIndex: 0, milestoneId: null, stageIndex: -1 },
    milestones: project.milestones.map((milestone) => ({
      milestoneId: milestone.id,
      status: 'pending',
      stageIndex: -1,
      completedStageIndexes: [],
      evaluationIds: [],
    })),
    collected: Object.fromEntries(
      project.milestones.map((milestone) => [milestone.id, createCollectedMilestoneState()]),
    ),
    courses: initialCourseProgress(project),
    decisionRevisions: {},
    lastSequence: 0,
  };
}

function initialCourseProgress(
  project: ProjectDefinition,
): NonNullable<PblSessionState['courses']> {
  const release = project.services.find(
    (service) => service.serviceType === 'openmaic-classroom',
  )?.courseRelease;
  if (!release) return {};
  return Object.fromEntries(
    project.milestones.flatMap((milestone) =>
      milestone.stages.flatMap((stage, stageIndex) => {
        if (
          stage.kind !== 'course' ||
          stage.courseId !== release.courseId ||
          stage.releaseId !== release.releaseId
        )
          return [];
        return [
          [
            stage.courseId,
            {
              courseId: stage.courseId,
              milestoneId: milestone.id,
              stageIndex,
              release,
              status: 'pending' as const,
            },
          ],
        ];
      }),
    ),
  );
}

export function currentMilestone(project: ProjectDefinition, state: PblSessionState) {
  return project.milestones[state.position.milestoneIndex];
}

export function currentStage(project: ProjectDefinition, state: PblSessionState) {
  return currentMilestone(project, state)?.stages[state.position.stageIndex];
}
