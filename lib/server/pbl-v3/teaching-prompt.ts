import 'server-only';
import type {
  AgentRole,
  MilestoneDefinition,
  ProjectDefinition,
  StageDefinition,
} from '@/lib/pbl/v3/domain/project/project-schema';
import { isExplorationStage } from '@/lib/pbl/v3/domain/project/project-schema';
import type { CollectedMilestoneState } from '@/lib/pbl/v3/domain/orchestration/types';
import { projectArtifacts } from '@/lib/pbl/v3/domain/orchestration/artifacts';
import { buildSystemPrompt } from '@/lib/pbl/v3/domain/orchestration/prompts';
import { stageStep } from '@/lib/pbl/v3/presentation';
import { teachingRules, interactionRules, assessmentRules } from './skills';

export interface TeachingSkill {
  content: Record<string, string>;
  progression: string[];
  documents: { path: string; text: string }[];
}
export interface TeachingPromptInput {
  definition: ProjectDefinition;
  stage: StageDefinition;
  milestone: MilestoneDefinition;
  role: AgentRole;
  stageKey: string;
  skill: TeachingSkill;
  packaged: boolean;
  collected: CollectedMilestoneState;
  planText?: string;
  activeSection?: string | null;
  completionRecorded?: boolean;
  milestoneIndex?: number;
  stageIndex?: number;
  automaticEntry?: boolean;
  reviewedSectionCount?: number;
  pendingReview?: {
    question: string;
    studentResponses: readonly { seq: number; text: string }[];
  } | null;
  pendingRun?: string | null;
}

/** The same course section representation is validated and returned by read_next_skill. */
export function teachingSection(
  { skill, stage, milestone }: Pick<TeachingPromptInput, 'skill' | 'stage' | 'milestone'>,
  section: string,
) {
  return {
    section,
    instruction: skill.content[section],
    referenceMaterials: skill.documents,
    delivery:
      'After delivering this section, put its single open question in request_skill_review. The tool displays the question and records the wait for a real learner reply. Do not end with only a question in ordinary text: that does not create a review receipt. Do not proceed to another section in this turn.',
    goal: milestone.goal ?? milestone.title,
    stage: stage.kind === 'mentor_say' ? stage.say : stage.kind === 'produce' ? stage.writes : '',
  };
}

function buildTeachingPrompt({
  definition,
  stage,
  milestone,
  role,
  stageKey,
  skill,
  packaged,
  collected,
  planText,
  activeSection = null,
  completionRecorded = false,
  milestoneIndex = definition.milestones.findIndex((item) => item.id === milestone.id),
  stageIndex = milestone.stages.indexOf(stage),
  automaticEntry = false,
  reviewedSectionCount = 0,
  pendingReview,
  pendingRun = null,
}: TeachingPromptInput) {
  const exploring = isExplorationStage(stage);
  const guided = (stage.kind === 'produce' && !exploring) || stage.kind === 'mentor_say';
  const repairing = stage.kind === 'check' && stage.checker === 'tests' && !!collected.remediation;
  const recapping =
    stage.kind === 'mentor_say' && stage.agent === 'mentor' && stage.skill === 'recap';
  const seed = projectArtifacts({
    reads: repairing
      ? ['contract', 'decisions.chosen', 'code']
      : 'reads' in stage
        ? stage.reads
        : [],
    milestone,
    state: { decisions: collected.decisions, plan: planText, code: collected.code?.value },
    decisionCatalog: definition.decisions,
  });
  return (
    buildSystemPrompt({
      role: role,
      seed: {
        referenceMaterials: skill.documents,
        ...(!guided && packaged ? { teachingInstructions: skill.content } : {}),
        ...seed,
        projectContext: { title: definition.title, language: definition.language },
        stageEntry: {
          automatic: automaticEntry,
          firstMilestone: milestoneIndex === 0,
          step: stageIndex + 1,
          totalSteps: milestone.stages.length,
          steps: milestone.stages.map(stageStep),
          introduction: milestoneIndex === 0 && stageIndex === 0 ? definition.intro.say : undefined,
        },
        learningRoadmap: {
          currentStep: stageStep(stage),
          nextStep: milestone.stages[stageIndex + 1]
            ? stageStep(milestone.stages[stageIndex + 1]!)
            : milestoneIndex + 1 < definition.milestones.length
              ? 'next_milestone'
              : 'project_complete',
          completionRecorded,
          confirmation:
            'The learner uses the task bar above the chat input to enter the next step.',
        },
        milestone: { id: milestone.id, title: milestone.title },
        goal: milestone.goal ?? milestone.title,
        ...(guided
          ? {
              teachingContext: {
                stageKey: stageKey,
                completionRecorded,
                activeSection: activeSection || null,
                nextSection:
                  skill.progression[reviewedSectionCount + (activeSection ? 2 : 1)] ?? null,
                finalSection: skill.progression.at(-1)!,
              },
            }
          : {}),
        ...(guided && pendingReview
          ? {
              currentReview: teachingReview(pendingReview),
            }
          : {}),
        ...(stage.kind === 'check'
          ? {
              assessmentContext: {
                checker: stage.checker,
                pendingRun: pendingRun,
                tests: collected.tests
                  ? { status: collected.tests.status, feedback: collected.tests.publicFeedback }
                  : null,
                quiz: collected.quiz
                  ? {
                      passed: collected.quiz.passed,
                      score: collected.quiz.score,
                      total: collected.quiz.total,
                    }
                  : null,
              },
            }
          : {}),
        ...(recapping
          ? {
              recordedEvidence: {
                tests: collected.tests
                  ? {
                      status: collected.tests.status,
                      feedback: collected.tests.publicFeedback?.slice(0, 8000),
                      workspaceRevision: collected.tests.revision,
                      codeArtifactId: collected.tests.codeArtifactId,
                    }
                  : null,
                quiz: collected.quiz
                  ? {
                      passed: collected.quiz.passed,
                      score: collected.quiz.score,
                      total: collected.quiz.total,
                      attempt: collected.quiz.attempt,
                      wrongQuestionIndexes: collected.quiz.wrong,
                    }
                  : null,
              },
            }
          : {}),
        ...(repairing
          ? { testFeedback: collected.tests?.publicFeedback, remediation: collected.remediation }
          : {}),
        ...(stage.kind === 'mentor_say'
          ? { instruction: stage.say, teaching: milestone.teaching }
          : {}),
        ...(stage.kind === 'produce'
          ? {
              planUpdateMode: stage.planUpdateMode,
              compileBeforeReview: stage.compileBeforeReview,
              exploration: stage.exploration,
            }
          : {}),
      },
      project: {
        commonRules: definition.agents.commonRules,
        agents: definition.agents,
      },
    }) +
    '\n' +
    teachingRules +
    (stage.kind === 'check' ? assessmentRules : interactionRules) +
    (completionRecorded
      ? '\nThe current stage is ALREADY complete for the recorded evidence. Answer any follow-up directly and point to the task-bar Continue action. Do not restart teaching, invent a new required question, or require complete_stage again just because the learner sent another message. Actual artifact changes invalidate the affected review and require reviewing that new version before completion.'
      : '') +
    (stage.kind === 'mentor_say' || stage.kind === 'dialogue'
      ? '\nThe current classroom stage is read-only: the learner can discuss concepts or record offered decisions, but cannot edit files or run commands. Ask for conceptual explanations and predicted results. Never require an edit, terminal action or newly executed output to finish this stage. Implementation and test execution belong to their dedicated stages; use only recorded evidence during reflection.'
      : stage.kind === 'produce' && stage.writes === 'plan'
        ? '\nPlanning permits changes to PLAN.md only. Source editing, commands and terminals are unavailable. Review the plan and the learner’s reasoning; do not require code implementation or execution for plan approval.'
        : '') +
    (guided
      ? '\nThe current teachingContext is authoritative. Earlier stages do not complete this stage. If completionRecorded is true, answer follow-ups without reopening completed sections and point to the task-bar Continue action. Otherwise, when activeSection is null, begin with read_next_skill. Never tell the learner to Continue before complete_stage succeeds for the current stage and evidence. Use read_next_skill to open one section at a time. After delivering a section use request_skill_review and wait for a NEW student reply. currentReview records the question and count of eligible replies; their full text remains in the current-stage learner messages. Assess those actual replies, combining them when needed. Supply studentFeedback as an explanation of how those replies answer the question; quoting or summarizing is allowed, but never invent a reply. If understanding is missing, clarify rather than advance. A short confirmation is sufficient only when the question asks for confirmation. Once final feedback is sufficient, use complete_stage as the last action instead of adding more questions. A completed tool is only a completion signal; the learner separately confirms progression.'
      : exploring
        ? '\nThis is optional, ongoing exploration. Discuss the learner’s goal, inspect current files, make focused changes and explain how to verify them. There is no fixed review sequence or completion signal. Preserve existing work; viewing the report never ends exploration.'
        : repairing
          ? '\nHelp the learner diagnose the observed test failure. Read the current code before making a focused repair. Explain the change and ask the learner to run tests again using the project controls. Never claim the repair passed without a new test result.'
          : stage.kind === 'check'
            ? '\nBriefly introduce the current test or quiz and point to its task drawer above the composer. Do not give answers, run checks, or claim results. Wait for the learner to use the controls.'
            : '\nDiscuss only the current decisions. The learner records choices using the project controls.')
  );
}

/** Learner text belongs to durable conversation history, outside the course-resource budget. */
function teachingReview(review: TeachingPromptInput['pendingReview']) {
  return review
    ? { question: review.question, studentResponseCount: review.studentResponses.length }
    : null;
}

/** The runner refreshes this state at every model-call boundary after tool mutations. */
export function teachingLiveContext(input: TeachingPromptInput): string {
  const guided =
    input.stage.kind === 'mentor_say' ||
    (input.stage.kind === 'produce' && !isExplorationStage(input.stage));
  if (!guided) return '';
  return JSON.stringify({
    stageKey: input.stageKey,
    completionRecorded: input.completionRecorded ?? false,
    activeSection: input.activeSection || null,
    nextSection:
      input.skill.progression[(input.reviewedSectionCount ?? 0) + (input.activeSection ? 2 : 1)] ??
      null,
    finalSection: input.skill.progression.at(-1)!,
    currentReview: teachingReview(input.pendingReview),
  });
}

export function teachingLiveSuffix(live: string): string {
  return live ? `\nAuthoritative live teaching state (overrides the entry snapshot): ${live}` : '';
}

/** Include the complete system prompt and every guided section's course-authored payload.
 * Learner history is managed separately by the teaching context window.
 */
export function renderTeachingPrompt(input: TeachingPromptInput) {
  const systemPrompt = buildTeachingPrompt(input);
  const sections =
    (input.stage.kind === 'produce' && !isExplorationStage(input.stage)) ||
    input.stage.kind === 'mentor_say'
      ? input.skill.progression.slice(1).map((section) => teachingSection(input, section))
      : [];
  const sectionBytes = sections.length ? Buffer.byteLength(JSON.stringify(sections)) : 0;
  return {
    systemPrompt,
    sectionBytes,
    bytes:
      Buffer.byteLength(systemPrompt + teachingLiveSuffix(teachingLiveContext(input))) +
      sectionBytes,
  };
}
