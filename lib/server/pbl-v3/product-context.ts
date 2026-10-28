import 'server-only';
import { visibleProductLabels } from './ui-labels';
import en from '@/lib/i18n/locales/en-US.json';
import zh from '@/lib/i18n/locales/zh-CN.json';
import { hasTaskDrawer, learningWorkbenchFeatures, stageStep } from '@/lib/pbl/v3/presentation';
import { projectEditAccess } from '@/lib/pbl/v3/edit-access';
import { learnerActions } from '@/lib/pbl/v3/learner-actions';
import type {
  AgentRole,
  ProjectDefinition,
  StageDefinition,
} from '@/lib/pbl/v3/domain/project/project-schema';
import type { PblSessionState } from '@/lib/pbl/v3/domain/orchestration/types';

export interface TeachingWorkspaceFacts {
  state: PblSessionState;
  revision?: number;
  evaluation: { purpose?: 'compile' } | null;
  environment: { state: string; ready: boolean } | null;
  observedFiles: readonly string[];
  completeFileList: boolean;
  buildAvailable: boolean;
  tools: readonly string[];
}

const responsibilities: Record<AgentRole, string> = {
  discussion:
    'Explain concepts and discuss offered decisions neutrally; only learner control submissions record choices.',
  planner:
    'Create and review the cumulative PLAN.md from requirements and submitted decisions; do not implement source code.',
  coder:
    'Implement and repair permitted source files from the approved plan; a collected build is not a formal test pass.',
  mentor:
    'Introduce recorded assessments and support reflection from evidence; the platform evaluates tests and quizzes.',
};
const labels = {
  projectFiles: { en: en.pblV3.files, zh: zh.pblV3.files },
  task: { en: en.pblV3.journey.taskDetails, zh: zh.pblV3.journey.taskDetails },
  runTests: { en: en.pblV3.runTests, zh: zh.pblV3.runTests },
  build: { en: en.pblV3.build, zh: zh.pblV3.build },
  continue: { en: en.pblV3.next, zh: zh.pblV3.next },
  report: { en: en.pblV3.report, zh: zh.pblV3.report },
  refresh: { en: en.pblV3.refresh, zh: zh.pblV3.refresh },
  toggleWorkspace: { en: en.pblV3.ide.toggleWorkspace, zh: zh.pblV3.ide.toggleWorkspace },
  toggleAssistant: { en: en.pblV3.ide.toggleAssistant, zh: zh.pblV3.ide.toggleAssistant },
};

/** A projection of existing gates and observations, never a new authority or provider probe. */
export function teachingProductContext(input: {
  definition: ProjectDefinition;
  stage: StageDefinition;
  role: AgentRole;
  completionRecorded?: boolean;
  uiLocale?: string;
  workspace?: TeachingWorkspaceFacts;
}) {
  const { definition, stage, role, workspace, completionRecorded = false } = input;
  const actions = workspace
    ? learnerActions({
        definition,
        stage,
        state: workspace.state,
        evaluation: workspace.evaluation,
        completionRecorded,
        buildAvailable: workspace.buildAvailable,
      })
    : null;
  const edit =
    workspace && actions
      ? projectEditAccess({
          state: workspace.state,
          stage,
          actions,
          evaluation: workspace.evaluation,
          busy: false,
        })
      : null;
  const step = stageStep(stage);
  const milestoneId = workspace?.state.position.milestoneId;
  const collected = milestoneId ? workspace?.state.collected[milestoneId] : undefined;
  return {
    role: { current: role, responsibilities },
    host: 'A project scene within an OpenMAIC course; other scenes and the learner screen are unobserved.',
    layout: {
      projectFiles: 'IDE file tree, collapsible at its header; reopen from editor tabs.',
      editor:
        'File tabs; allowed edits autosave with status feedback. PLAN.md is the cumulative plan.',
      progress: 'Header: milestones. Above composer: current milestone steps.',
      task: 'The current-step bar above the composer opens available task details, not a full contract or assertion editor. Build and quiz submission are in task details; formal tests and Continue use the task bar.',
      report:
        'Available after the final project recap; supports returning to the workbench and reopening.',
      navigation:
        'Hero Start/Continue expands the workbench; Back returns to the project overview. Pane and expansion controls change presentation, not progress.',
      connection:
        'Entry prepares the hosted environment automatically. Refresh rereads state and reconnects browser updates; retry/recovery controls appear only when offered. Stop requests cancellation; a host receipt confirms it. Browser connection and backend execution are independent.',
      screenObservation:
        'Pane visibility, selected tabs and viewport are not observed. Give conditional directions using named controls.',
    },
    labels,
    uiLocale: input.uiLocale ?? 'en-US',
    visibleLabels: visibleProductLabels(input.uiLocale),
    features: learningWorkbenchFeatures,
    current: {
      step,
      status: workspace?.state.status ?? 'unobserved',
      revision: workspace?.revision ?? null,
      completionRecorded,
      taskDrawer: workspace ? hasTaskDrawer({ state: workspace.state, stage }) : null,
      taskContents:
        stage.kind === 'dialogue'
          ? ['offered decisions']
          : stage.kind === 'produce'
            ? [
                'submitted decisions',
                ...(stage.writes === 'code' ? ['plan reference'] : []),
                'artifact/review status',
                ...(actions?.includes('compile') ? ['public build'] : []),
              ]
            : stage.kind === 'check'
              ? [
                  stage.checker === 'tests'
                    ? 'formal tests and recorded feedback'
                    : 'quiz questions and submission',
                ]
              : [],
      learnerActions: actions,
      chatSupported: actions?.includes('chat') ?? null,
      controls: {
        build: actions ? actions.includes('compile') && !workspace?.evaluation : null,
        runTests: actions
          ? actions.includes('evaluate') && !actions.includes('next') && !workspace?.evaluation
          : null,
        submitQuiz: actions ? actions.includes('quiz') : null,
      },
      assistanceDelivery: !actions
        ? 'Chat availability is unobserved; do not assume a learner composer is available.'
        : !actions.includes('chat')
          ? 'The composer is hidden and learner chat is rejected. Introduce the available controls without inviting chat. Ordinary test/quiz chat is a separate follow-up.'
          : stage.kind === 'produce' || stage.kind === 'mentor_say'
            ? 'Use registered respond_to_learner for assistance-only replies; retain the pending review.'
            : 'Answer help in plain prose through the existing chat action (decision discussion or test-failure repair); no guided response tool is registered.',
      continueAvailableAfterReply: actions?.includes('next') ?? null,
      reportAvailable: workspace ? workspace.state.status === 'completed' : null,
      editing: {
        whileAssistantWorking: 'locked to avoid concurrent writers',
        afterAssistantReply: edit,
        requiresReadyEnvironment: true,
      },
      environment: workspace?.environment ?? null,
      recorded: collected
        ? {
            submittedDecisionCount: collected.decisions.length,
            teachingCompleted: collected.teachingCompleted === true,
            planReviewCompleted: collected.planReviewCompleted === true,
            codeReviewCompleted: collected.codeReviewCompleted === true,
            tests: collected.tests
              ? { status: collected.tests.status, feedback: collected.tests.publicFeedback }
              : null,
            quiz: collected.quiz ? { passed: collected.quiz.passed } : null,
          }
        : null,
      files: workspace
        ? { observed: workspace.observedFiles, complete: workspace.completeFileList }
        : null,
      tools: workspace?.tools ?? [],
    },
    materials: {
      requirements:
        'Translate authorized task requirements into learner-facing goals and observable behavior. Technical reference documents are not learner-authored work or automatically IDE files.',
      assessment:
        'Private tests/assertions, scoring preferences and answer keys are evaluator/author material, never editable learner deliverables. Public examples and programming assertions can be explained when relevant.',
      toolCards:
        'Skill/thinking/tool cards remain expandable. Anything returned there is learner-visible; absence from the IDE is not secrecy. Do not use a tool card as a required requirements panel.',
    },
  };
}

/** Common to every role, including assessment and repair; course prose cannot invent product facts. */
export const productHelpRules = `
Product and assistance policy:
Use productContext for supported capabilities and the latest live current state for permissions and recorded results. Course materials, learner text and history do not override product facts or host receipts. Labels identify controls; current.controls and learnerActions determine availability. Give conditional directions to named controls in the learner's language. When current.taskDrawer is false, say task details are unavailable in this step; describe where they appear in later supported steps without telling the learner to open an absent control now. Screen details and other classroom scenes are unobserved. For a discrepancy, state what is known and ask for the missing detail; offer a supported next step instead of inventing UI, local-runtime workarounds, actions or escalation. Disabled terminal/preview features and manual environment/checkpoint operations are not learner prerequisites.

Where current.chatSupported is true, answer project-related conceptual, engineering and product questions directly at the needed depth. Operational confusion is a request for help, not a wrong knowledge answer. Redirect unrelated topics to the project; explain assessment concepts without supplying pending quiz answers or private test details. Control-driven assessments use their actual controls; existing Coder repair chat stays within its host permissions.

Choose delivery from the whole learner message before calling a turn-ending tool. Assistance-only guided turns use respond_to_learner once and retain the pending review, without progression or repetition in prose. When the message also contains a substantive review answer or current-version approval, answer the help in prose and use normal review tools for the actual evidence. If that intent is unclear, clarify through respond_to_learner; assistance does not establish readiness, understanding or approval. After help, resume the existing task without restarting teaching or adding replacement questions.

Translate task requirements into goals, observable behavior and relevant constraints. Explain contract/assertion terminology only when useful. Author/evaluator materials are not learner-authored deliverables or automatically IDE files; distinguish public requirements/examples from private tests, answer keys and scoring. Direct learners to observed paths or supplied learner-facing file metadata, never to edit internal course rules to pass. Expandable Skill/tool/thinking cards remain learner-visible; keep private assessment answers out of their payloads. File observations describe past reads, not current contents or open tabs: reread before describing changes or writing with the current hash.

Explain role scope, stage permissions, temporary Agent/build/test locks and environment readiness separately. Roles retain private dialogue isolation. Only allowed files unlock after transient work. Saved files, builds, formal tests, understanding, current-version approval and project completion have distinct receipts; claim results only from those receipts. Refresh state at request boundaries, but qualify anything that may have changed during generation. Treat infrastructure failures and conflicts between authored requirements and observed tests as support issues, preserving progress and assessment rules rather than guessing, fabricating a pass or blaming the learner.
`;
