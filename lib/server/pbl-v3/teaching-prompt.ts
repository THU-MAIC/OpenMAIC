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
import { isFinalProjectRecap } from './stage-progress';
import { stageStep } from '@/lib/pbl/v3/presentation';
import {
  teachingProductContext,
  productHelpRules,
  type TeachingWorkspaceFacts,
} from './product-context';
import {
  teachingRules,
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
      referenceMaterials: [],
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
    referenceMaterials: skill.documents,
    delivery:
      (stage.kind === 'mentor_say' &&
      stage.agent === 'discussion' &&
      section === skill.progression[1]
        ? stageOpeningRules + '\n'
        : '') +
      'Platform product/assistance policy overrides course UI instructions: reference materials are Agent references, not automatically learner files or controls. Platform pacing policy takes precedence over any course instruction to repeat a covered question. Check earlier learner replies before asking. If this section is already satisfied by verified same-version feedback, use reuseFeedback with a concrete explanation to continue without another question. Otherwise record one necessary question with request_skill_review and wait for a real reply. Explicit confident understanding is sufficient absent unresolved errors; never invent learner feedback.',
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
        : 'After the current completion gates succeed and productContext allows Continue, the learner uses the task bar above the chat input to enter the next step.';
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
                priorArtifactApproval,
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
      ? '\nThe current teachingContext is authoritative. Earlier stages do not complete this stage. If completionRecorded is true, answer follow-ups without reopening the review. While welcome is pending, deliver only the welcome and readiness discussion; request_skill_review can record readiness directly without read_next_skill first. A later explicit readiness reply opens A via read_next_skill with studentFeedback, without changing the step. For normal teaching, when activeSection is null, read_next_skill first, then read sections in order. Assistance-only turns use respond_to_learner without opening or advancing a section. New unanswered goals require one request_skill_review and real new feedback; already satisfied goals may reuse verified same-version learner feedback using reuseFeedback, including answers that anticipated the next section. State exactly what prior reply covers the goal; never reuse assistant reasoning as learner evidence. A correct answer or clear confident understanding suffices when no error or question remains. Do not add another example or boundary question merely to prolong review. Actual current-version plan/code approval is still required. When requesting that approval before the final section, set request_skill_review.approval; a substantive reply that explicitly accepts the unchanged current version can also supply approval: set artifactApproved on read_next_skill when advancing past that reply. Approval is semantic, not a required word; “我认可当前版本”, “looks good, no changes”, and agreement to proceed can qualify. Mere understanding does not. If the message both accepts and requests changes, clarify before progressing. Do not ask again just because the earlier question was not marked approval. The final plan/code section requests approval automatically. teachingContext.priorArtifactApproval identifies an actual earlier approval; the host revalidates its version before completion. Reuse it when unchanged instead of requesting a ceremonial approval at the final section. An already explicit same-version approval need not be repeated. If a required build is blocked and learner input is genuinely needed, request_learner_help hands control back without recording review or approval. Only complete_stage records completion; then follow learningRoadmap.confirmation. ' +
        confirmation
      : repairing
        ? '\nHelp the learner diagnose the observed test failure. Read the current code and approved plan before making a focused repair. Distinguish an implementation that departed from the learner plan from a learner proposal whose behavior failed the project goal. If fixing the latter changes a recorded decision, explain the evidence and obtain actual learner confirmation of the revised rule before changing its behavior; do not silently replace the proposal with your preferred answer. Preserve the original decision and record any learner-confirmed amendment using the current course artifacts and allowed tools. Do not claim to have updated a formal decision or approved plan through unavailable controls. Then make the focused repair and ask the learner to run tests again using the project controls. Never claim the repair passed without a new test result.'
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
export function teachingLiveContext(input: TeachingPromptInput): string {
  const guided = input.stage.kind === 'mentor_say' || input.stage.kind === 'produce';
  return JSON.stringify({
    productContext: { current: teachingProductContext(input).current },
    communication: input.communication ?? { uiLocale: 'en-US', responseLanguage: null },
    stageKey: input.stageKey,
    completionRecorded: input.completionRecorded ?? false,
    ...(input.stage.kind === 'dialogue'
      ? projectArtifacts({
          reads: ['decisions.chosen'],
          milestone: input.milestone,
          state: { decisions: input.collected.decisions },
          decisionCatalog: input.definition.decisions,
        })
      : {}),
    ...(guided
      ? {
          welcome: input.welcome,
          welcomePresented: input.welcomePresented,
          priorArtifactApproval: input.priorArtifactApproval ?? null,
          activeSection: input.activeSection || null,
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
