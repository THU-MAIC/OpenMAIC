import 'server-only';
import { communicationRules, type ResponseLanguage } from './communication';
import type {
  AgentRole,
  MilestoneDefinition,
  ProjectDefinition,
  StageDefinition,
} from '@/lib/pbl/v3/domain/project/project-schema';
import type { CollectedMilestoneState } from '@/lib/pbl/v3/domain/orchestration/types';
import { projectArtifacts } from '@/lib/pbl/v3/domain/orchestration/artifacts';
import {
  buildSystemPrompt,
  quotedDecisionContext,
} from '@/lib/pbl/v3/domain/orchestration/prompts';
import { isFinalProjectRecap, requiresArtifactApproval } from './stage-progress';
import type { GuidedFeedbackSource } from './guided-review';
import { stageStep } from '@/lib/pbl/v3/presentation';
import {
  teachingProductContext,
  productHelpRules,
  type TeachingWorkspaceFacts,
} from './product-context';
import {
  teachingRules,
  learnerExpressionRules,
  planPresentationRules,
  interactionRules,
  assessmentRules,
  decisionRules,
  projectWelcomeRules,
  stageOpeningRules,
} from './skills';

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
  welcome?: 'pending' | 'ready';
  welcomePresented?: boolean;
  milestoneIndex?: number;
  stageIndex?: number;
  automaticEntry?: boolean;
  reviewedSectionCount?: number;
  feedbackSource?: GuidedFeedbackSource | null;
  priorArtifactApproval?: { studentSeq: number; revalidateCurrentVersion: true } | null;
  pendingReview?: {
    question: string;
    approval?: boolean;
    studentResponses: readonly { seq: number; text: string }[];
  } | null;
  pendingRun?: string | null;
  workspace?: TeachingWorkspaceFacts;
  communication?: { uiLocale: string; responseLanguage: ResponseLanguage | null };
}

const feedbackRules =
  'Use the current feedbackSource and section positions to choose the next action. For pending_review_reply, explain how the new reply answers the recorded question in studentFeedback and omit reuseFeedback. For verified_feedback, set reuseFeedback: true only if the previously verified same-version learner reply covers the current goal, and explain that coverage concretely. The presence of verified_feedback alone does not mean a new goal is answered. New unanswered goals require one request_skill_review and real new feedback. Do not add another example or boundary question merely to prolong review. Explicit confident understanding is sufficient absent unresolved errors or questions; it does not replace required artifact approval. Quotes and summaries of actual learner replies are allowed. The host rechecks the current version. After delivering the active section, if feedbackSource is null, record one necessary question with request_skill_review and wait before advancing. A protocol rejection is not a transient network error: follow the returned current section and next action; do not retry by paraphrasing feedback or blindly switching reuseFeedback. A reread does not create learner evidence.';

const artifactApprovalRules =
  'Actual current-version plan/code approval is still required. When requesting approval before the final section, set request_skill_review.approval. For a real reply that explicitly accepts the unchanged version, set artifactApproved when advancing or completing. Mere understanding does not count as approval. Clarify mixed acceptance and requests for changes. The final artifact section requests approval automatically. Reuse priorArtifactApproval if it covers the unchanged version, which the host revalidates.';

/** The same course section representation is validated and returned by read_next_skill. */
export function teachingSection(
  {
    skill,
    stage,
    milestone,
    definition,
    welcome,
    welcomePresented,
  }: Pick<TeachingPromptInput, 'skill' | 'stage' | 'milestone'> &
    Partial<Pick<TeachingPromptInput, 'definition' | 'welcome' | 'welcomePresented'>>,
  section: string,
) {
  if (welcome === 'pending')
    return {
      section,
      welcomePresented: welcomePresented ?? false,
      instruction: projectWelcomeRules,
      project: { title: definition?.title, overview: definition?.intro.say },
      milestone: { title: milestone.title, goal: milestone.goal ?? milestone.title },
      steps: milestone.stages.map(stageStep),
      delivery:
        'Welcome only. Record the readiness question, then wait; read_next_skill with actual later readiness feedback starts teaching in this same section.',
    };
  return {
    section,
    instruction: skill.content[section],
    ...(section === skill.progression[1] ? { teaching: milestone.teaching } : {}),
    delivery:
      (stage.kind === 'mentor_say' &&
      stage.agent === 'discussion' &&
      section === skill.progression[1]
        ? stageOpeningRules + '\n'
        : '') +
      (stage.kind === 'produce' && stage.writes === 'plan' ? planPresentationRules + '\n' : '') +
      'Platform product/assistance policy overrides course UI instructions. Reference materials are Agent references, not automatically learner files or controls. Credit feedback already given instead of asking a repeated question. Reuse verified same-version learner feedback only when it covers the current goal. New unanswered goals require one request_skill_review and real new feedback. Do not add another example or boundary question merely to prolong review. Explicit confident understanding is sufficient absent unresolved errors or questions; it does not replace required artifact approval. ' +
      (section === skill.progression.at(-1)
        ? 'This is the final section. If the goal is covered by available feedback and any required artifact approval is satisfied, use complete_stage. If a necessary question remains, record it with request_skill_review and wait.'
        : 'When the current goal is covered by available feedback, use read_next_skill to open the next section. Otherwise record one necessary question with request_skill_review and wait.'),
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
  welcome,
  welcomePresented,
  milestoneIndex = definition.milestones.findIndex((item) => item.id === milestone.id),
  stageIndex = milestone.stages.indexOf(stage),
  automaticEntry = false,
  reviewedSectionCount = 0,
  feedbackSource = null,
  priorArtifactApproval = null,
  pendingReview,
  pendingRun = null,
  workspace,
  communication = { uiLocale: 'en-US', responseLanguage: null },
}: TeachingPromptInput) {
  const finalRecap = isFinalProjectRecap(definition, { milestoneIndex, stageIndex }, stage);
  const confirmation =
    welcome === 'pending'
      ? 'Project readiness is a chat reply, not a Continue button. After that reply, read_next_skill opens formal teaching inside this same first step; do not send the learner to another step.'
      : finalRecap
        ? 'Only a successful final recap complete_stage receipt completes the project and reveals the report in the top toolbar, final completion message and project overview. The completion banner only shows status. Before that receipt, do not claim completion or say a report is already available. Refer to the actual productContext.visibleLabels.report text when giving directions. The report links back to the read-only workbench and remains discoverable after revisiting the PBL scene. Do not ask for another Continue click or append another milestone.'
        : 'After the current completion gates succeed and productContext allows Continue, the learner uses the task bar at the bottom of the Learning Assistant pane to enter the next step. Quote productContext.visibleLabels.continue exactly when naming that button.';
  const artifactApprovalRequired = requiresArtifactApproval(stage);
  const guided = stage.kind === 'produce' || stage.kind === 'mentor_say';
  const repairing = stage.kind === 'check' && stage.checker === 'tests' && !!collected.remediation;
  const recapping =
    stage.kind === 'mentor_say' && stage.agent === 'mentor' && stage.skill === 'recap';
  const seed = projectArtifacts({
    reads: repairing
      ? ['contract', 'decisions.chosen', 'code']
      : 'reads' in stage
        ? stage.kind === 'dialogue'
          ? [...stage.reads, 'decisions.chosen']
          : stage.reads
        : [],
    milestone,
    state: { decisions: collected.decisions, plan: planText, code: collected.code?.value },
    decisionCatalog: definition.decisions,
  });
  const { current: _entryState, ...productGuide } = teachingProductContext({
    definition,
    stage,
    role,
    completionRecorded,
    workspace,
    uiLocale: communication.uiLocale,
  });
  return (
    buildSystemPrompt({
      role: role,
      seed: {
        productContext: productGuide,
        communication,
        referenceMaterials: welcome === 'pending' ? [] : skill.documents,
        ...(!guided && packaged ? { teachingInstructions: skill.content } : {}),
        ...(welcome === 'pending' ? {} : seed),
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
          confirmation,
        },
        milestone: { id: milestone.id, title: milestone.title },
        goal: milestone.goal ?? milestone.title,
        ...(guided
          ? {
              teachingContext: {
                stageKey: stageKey,
                completionRecorded,
                welcome,
                welcomePresented,
                artifactApprovalRequired,
                ...(artifactApprovalRequired ? { priorArtifactApproval } : {}),
                feedbackSource,
                activeSection: activeSection || null,
                nextSection:
                  welcome === 'pending' && activeSection
                    ? activeSection
                    : (skill.progression[reviewedSectionCount + (activeSection ? 2 : 1)] ?? null),
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
          ? {
              testFeedback: collected.tests?.publicFeedback,
              publicDiagnostics: collected.tests?.publicDiagnostics,
              remediation: collected.remediation,
              ...(collected.remediation?.kind === 'evaluation_recovery'
                ? {
                    recoveryInstructions:
                      'No reliable test verdict was obtained. This is not confirmed learner error. Help inspect visible project files and run the public build if useful; do not invent hidden test details or change correct code just to guess at a platform problem. The learner may retry assessment. If tooling, dependencies or course fixtures remain broken, explain the blocker and ask for platform/course support; do not claim a pass or reset teaching progress.',
                  }
                : {}),
            }
          : {}),
        ...(stage.kind === 'mentor_say' && welcome !== 'pending'
          ? { instruction: stage.say, teaching: milestone.teaching }
          : {}),
        ...(stage.kind === 'produce'
          ? {
              planUpdateMode: stage.planUpdateMode,
              compileBeforeReview: stage.compileBeforeReview,
            }
          : {}),
      },
      project: {
        commonRules: definition.agents.commonRules,
        agents: definition.agents,
      },
    }) +
    '\n' +
    communicationRules +
    '\n' +
    teachingRules +
    '\n' +
    learnerExpressionRules +
    (stage.kind === 'produce' && stage.writes === 'plan' ? '\n' + planPresentationRules : '') +
    (guided ? interactionRules : stage.kind === 'check' ? assessmentRules : '') +
    (welcome === 'pending' ? '\n' + projectWelcomeRules : '') +
    (welcome !== 'pending' && stage.kind === 'mentor_say' && stage.agent === 'discussion'
      ? '\n' + stageOpeningRules
      : '') +
    (stage.kind === 'dialogue' ? '\n' + decisionRules : '') +
    (completionRecorded
      ? '\nThe current stage is ALREADY complete for the recorded evidence. Answer any follow-up directly. Do not restart teaching, invent a new required question, or require complete_stage again just because the learner sent another message. Actual artifact changes invalidate the affected review and require reviewing that new version before completion.'
      : '') +
    (guided
      ? '\nThe current teachingContext is authoritative. If completionRecorded is true, answer follow-ups without reopening the review. While welcome is pending, deliver only the welcome and readiness discussion. request_skill_review can record readiness directly without read_next_skill first. A later explicit readiness reply opens A via read_next_skill with studentFeedback, without changing the step. For normal teaching, when activeSection is null, open the first section with read_next_skill without studentFeedback. Read sections in order. Assistance-only turns use respond_to_learner without opening or advancing a section. ' +
        feedbackRules +
        ' Use complete_stage only after reading finalSection and satisfying its goal. Only complete_stage records completion. Artifact approval applies only when artifactApprovalRequired is true. ' +
        (artifactApprovalRequired ? artifactApprovalRules + ' ' : '') +
        confirmation
      : repairing
        ? '\nHelp the learner diagnose the observed test failure. Read the relevant source and plan. If the implementation is wrong, repair the permitted source directly. Do not require a PLAN.md edit or another plan approval before fixing code. Explain the observed issue, which files changed, and that saved edits are recorded by the workbench. If the evidence points to the plan itself (for example, a test checks a missing course-required record in PLAN.md), explain why a source change would not fix it. The learner may edit PLAN.md in the IDE while the assistant and tests are idle. If the learner asks you to amend it, make the focused change with write_file. Keep approved earlier chapters intact where the course uses incremental plans. Preserve the original decision. If a repair changes the learner’s intended behavior, explain the evidence and obtain actual learner confirmation of the revised rule before making that change. A file edit cannot resubmit a formal choice. When the failure is an unreliable evaluation, diagnose the environment or retry before assuming any file needs changing. After a repair, ask the learner to run the formal tests again. Only the recorded result establishes a pass.'
        : stage.kind === 'check'
          ? '\nBriefly introduce the current test or quiz using productContext controls. Do not give assessment answers, run checks, or claim results. Wait for the learner to use the controls. Ordinary tests/quizzes have no learner chat: do not invite a message; answer repair questions only when productContext.current.chatSupported is true.'
          : '\nFocus decision guidance on the current offered decisions. The learner records choices using the project controls. Project knowledge and product help remain available.') +
    '\n' +
    productHelpRules
  );
}

/** Learner text belongs to durable conversation history. */
function teachingReview(review: TeachingPromptInput['pendingReview']) {
  return review
    ? {
        question: review.question,
        studentResponseCount: review.studentResponses.length,
        ...(review.approval ? { approval: true } : {}),
      }
    : null;
}

/** Only changing state is repeated; the product guide is already in the system prompt. */
export function teachingLiveContext(
  input: TeachingPromptInput,
  startedWithWelcome = false,
): string {
  const artifactApprovalRequired = requiresArtifactApproval(input.stage);
  const guided = input.stage.kind === 'mentor_say' || input.stage.kind === 'produce';
  const repair =
    input.stage.kind === 'check' &&
    input.stage.checker === 'tests' &&
    !!input.collected.remediation;
  const chosenVisible =
    input.stage.kind === 'dialogue' ||
    repair ||
    ('reads' in input.stage && input.stage.reads.includes('decisions.chosen'));
  const assessmentVisible =
    input.stage.kind === 'check' ||
    (input.stage.kind === 'mentor_say' &&
      input.stage.agent === 'mentor' &&
      input.stage.skill === 'recap');
  return JSON.stringify({
    productContext: { current: teachingProductContext(input).current },
    communication: input.communication ?? { uiLocale: 'en-US', responseLanguage: null },
    // The static prompt intentionally hides lesson references during the welcome.
    // Make them available on the same run once the learner starts the lesson.
    ...(startedWithWelcome && input.welcome === 'ready'
      ? { referenceMaterials: input.skill.documents }
      : {}),
    stageKey: input.stageKey,
    completionRecorded: input.completionRecorded ?? false,
    // Builds also run during planning/coding; their existing ID must survive
    // compaction so the Agent collects it instead of starting another command.
    pendingRun: input.pendingRun ?? null,
    ...(chosenVisible
      ? projectArtifacts({
          reads: ['decisions.chosen'],
          milestone: input.milestone,
          state: { decisions: input.collected.decisions },
          decisionCatalog: input.definition.decisions,
        })
      : {}),
    ...(assessmentVisible
      ? {
          currentAssessment: {
            pendingRun: input.pendingRun ?? null,
            tests: input.collected.tests
              ? {
                  status: input.collected.tests.status,
                  publicFeedback: input.collected.tests.publicFeedback,
                  workspaceRevision: input.collected.tests.revision,
                  codeArtifactId: input.collected.tests.codeArtifactId,
                }
              : null,
            quiz: input.collected.quiz
              ? {
                  passed: input.collected.quiz.passed,
                  score: input.collected.quiz.score,
                  total: input.collected.quiz.total,
                  attempt: input.collected.quiz.attempt,
                }
              : null,
          },
        }
      : {}),
    ...(guided
      ? {
          welcome: input.welcome,
          welcomePresented: input.welcomePresented,
          artifactApprovalRequired,
          ...(artifactApprovalRequired
            ? { priorArtifactApproval: input.priorArtifactApproval ?? null }
            : {}),
          feedbackSource: input.feedbackSource ?? null,
          activeSection: input.activeSection || null,
          // The active section may otherwise exist only in an old tool result.
          // Restore its exact instructions after any history projection.
          activeInstruction: input.activeSection
            ? teachingSection(input, input.activeSection)
            : null,
          nextSection:
            (input.welcome === 'pending' && input.activeSection
              ? input.activeSection
              : input.skill.progression[
                  (input.reviewedSectionCount ?? 0) + (input.activeSection ? 2 : 1)
                ]) ?? null,
          finalSection: input.skill.progression.at(-1)!,
          currentReview: teachingReview(input.pendingReview),
        }
      : {}),
  });
}

export function teachingLiveSuffix(live: string): string {
  if (!live) return '';
  const { decisionsChosen, ...hostContext } = JSON.parse(live);
  return (
    `\nAuthoritative live teaching state (current facts override earlier state; the static product guide still applies): ${JSON.stringify(hostContext)}` +
    (decisionsChosen === undefined ? '' : quotedDecisionContext(decisionsChosen))
  );
}

/** Include the complete system prompt and every guided section's course-authored payload.
 * Learner history is managed separately by the teaching context window.
 */
export function renderTeachingPrompt(input: TeachingPromptInput) {
  const systemPrompt = buildTeachingPrompt(input);
  const sections =
    input.stage.kind === 'produce' || input.stage.kind === 'mentor_say'
      ? input.skill.progression
          .slice(1)
          .map((section) => teachingSection({ ...input, welcome: undefined }, section))
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
