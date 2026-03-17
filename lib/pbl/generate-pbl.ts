/**
 * PBL Generation - Agentic Loop using Vercel AI SDK
 *
 * Core generation engine that designs a complete PBL project through
 * multi-step tool calling with generateText + stopWhen.
 *
 * Replaces PBL-Nano's Anthropic SDK direct calls with Vercel AI SDK
 * for multi-model compatibility.
 */

import { tool, stepCountIs } from 'ai';
import { callLLM } from '@/lib/ai/llm';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { PBLProjectConfig } from './types';
import { ModeMCP } from './mcp/mode-mcp';
import { ProjectMCP } from './mcp/project-mcp';
import { AgentMCP } from './mcp/agent-mcp';
import { IssueboardMCP } from './mcp/issueboard-mcp';
import { buildPBLSystemPrompt } from './pbl-system-prompt';
import type { PBLMode } from './types';

export interface GeneratePBLConfig {
  projectTopic: string;
  projectDescription: string;
  targetSkills: string[];
  issueCount?: number;
  language: string;
}

export interface GeneratePBLCallbacks {
  onProgress?: (message: string) => void;
}

/**
 * Generate a complete PBL project configuration using an agentic loop.
 *
 * Uses Vercel AI SDK's generateText with tools and stopWhen to drive
 * a multi-step conversation where the LLM designs the project by
 * calling MCP tools.
 */
export async function generatePBLContent(
  config: GeneratePBLConfig,
  model: LanguageModel,
  callbacks?: GeneratePBLCallbacks,
): Promise<PBLProjectConfig> {
  const { language } = config;

  // Initialize shared state
  const projectConfig: PBLProjectConfig = {
    projectInfo: { title: '', description: '' },
    agents: [],
    issueboard: { agent_ids: [], issues: [], current_issue_id: null },
    chat: { messages: [] },
  };

  // Create MCP instances operating on shared state
  const modeMCP = new ModeMCP(
    ['project_info', 'agent', 'issueboard', 'idle'] as PBLMode[],
    'project_info' as PBLMode,
  );
  const projectMCP = new ProjectMCP(projectConfig);
  const agentMCP = new AgentMCP(projectConfig);
  const issueboardMCP = new IssueboardMCP(projectConfig, agentMCP, language);

  callbacks?.onProgress?.('Starting PBL project generation...');

  // Define tools with Zod schemas, delegating to MCP instances
  const pblTools = {
    set_mode: tool({
      description:
        'Switch the current working mode. Available modes: project_info, agent, issueboard, idle.',
      inputSchema: z.object({
        mode: z.enum(['project_info', 'agent', 'issueboard', 'idle']),
      }),
      execute: async ({ mode }) => modeMCP.setMode(mode as PBLMode),
    }),

    // Project info tools
    get_project_info: tool({
      description:
        'Get the current project information (title and description). Requires project_info mode.',
      inputSchema: z.object({}),
      execute: async () => {
        if (modeMCP.getCurrentMode() !== 'project_info') {
          return { success: false, error: 'Must be in project_info mode.' };
        }
        return projectMCP.getProjectInfo();
      },
    }),
    update_title: tool({
      description: 'Update the project title. Requires project_info mode.',
      inputSchema: z.object({
        title: z.string().describe('The new project title'),
      }),
      execute: async ({ title }) => {
        if (modeMCP.getCurrentMode() !== 'project_info') {
          return { success: false, error: 'Must be in project_info mode.' };
        }
        return projectMCP.updateTitle(title);
      },
    }),
    update_description: tool({
      description: 'Update the project description. Requires project_info mode.',
      inputSchema: z.object({
        description: z.string().describe('The new project description'),
      }),
      execute: async ({ description }) => {
        if (modeMCP.getCurrentMode() !== 'project_info') {
          return { success: false, error: 'Must be in project_info mode.' };
        }
        return projectMCP.updateDescription(description);
      },
    }),

    // Agent tools
    list_project_agents: tool({
      description: 'List all agent roles defined for the project. Requires agent mode.',
      inputSchema: z.object({}),
      execute: async () => {
        if (modeMCP.getCurrentMode() !== 'agent') {
          return { success: false, error: 'Must be in agent mode.' };
        }
        return agentMCP.listAgents();
      },
    }),
    create_agent: tool({
      description: 'Create a new agent role for the project. Requires agent mode.',
      inputSchema: z.object({
        name: z.string().describe('Agent name (e.g., "Data Analyst", "Project Manager")'),
        system_prompt: z.string().describe("System prompt describing the agent's responsibilities"),
        default_mode: z.string().describe('Default environment mode (e.g., "chat")'),
        actor_role: z.string().optional().describe('Role description'),
        role_division: z
          .enum(['management', 'development'])
          .optional()
          .describe('Role division (default: development)'),
      }),
      execute: async (params) => {
        if (modeMCP.getCurrentMode() !== 'agent') {
          return { success: false, error: 'Must be in agent mode.' };
        }
        return agentMCP.createAgent(params);
      },
    }),
    update_agent: tool({
      description: "Update an agent role's properties. Requires agent mode.",
      inputSchema: z.object({
        name: z.string().describe('The agent name to update'),
        new_name: z.string().optional().describe('New agent name'),
        system_prompt: z.string().optional().describe('New system prompt'),
        default_mode: z.string().optional().describe('New default mode'),
        actor_role: z.string().optional().describe('New role description'),
        role_division: z.enum(['management', 'development']).optional(),
      }),
      execute: async (params) => {
        if (modeMCP.getCurrentMode() !== 'agent') {
          return { success: false, error: 'Must be in agent mode.' };
        }
        return agentMCP.updateAgent(params);
      },
    }),
    delete_agent: tool({
      description: 'Delete an agent role. Requires agent mode.',
      inputSchema: z.object({
        name: z.string().describe('The agent name to delete'),
      }),
      execute: async ({ name }) => {
        if (modeMCP.getCurrentMode() !== 'agent') {
          return { success: false, error: 'Must be in agent mode.' };
        }
        return agentMCP.deleteAgent(name);
      },
    }),

    // Issueboard tools
    create_issueboard: tool({
      description: 'Create/reset the issueboard. Requires issueboard mode.',
      inputSchema: z.object({}),
      execute: async () => {
        if (modeMCP.getCurrentMode() !== 'issueboard') {
          return { success: false, error: 'Must be in issueboard mode.' };
        }
        return issueboardMCP.createIssueboard();
      },
    }),
    get_issueboard: tool({
      description: 'Get the current issueboard configuration. Requires issueboard mode.',
      inputSchema: z.object({}),
      execute: async () => {
        if (modeMCP.getCurrentMode() !== 'issueboard') {
          return { success: false, error: 'Must be in issueboard mode.' };
        }
        return issueboardMCP.getIssueboard();
      },
    }),
    update_issueboard_agents: tool({
      description: 'Update the agent list for the issueboard. Requires issueboard mode.',
      inputSchema: z.object({
        agent_ids: z.array(z.string()).describe('List of agent names to assign'),
      }),
      execute: async ({ agent_ids }) => {
        if (modeMCP.getCurrentMode() !== 'issueboard') {
          return { success: false, error: 'Must be in issueboard mode.' };
        }
        return issueboardMCP.updateIssueboardAgents(agent_ids);
      },
    }),
    create_issue: tool({
      description:
        'Create a new issue in the issueboard. Automatically creates Question and Judge agents. Requires issueboard mode.',
      inputSchema: z.object({
        title: z.string().describe('Issue title'),
        description: z.string().describe('Issue description'),
        person_in_charge: z.string().describe('Person responsible (use an agent role name)'),
        participants: z.array(z.string()).optional().describe('Participant names'),
        notes: z.string().optional().describe('Additional notes'),
        parent_issue: z.string().nullable().optional().describe('Parent issue ID for sub-issues'),
        index: z.number().optional().describe('Order index'),
      }),
      execute: async (params) => {
        if (modeMCP.getCurrentMode() !== 'issueboard') {
          return { success: false, error: 'Must be in issueboard mode.' };
        }
        return issueboardMCP.createIssue(params);
      },
    }),
    list_issues: tool({
      description: 'List all issues in the issueboard. Requires issueboard mode.',
      inputSchema: z.object({}),
      execute: async () => {
        if (modeMCP.getCurrentMode() !== 'issueboard') {
          return { success: false, error: 'Must be in issueboard mode.' };
        }
        return issueboardMCP.listIssues();
      },
    }),
    update_issue: tool({
      description: 'Update an existing issue. Requires issueboard mode.',
      inputSchema: z.object({
        issue_id: z.string().describe('The issue ID to update'),
        title: z.string().optional(),
        description: z.string().optional(),
        person_in_charge: z.string().optional(),
        participants: z.array(z.string()).optional(),
        notes: z.string().optional(),
        parent_issue: z.string().nullable().optional(),
        index: z.number().optional(),
      }),
      execute: async (params) => {
        if (modeMCP.getCurrentMode() !== 'issueboard') {
          return { success: false, error: 'Must be in issueboard mode.' };
        }
        return issueboardMCP.updateIssue(params);
      },
    }),
    delete_issue: tool({
      description: 'Delete an issue and its sub-issues. Requires issueboard mode.',
      inputSchema: z.object({
        issue_id: z.string().describe('The issue ID to delete'),
      }),
      execute: async ({ issue_id }) => {
        if (modeMCP.getCurrentMode() !== 'issueboard') {
          return { success: false, error: 'Must be in issueboard mode.' };
        }
        return issueboardMCP.deleteIssue(issue_id);
      },
    }),
    reorder_issues: tool({
      description: 'Reorder issues. Requires issueboard mode.',
      inputSchema: z.object({
        issue_ids: z.array(z.string()).describe('Issue IDs in desired order'),
      }),
      execute: async ({ issue_ids }) => {
        if (modeMCP.getCurrentMode() !== 'issueboard') {
          return { success: false, error: 'Must be in issueboard mode.' };
        }
        return issueboardMCP.reorderIssues(issue_ids);
      },
    }),
  };

  // Run the agentic loop
  const systemPrompt = buildPBLSystemPrompt(config);

  const _result = await callLLM(
    {
      model,
      system: systemPrompt,
      prompt:
        language === 'zh-CN'
          ? `请设计一个PBL项目。现在从 project_info 模式开始，先设置项目标题和描述。`
          : `Design a PBL project. Start in project_info mode by setting the project title and description.`,
      tools: pblTools,
      stopWhen: stepCountIs(30),
      onStepFinish: ({ toolCalls, text }) => {
        if (text) {
          callbacks?.onProgress?.(`Thinking: ${text.slice(0, 100)}...`);
        }
        if (toolCalls) {
          for (const tc of toolCalls) {
            callbacks?.onProgress?.(`Tool: ${tc.toolName}`);
          }
        }
      },
    },
    'pbl-generate',
  );

  // Check if mode reached idle; if not, the LLM may have stopped early
  if (modeMCP.getCurrentMode() !== 'idle') {
    callbacks?.onProgress?.(
      'Warning: Generation did not reach idle mode. Project may be incomplete.',
    );
  }

  callbacks?.onProgress?.('PBL structure generated. Running post-processing...');

  // Post-processing: activate first issue and generate initial questions
  await postProcessPBL(projectConfig, model, language, callbacks);

  callbacks?.onProgress?.('PBL project generation complete!');

  return projectConfig;
}

/**
 * Post-processing after the agentic loop:
 * 1. Activate the first issue
 * 2. Generate initial questions for it using the Question Agent
 * 3. Add welcome message to chat
 */
async function postProcessPBL(
  config: PBLProjectConfig,
  model: LanguageModel,
  language: string,
  callbacks?: GeneratePBLCallbacks,
): Promise<void> {
  const { issueboard, agents } = config;

  if (issueboard.issues.length === 0) {
    return;
  }

  // Sort by index and activate first
  const sortedIssues = [...issueboard.issues].sort((a, b) => a.index - b.index);
  const firstIssue = sortedIssues[0];
  firstIssue.is_active = true;
  issueboard.current_issue_id = firstIssue.id;

  callbacks?.onProgress?.(`Activating first issue: ${firstIssue.title}`);

  // Generate initial questions for the first issue
  const questionAgent = agents.find((a) => a.name === firstIssue.question_agent_name);
  if (!questionAgent) {
    callbacks?.onProgress?.('Warning: Question agent not found for first issue.');
    return;
  }

  try {
    callbacks?.onProgress?.('Generating initial questions for first issue...');

    const context =
      language === 'zh-CN'
        ? `## 任务信息

**标题**: ${firstIssue.title}
**描述**: ${firstIssue.description}
**负责人**: ${firstIssue.person_in_charge}
${firstIssue.participants.length > 0 ? `**参与者**: ${firstIssue.participants.join('、')}` : ''}
${firstIssue.notes ? `**备注**: ${firstIssue.notes}` : ''}

## 你的任务

根据以上任务信息，生成1-3个具体、可操作的引导问题，帮助学生理解和完成这个任务。每个问题应：
- 引导学生达成关键学习目标
- 具体且可操作
- 帮助分解问题
- 鼓励批判性思考

请以编号列表格式回答。`
        : `## Issue Information

**Title**: ${firstIssue.title}
**Description**: ${firstIssue.description}
**Person in Charge**: ${firstIssue.person_in_charge}
${firstIssue.participants.length > 0 ? `**Participants**: ${firstIssue.participants.join(', ')}` : ''}
${firstIssue.notes ? `**Notes**: ${firstIssue.notes}` : ''}

## Your Task

Based on the issue information above, generate 1-3 specific, actionable questions that will help students understand and complete this issue. Each question should:
- Guide students toward key learning objectives
- Be specific and actionable
- Help break down the problem
- Encourage critical thinking

Format your response as a numbered list.`;

    const questionResult = await callLLM(
      {
        model,
        system: questionAgent.system_prompt,
        prompt: context,
      },
      'pbl-post-process',
    );

    const generatedQuestions = questionResult.text;
    firstIssue.generated_questions = generatedQuestions;

    // Add welcome message to chat
    const welcomeMessage =
      language === 'zh-CN'
        ? `你好！我是这个任务的提问助手："${firstIssue.title}"\n\n为了引导你的学习，我准备了一些问题：\n\n${generatedQuestions}\n\n随时 @question 我来获取帮助或澄清！`
        : `Hello! I'm your Question Agent for this issue: "${firstIssue.title}"\n\nTo help guide your work, I've prepared some questions for you:\n\n${generatedQuestions}\n\nFeel free to @question me anytime if you need help or clarification!`;

    config.chat.messages.push({
      id: `msg_welcome_${Date.now()}`,
      agent_name: firstIssue.question_agent_name,
      message: welcomeMessage,
      timestamp: Date.now(),
      read_by: [],
    });

    callbacks?.onProgress?.('Initial questions generated and welcome message added.');
  } catch (error) {
    callbacks?.onProgress?.(
      `Warning: Failed to generate initial questions: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
