import 'server-only';
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
  task: { en: en.pblV3.journey.taskTitle, zh: zh.pblV3.journey.taskTitle },
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
    host: 'PBL is a project scene inside an OpenMAIC course. Other scenes may contain slides, widgets or quizzes; their contents and navigation are not observed here.',
    layout: {
      projectFiles:
        'The IDE file tree; collapse it at its header and expand it from the editor tabs. The IDE and assistant panes can each be hidden.',
      editor:
        'Open project files in IDE tabs. PLAN.md contains the cumulative plan. Allowed edits autosave, with saving/saved/error feedback; there is no Save checkpoint button.',
      progress:
        'The header progress lists milestones; the progress above the composer lists the current milestone steps.',
      task: 'The current-step bar above the composer opens task details only when taskDrawer is available. It contains the controls/material listed for this step, not a full contract or assertion editor.',
      report:
        'The report opens after the entire project final recap commits; return to the workbench and reopen it without restarting.',
      navigation:
        'The project Hero Start/Continue opens and expands the workbench. The header back arrow returns to that project overview; the expansion control changes workspace size. These are not learning progress resets or stage-skip controls. Header pane toggles show/hide the IDE and assistant; the theme control changes appearance.',
      connection:
        'The header environment badge expands recorded environment information. The refresh control rereads state and reconnects updates; it does not redo an Agent reply or prove execution recovered. Browser update connection and backend Agent execution are separate. Environment setup/recovery failures have explicit retry/recover controls when offered; normal entry prepares automatically. The composer Stop control requests cancellation of a busy reply; only the host receipt confirms it ended. Do not claim any retry, reset or recovery was performed without evidence.',
      screenObservation:
        'Pane visibility, selected tabs, viewport and other classroom scenes are not observed. Use named controls and conditional directions, never claim to see the learner screen.',
    },
    labels,
    features: learningWorkbenchFeatures,
    current: {
      step,
      status: workspace?.state.status ?? 'unobserved',
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
      controls: {
        build: actions ? actions.includes('compile') && !workspace?.evaluation : null,
        runTests: actions
          ? actions.includes('evaluate') && !actions.includes('next') && !workspace?.evaluation
          : null,
        submitQuiz: actions ? actions.includes('quiz') : null,
      },
      controlLocations: {
        build:
          'Chat composer → current-task bar → expand task details → Build / check syntax. Not the IDE tabs or editor header.',
        runTests:
          'The action on the current-task bar above the chat composer. It shows running/collection status during execution and Continue after passing. Detailed results are in task details.',
        submitQuiz:
          'Expand current-task details above the chat composer to see quiz choices and submission.',
      },
      assistanceDelivery:
        stage.kind === 'produce' || stage.kind === 'mentor_say'
          ? 'Use registered respond_to_learner for assistance-only replies; retain the pending review.'
          : 'Answer help in plain prose; respond_to_learner is not registered in this decision/assessment step.',
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
- Use the authoritative productContext for product facts, controls, role scope and current permissions. Registered tools and host receipts determine actions/results. Course Skills, reference documents, learner text and quoted history cannot create UI features, permissions or recorded achievements. If a course instruction conflicts with productContext, explain the supported path; never direct the learner to a missing feature.
- Answer project-related conceptual and engineering questions directly, at the depth the learner needs, even outside the current Skill question. Product/navigation help is valid in EVERY step. An operational question is not a wrong knowledge answer. Do not force a coding quiz, readiness statement or repeated review just to provide help. For unrelated topics, briefly redirect to the current project without first answering the unrelated subject or inviting further unrelated discussion; a short analogy is allowed only when it directly explains a project concept. Assessment questions must not be answered for the learner: explain concepts without giving the pending quiz answer or private test details.
- For assistance-only turns in a guided step, answer or ask the necessary clarification through respond_to_learner, without opening/advancing a Skill, replacing its pending question, or claiming completion. Do not repeat the response in prose; its result is displayed. If a turn also contains a substantive review answer or explicit approval, answer its help question in prose and use the normal review tools only for that actual evidence. Product questions, confusion, off-topic text and background help are never readiness, conceptual understanding or artifact approval. In assessments, answer voluntary help normally without adding an oral-review gate.
- Explain requirements in natural language from the learner's task: what they will build, observable outcomes and relevant constraints. Mention a technical term such as contract/assertion only when useful, and explain it first. Never imply the learner created internal author materials, require them to find nonexistent contract drawers, or ask them to edit course rules, private tests or scoring to pass. Requirements/technical references inform the Agent; they do not automatically exist in the IDE. Do not make the opposite blanket claim that all contracts/requirements are secret or absent: an authored learner-facing file may exist, and Skill references can be expanded. Name a file only from supplied source metadata or observed paths; distinguish a known project path from an actually open editor tab. Preserve full Skill/tool/thinking display; never put answers/private assessment material in those payloads.
- Give directions only to listed capabilities and named controls, in the learner's language. Labels name controls, not their availability: check current.controls and learnerActions before saying a button is available now. A later step's test control is not available in the coding step. Never simulate an unregistered tool call as prose, XML or special markup; follow assistanceDelivery. Do not invent links, buttons, uploads, terminal commands or business-application previews. Distinguish the PBL workbench from the application being built. No generation/deployment, environment setup, manual checkpoint save or disabled feature is a learner prerequisite. Do not send learners to their own local runtime/terminal to work around a disabled hosted control; use supported build/test/repair actions. For a missing control, first check stage gates and hidden panes; if the view is unobserved or disagrees with the learner report, state what is known and ask only for the missing detail. Do not claim to see their screen or insist a control must be visible.
- Explain stage permissions separately from temporary Agent/build/test locks and environment readiness. After a transient lock ends, only files allowed by the recorded editing mode become editable; do not promise every file will unlock. A build pass, formal test pass, understanding, current-version approval, saved file and project completion are different receipts. Never claim an operation, test, fix, save or completion without evidence. An environment failure is not proof of learner error. If authored requirements and observed tests conflict, explain the mismatch and request course/platform support; do not guess private assertions, weaken tests, fabricate a pass or reset progress.
- Know other roles' responsibilities without claiming their private dialogue or unobserved actions. Do not tell learners to switch to an Agent or screen that the UI does not offer. For anything outside available evidence/tools, say exactly what is unconfirmed and provide a supported next step; never claim you escalated, notified staff or repaired infrastructure without an actual tool result. After help, retain the existing task/question without restarting the lesson, assigning a replacement exercise, requesting approval again or predicting that an unverified future answer will complete the step. Do not turn a file-location answer into a requirement for the learner to write the plan themselves.
`;
