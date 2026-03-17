/**
 * Issueboard MCP - Manages issues and workflow during PBL generation.
 *
 * Migrated from PBL-Nano. Key changes:
 * - No Anthropic SDK dependency (initialize_question_agent removed)
 * - Question agent initialization is handled by generate-pbl.ts post-processing
 * - Operates directly on a shared PBLProjectConfig
 */

import type { PBLProjectConfig, PBLIssue, PBLToolResult } from '../types';
import { AgentMCP } from './agent-mcp';
import { getQuestionAgentPrompt, getJudgeAgentPrompt } from './agent-templates';

export class IssueboardMCP {
  private config: PBLProjectConfig;
  private agentMCP: AgentMCP;
  private language: string;
  private nextIssueId: number;

  constructor(config: PBLProjectConfig, agentMCP: AgentMCP, language: string = 'en-US') {
    this.config = config;
    this.agentMCP = agentMCP;
    this.language = language;
    this.nextIssueId = 1;
  }

  createIssueboard(): PBLToolResult {
    this.config.issueboard = {
      agent_ids: [],
      issues: [],
      current_issue_id: null,
    };
    this.nextIssueId = 1;
    return { success: true, message: 'Issueboard created successfully.' };
  }

  getIssueboard(): PBLToolResult {
    return {
      success: true,
      agent_ids: [...this.config.issueboard.agent_ids],
      issues: this.config.issueboard.issues.map((i) => ({ ...i })),
    };
  }

  updateIssueboardAgents(agentIds: string[]): PBLToolResult {
    this.config.issueboard.agent_ids = [...agentIds];
    return {
      success: true,
      message: 'Issueboard agents updated successfully.',
    };
  }

  createIssue(params: {
    title: string;
    description: string;
    person_in_charge: string;
    participants?: string[];
    notes?: string;
    parent_issue?: string | null;
    index?: number;
  }): PBLToolResult {
    const {
      title,
      description,
      person_in_charge,
      participants = [],
      notes = '',
      parent_issue = null,
      index = 0,
    } = params;

    if (!title?.trim()) {
      return { success: false, error: 'Title cannot be empty.' };
    }
    if (!person_in_charge?.trim()) {
      return { success: false, error: 'Person in charge cannot be empty.' };
    }
    if (parent_issue && !this.config.issueboard.issues.find((i) => i.id === parent_issue)) {
      return {
        success: false,
        error: `Parent issue "${parent_issue}" not found.`,
      };
    }

    const issueId = `issue_${this.nextIssueId++}`;
    const questionAgentName = `Question Agent - ${issueId}`;
    const judgeAgentName = `Judge Agent - ${issueId}`;

    const newIssue: PBLIssue = {
      id: issueId,
      title,
      description,
      person_in_charge,
      participants: [...participants],
      notes,
      parent_issue,
      index,
      is_done: false,
      is_active: false,
      generated_questions: '',
      question_agent_name: questionAgentName,
      judge_agent_name: judgeAgentName,
    };

    this.config.issueboard.issues.push(newIssue);

    // Auto-create question and judge agents
    this.agentMCP.createAgent({
      name: questionAgentName,
      system_prompt: getQuestionAgentPrompt(this.language),
      default_mode: 'chat',
      actor_role: 'Question Assistant for Issue',
      role_division: 'development',
      is_system_agent: true,
    });

    this.agentMCP.createAgent({
      name: judgeAgentName,
      system_prompt: getJudgeAgentPrompt(this.language),
      default_mode: 'chat',
      actor_role: 'Judge for Issue Completion',
      role_division: 'management',
      is_system_agent: true,
    });

    return {
      success: true,
      issue_id: issueId,
      message: 'Issue created with question and judge agents.',
    };
  }

  listIssues(): PBLToolResult {
    return {
      success: true,
      issues: this.config.issueboard.issues.map((i) => ({ ...i })),
    };
  }

  getIssue(issueId: string): PBLToolResult {
    const issue = this.config.issueboard.issues.find((i) => i.id === issueId);
    if (!issue) {
      return { success: false, error: `Issue "${issueId}" not found.` };
    }
    return { success: true, issues: [{ ...issue }] };
  }

  updateIssue(params: {
    issue_id: string;
    title?: string;
    description?: string;
    person_in_charge?: string;
    participants?: string[];
    notes?: string;
    parent_issue?: string | null;
    index?: number;
  }): PBLToolResult {
    const issue = this.config.issueboard.issues.find((i) => i.id === params.issue_id);
    if (!issue) {
      return { success: false, error: `Issue "${params.issue_id}" not found.` };
    }

    if (
      params.parent_issue !== undefined &&
      params.parent_issue !== null &&
      !this.config.issueboard.issues.find((i) => i.id === params.parent_issue)
    ) {
      return {
        success: false,
        error: `Parent issue "${params.parent_issue}" not found.`,
      };
    }

    if (params.title !== undefined) issue.title = params.title;
    if (params.description !== undefined) issue.description = params.description;
    if (params.person_in_charge !== undefined) issue.person_in_charge = params.person_in_charge;
    if (params.participants !== undefined) issue.participants = [...params.participants];
    if (params.notes !== undefined) issue.notes = params.notes;
    if (params.parent_issue !== undefined) issue.parent_issue = params.parent_issue;
    if (params.index !== undefined) issue.index = params.index;

    return { success: true, message: 'Issue updated successfully.' };
  }

  deleteIssue(issueId: string): PBLToolResult {
    const index = this.config.issueboard.issues.findIndex((i) => i.id === issueId);
    if (index === -1) {
      return { success: false, error: `Issue "${issueId}" not found.` };
    }
    this.config.issueboard.issues.splice(index, 1);
    // Remove child issues
    this.config.issueboard.issues = this.config.issueboard.issues.filter(
      (i) => i.parent_issue !== issueId,
    );
    return { success: true, message: 'Issue deleted successfully.' };
  }

  reorderIssues(issueIds: string[]): PBLToolResult {
    for (const id of issueIds) {
      if (!this.config.issueboard.issues.find((i) => i.id === id)) {
        return { success: false, error: `Issue "${id}" not found.` };
      }
    }

    const reordered: PBLIssue[] = [];
    for (let i = 0; i < issueIds.length; i++) {
      const issue = this.config.issueboard.issues.find((iss) => iss.id === issueIds[i])!;
      issue.index = i;
      reordered.push(issue);
    }
    // Append any issues not in the reorder list
    for (const issue of this.config.issueboard.issues) {
      if (!issueIds.includes(issue.id)) {
        reordered.push(issue);
      }
    }
    this.config.issueboard.issues = reordered;
    return { success: true, message: 'Issues reordered successfully.' };
  }

  activateNextIssue(): PBLToolResult {
    // Deactivate current
    const current = this.config.issueboard.issues.find((i) => i.is_active);
    if (current) {
      current.is_active = false;
      this.config.issueboard.current_issue_id = null;
    }

    // Find next incomplete issue
    const next = this.config.issueboard.issues
      .filter((i) => !i.is_done)
      .sort((a, b) => a.index - b.index)[0];

    if (!next) {
      return { success: false, error: 'No more issues to activate.' };
    }

    next.is_active = true;
    this.config.issueboard.current_issue_id = next.id;
    return {
      success: true,
      issue_id: next.id,
      message: `Activated issue: ${next.title}`,
    };
  }

  completeCurrentIssue(): PBLToolResult {
    const current = this.config.issueboard.issues.find((i) => i.is_active);
    if (!current) {
      return { success: false, error: 'No active issue to complete.' };
    }
    current.is_done = true;
    current.is_active = false;
    this.config.issueboard.current_issue_id = null;
    return {
      success: true,
      message: `Issue "${current.id}" marked as complete.`,
    };
  }
}
