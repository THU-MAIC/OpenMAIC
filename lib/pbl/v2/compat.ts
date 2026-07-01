import type {
  PBLAgent,
  PBLChatMessage as LegacyPBLChatMessage,
  PBLIssue,
  PBLProjectConfig,
} from '@/lib/pbl/types';
import type { PBLChatMessage, PBLMilestoneStatus, PBLProjectV2, PBLRole } from './types';

const COMPAT_INSTRUCTOR_ROLE_ID = 'role-compat-instructor';
const COMPAT_LEARNER_AGENT_NAME = 'Learner';

export function projectV2ToLegacyProjectConfig(project: PBLProjectV2): PBLProjectConfig {
  const instructor = project.roles.find((role) => role.type === 'instructor') ?? project.roles[0];
  const instructorName = instructor?.name || 'Instructor';
  const issues = project.milestones.map((milestone, index): PBLIssue => {
    const activeTask =
      milestone.microtasks.find((task) => task.status === 'in_progress') ??
      milestone.microtasks.find((task) => task.status === 'todo') ??
      milestone.microtasks[0];
    return {
      id: legacyIssueId(milestone.id),
      title: milestone.title || `Stage ${index + 1}`,
      description: milestone.description || activeTask?.description || '',
      person_in_charge: COMPAT_LEARNER_AGENT_NAME,
      participants: [instructorName],
      notes: (milestone.documents ?? [])
        .map((document) => document.content)
        .filter(Boolean)
        .join('\n\n'),
      parent_issue: null,
      index,
      is_done: milestone.status === 'completed',
      is_active: milestone.status === 'active',
      generated_questions: [milestone.briefing, ...(activeTask?.hints ?? [])]
        .filter(Boolean)
        .join('\n'),
      question_agent_name: instructorName,
      judge_agent_name: instructorName,
    };
  });

  return {
    projectInfo: {
      title: project.title,
      description: project.description,
    },
    agents: [
      compatInstructorAgent(instructorName),
      {
        name: COMPAT_LEARNER_AGENT_NAME,
        actor_role: 'Learner',
        role_division: 'development',
        system_prompt: '',
        default_mode: 'idle',
        delay_time: 0,
        env: {},
        is_user_role: true,
        is_active: true,
        is_system_agent: false,
      },
    ],
    issueboard: {
      agent_ids: [instructorName],
      issues,
      current_issue_id: issues.find((issue) => issue.is_active)?.id ?? issues[0]?.id ?? null,
    },
    chat: {
      messages: [],
    },
    selectedRole: hasStartedProject(project) ? COMPAT_LEARNER_AGENT_NAME : null,
  };
}

export function upgradeLegacyPBLConfigToProjectV2(config: PBLProjectConfig): PBLProjectV2 {
  const now = new Date().toISOString();
  const language = detectLegacyLanguage(config);
  const instructorName = inferInstructorName(config);
  const instructorRole: PBLRole = {
    id: COMPAT_INSTRUCTOR_ROLE_ID,
    type: 'instructor',
    name: instructorName,
    description: 'Guides the learner through the upgraded legacy PBL project.',
  };
  const orderedIssues = config.issueboard.issues.slice().sort((a, b) => a.index - b.index);
  const activeIssueId = inferActiveIssueId(config);
  const allDone = orderedIssues.length > 0 && orderedIssues.every((issue) => issue.is_done);
  const hasLegacyRuntime =
    !!config.selectedRole ||
    config.chat.messages.length > 0 ||
    orderedIssues.some((issue) => issue.is_done);

  return {
    uiPhase: allDone ? 'completed' : hasLegacyRuntime ? 'workspace' : 'hero',
    title: config.projectInfo.title || 'Project',
    description: config.projectInfo.description || '',
    proficiency: '',
    language,
    tags: [],
    status: allDone ? 'completed' : 'active',
    roles: [instructorRole],
    milestones: orderedIssues.map((issue, index) => {
      const status = legacyIssueStatus(issue, index, orderedIssues, activeIssueId);
      return {
        id: legacyMilestoneId(issue.id),
        title: issue.title || `Task ${index + 1}`,
        description: issue.description || issue.notes || undefined,
        status,
        order: index,
        microtasks: [
          {
            id: legacyMicrotaskId(issue.id),
            title: issue.title || `Task ${index + 1}`,
            description: legacyMicrotaskDescription(issue),
            status:
              status === 'completed' ? 'completed' : status === 'active' ? 'in_progress' : 'todo',
            assignee: 'user',
            hints: issue.generated_questions ? [issue.generated_questions] : [],
            order: 0,
          },
        ],
        documents: issue.notes
          ? [
              {
                id: `doc_${issue.id}`,
                title: 'Legacy issue notes',
                content: issue.notes,
                docType: 'reference',
              },
            ]
          : [],
        briefing: issue.generated_questions || issue.description || issue.title,
        completionCriteria: legacyCompletionCriteria(language),
        debrief: legacyDebrief(language),
      };
    }),
    submissions: [],
    evaluations: [],
    threads: [
      {
        agentId: instructorRole.id,
        messages: config.chat.messages.map((message) => legacyChatMessage(message, config)),
      },
    ],
    engagementEvents: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function isEmptyLegacyPBLConfig(config: PBLProjectConfig): boolean {
  return (
    config.projectInfo.title === '' &&
    config.projectInfo.description === '' &&
    config.agents.length === 0 &&
    config.issueboard.issues.length === 0 &&
    config.chat.messages.length === 0
  );
}

function compatInstructorAgent(name: string): PBLAgent {
  return {
    name,
    actor_role: 'Instructor',
    role_division: 'management',
    system_prompt: '',
    default_mode: 'idle',
    delay_time: 0,
    env: {},
    is_user_role: false,
    is_active: true,
    is_system_agent: true,
  };
}

function hasStartedProject(project: PBLProjectV2): boolean {
  return (
    project.uiPhase !== 'hero' ||
    project.threads.some((thread) => thread.messages.length > 0) ||
    project.submissions.length > 0 ||
    project.evaluations.length > 0 ||
    project.engagementEvents.length > 0 ||
    project.milestones.some(
      (milestone) =>
        milestone.status === 'completed' ||
        milestone.microtasks.some(
          (microtask) => microtask.status === 'completed' || microtask.status === 'skipped',
        ),
    )
  );
}

function legacyIssueId(milestoneId: string): string {
  return `compat_issue_${milestoneId}`;
}

function legacyMilestoneId(issueId: string): string {
  return `legacy_ms_${issueId}`;
}

function legacyMicrotaskId(issueId: string): string {
  return `legacy_mt_${issueId}`;
}

function legacyIssueStatus(
  issue: PBLProjectConfig['issueboard']['issues'][number],
  index: number,
  issues: PBLProjectConfig['issueboard']['issues'],
  activeIssueId: string | null,
): PBLMilestoneStatus {
  if (issue.is_done) return 'completed';
  if (issue.id === activeIssueId) return 'active';

  const firstIncomplete = issues.find((candidate) => !candidate.is_done);
  if (!activeIssueId && (firstIncomplete ? issue.id === firstIncomplete.id : index === 0)) {
    return 'active';
  }
  return 'locked';
}

function legacyMicrotaskDescription(
  issue: PBLProjectConfig['issueboard']['issues'][number],
): string | undefined {
  return [issue.description, issue.notes ? `Notes: ${issue.notes}` : ''].filter(Boolean).join('\n');
}

function legacyChatMessage(
  message: LegacyPBLChatMessage,
  config: PBLProjectConfig,
): PBLChatMessage {
  const isUser = isLegacyUserMessage(message, config);
  return {
    id: message.id,
    agentId: isUser ? undefined : COMPAT_INSTRUCTOR_ROLE_ID,
    roleType: isUser ? 'user' : 'instructor',
    content: message.message,
    ts: new Date(message.timestamp || Date.now()).toISOString(),
  };
}

function isLegacyUserMessage(message: LegacyPBLChatMessage, config: PBLProjectConfig): boolean {
  const selectedRole =
    config.selectedRole?.trim() || config.agents.find((agent) => agent.is_user_role)?.name?.trim();
  if (selectedRole) return message.agent_name === selectedRole;
  const agentNames = new Set(config.agents.map((agent) => agent.name));
  return !agentNames.has(message.agent_name);
}

function inferInstructorName(config: PBLProjectConfig): string {
  const activeIssue =
    config.issueboard.issues.find((issue) => issue.is_active && !issue.is_done) ??
    config.issueboard.issues.find(
      (issue) => issue.id === config.issueboard.current_issue_id && !issue.is_done,
    );
  if (activeIssue?.question_agent_name) return activeIssue.question_agent_name;
  const questionAgent = config.agents.find((agent) =>
    agent.name.toLowerCase().includes('question'),
  );
  return questionAgent?.name || 'Instructor';
}

function inferActiveIssueId(config: PBLProjectConfig): string | null {
  const issues = config.issueboard.issues;
  return (
    issues.find((issue) => issue.is_active && !issue.is_done)?.id ??
    issues.find((issue) => issue.id === config.issueboard.current_issue_id && !issue.is_done)?.id ??
    null
  );
}

function detectLegacyLanguage(config: PBLProjectConfig): string {
  const sample = [
    config.projectInfo.title,
    config.projectInfo.description,
    ...config.issueboard.issues.flatMap((issue) => [
      issue.title,
      issue.description,
      issue.notes,
      issue.generated_questions,
    ]),
  ].join('\n');
  if (/[\u3040-\u30ff]/.test(sample)) return 'ja-JP';
  if (/[\uac00-\ud7af]/.test(sample)) return 'ko-KR';
  if (/[\u0600-\u06ff]/.test(sample)) return 'ar-SA';
  if (/[\u0400-\u04ff]/.test(sample)) return 'ru-RU';
  if (/[\u3400-\u9fff]/.test(sample)) return 'zh-CN';
  return 'en-US';
}

function legacyCompletionCriteria(language: string): string {
  return language.startsWith('zh')
    ? '学习者完成该任务，并能解释自己的解决思路。'
    : 'The learner completes this task and can explain their reasoning.';
}

function legacyDebrief(language: string): string {
  return language.startsWith('zh')
    ? '总结本任务的关键收获，并准备进入下一步。'
    : 'Summarize the key takeaways from this task and prepare for the next step.';
}
