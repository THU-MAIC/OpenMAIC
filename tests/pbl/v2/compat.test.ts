import { describe, expect, it } from 'vitest';
import type { PBLProjectConfig } from '@/lib/pbl/types';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import {
  isEmptyLegacyPBLConfig,
  projectV2ToLegacyProjectConfig,
  upgradeLegacyPBLConfigToProjectV2,
} from '@/lib/pbl/v2/compat';

function makeProject(): PBLProjectV2 {
  const now = '2026-06-09T00:00:00.000Z';
  return {
    uiPhase: 'workspace',
    title: 'Build a Weather Dashboard',
    description: 'Use API data to render a dashboard.',
    proficiency: 'beginner',
    language: 'en-US',
    tags: ['api'],
    status: 'active',
    roles: [
      {
        id: 'role-instructor',
        type: 'instructor',
        name: 'Instructor',
      },
    ],
    milestones: [
      {
        id: 'ms-1',
        title: 'Read the API',
        description: 'Inspect the response shape.',
        status: 'active',
        order: 0,
        microtasks: [
          {
            id: 'mt-1',
            title: 'Find fields',
            description: 'Identify temperature and condition.',
            status: 'in_progress',
            assignee: 'user',
            hints: ['Look for nested objects.'],
            order: 0,
          },
        ],
        documents: [
          {
            id: 'doc-1',
            title: 'Sample payload',
            content: '{"temperature":20}',
            docType: 'reference',
          },
        ],
        briefing: 'Start by reading the sample response.',
      },
    ],
    submissions: [],
    evaluations: [],
    threads: [
      {
        agentId: 'role-instructor',
        messages: [],
      },
    ],
    engagementEvents: [],
    createdAt: now,
    updatedAt: now,
  };
}

function makeLegacyConfig(): PBLProjectConfig {
  return {
    projectInfo: {
      title: '天气数据项目',
      description: '分析天气数据并完成展示。',
    },
    agents: [
      {
        name: 'Question Agent',
        actor_role: 'Coach',
        role_division: 'management',
        system_prompt: 'Ask useful questions.',
        default_mode: 'idle',
        delay_time: 0,
        env: {},
        is_user_role: false,
        is_active: true,
        is_system_agent: true,
      },
      {
        name: 'Learner',
        actor_role: 'Student',
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
      agent_ids: ['Question Agent'],
      current_issue_id: 'issue-2',
      issues: [
        {
          id: 'issue-1',
          title: '读取数据',
          description: '打开数据文件。',
          person_in_charge: 'Learner',
          participants: ['Question Agent'],
          notes: 'CSV 文件包含天气字段。',
          parent_issue: null,
          index: 0,
          is_done: true,
          is_active: false,
          generated_questions: '你看到哪些字段？',
          question_agent_name: 'Question Agent',
          judge_agent_name: 'Judge Agent',
        },
        {
          id: 'issue-2',
          title: '解释结果',
          description: '说明图表含义。',
          person_in_charge: 'Learner',
          participants: ['Question Agent'],
          notes: '',
          parent_issue: null,
          index: 1,
          is_done: false,
          is_active: true,
          generated_questions: '图表说明了什么？',
          question_agent_name: 'Question Agent',
          judge_agent_name: 'Judge Agent',
        },
      ],
    },
    chat: {
      messages: [
        {
          id: 'legacy-msg-1',
          agent_name: 'Question Agent',
          message: '你看到哪些字段？',
          timestamp: 1780272000000,
          read_by: [],
        },
        {
          id: 'legacy-msg-2',
          agent_name: 'Learner',
          message: '我看到了温度字段。',
          timestamp: 1780272001000,
          read_by: [],
        },
      ],
    },
    selectedRole: 'Learner',
  };
}

describe('PBL v2 compatibility projection', () => {
  it('projects a v2 project to a non-empty legacy projectConfig', () => {
    const config = projectV2ToLegacyProjectConfig(makeProject());

    expect(config.projectInfo.title).toBe('Build a Weather Dashboard');
    expect(config.agents.map((agent) => agent.name)).toEqual(['Instructor', 'Learner']);
    expect(config.issueboard.issues).toHaveLength(1);
    expect(config.issueboard.issues[0]).toMatchObject({
      title: 'Read the API',
      is_active: true,
      question_agent_name: 'Instructor',
    });
    expect(config.issueboard.issues[0].generated_questions).toContain('Start by reading');
    expect(isEmptyLegacyPBLConfig(config)).toBe(false);
  });

  it('upgrades legacy v1 projectConfig to a full v2 project', () => {
    const project = upgradeLegacyPBLConfigToProjectV2(makeLegacyConfig());

    expect(project.title).toBe('天气数据项目');
    expect(project.language).toBe('zh-CN');
    expect(project.uiPhase).toBe('workspace');
    expect(project.roles).toEqual([
      expect.objectContaining({ type: 'instructor', name: 'Question Agent' }),
    ]);
    expect(project.milestones.map((milestone) => milestone.status)).toEqual([
      'completed',
      'active',
    ]);
    expect(project.milestones[1].microtasks[0].status).toBe('in_progress');
    expect(project.threads[0].messages.map((message) => message.roleType)).toEqual([
      'instructor',
      'user',
    ]);
  });

  it('uses current_issue_id when legacy is_active is missing', () => {
    const config = makeLegacyConfig();
    config.issueboard.issues.forEach((issue) => {
      issue.is_done = false;
      issue.is_active = false;
    });
    config.issueboard.current_issue_id = 'issue-2';

    const project = upgradeLegacyPBLConfigToProjectV2(config);

    expect(project.milestones.map((milestone) => milestone.status)).toEqual(['locked', 'active']);
  });

  it('keeps fresh legacy v1 projects on the hero even when the issueboard has an active issue', () => {
    const config = makeLegacyConfig();
    config.selectedRole = null;
    config.chat.messages = [];
    config.issueboard.current_issue_id = 'issue-1';
    config.issueboard.issues.forEach((issue, index) => {
      issue.is_done = false;
      issue.is_active = index === 0;
    });

    const project = upgradeLegacyPBLConfigToProjectV2(config);

    expect(project.uiPhase).toBe('hero');
    expect(project.threads[0].messages).toEqual([]);
    expect(project.milestones.map((milestone) => milestone.status)).toEqual(['active', 'locked']);
  });
});
