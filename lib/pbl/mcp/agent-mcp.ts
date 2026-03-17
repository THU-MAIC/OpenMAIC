/**
 * Agent MCP - Manages project agent roles during PBL generation.
 *
 * Migrated from PBL-Nano. No HTML rendering, no list_tools(), no hardcoded model.
 * Operates directly on a shared PBLProjectConfig.
 */

import type { PBLProjectConfig, PBLAgent, PBLRoleDivision, PBLToolResult } from '../types';

export class AgentMCP {
  private config: PBLProjectConfig;

  constructor(config: PBLProjectConfig) {
    this.config = config;
  }

  listAgents(): PBLToolResult {
    return {
      success: true,
      agents: this.config.agents.map((a) => ({ ...a })),
      message: this.config.agents.length === 0 ? 'No agents found.' : undefined,
    };
  }

  getAgentInfo(name: string): PBLToolResult {
    const agent = this.config.agents.find((a) => a.name === name);
    if (!agent) {
      return { success: false, error: `Agent "${name}" not found.` };
    }
    return { success: true, agent: { ...agent } };
  }

  createAgent(params: {
    name: string;
    system_prompt: string;
    default_mode: string;
    delay_time?: number;
    actor_role?: string;
    role_division?: PBLRoleDivision;
    is_system_agent?: boolean;
  }): PBLToolResult {
    const {
      name,
      system_prompt,
      default_mode,
      delay_time = 0,
      actor_role = '',
      role_division = 'development',
      is_system_agent = false,
    } = params;

    if (!name?.trim()) {
      return { success: false, error: 'Agent name cannot be empty.' };
    }
    if (!system_prompt?.trim()) {
      return { success: false, error: 'System prompt cannot be empty.' };
    }
    if (this.config.agents.find((a) => a.name === name)) {
      return { success: false, error: `Agent "${name}" already exists.` };
    }

    const newAgent: PBLAgent = {
      name,
      actor_role,
      role_division,
      system_prompt,
      default_mode,
      delay_time,
      env: {
        chat: {
          max_tokens: 4096,
          system_prompt,
        },
      },
      is_user_role: false,
      is_active: false,
      is_system_agent,
    };

    this.config.agents.push(newAgent);
    return { success: true, message: `Agent "${name}" created successfully.` };
  }

  updateAgent(params: {
    name: string;
    new_name?: string;
    system_prompt?: string;
    default_mode?: string;
    delay_time?: number;
    actor_role?: string;
    role_division?: PBLRoleDivision;
  }): PBLToolResult {
    const agent = this.config.agents.find((a) => a.name === params.name);
    if (!agent) {
      return { success: false, error: `Agent "${params.name}" not found.` };
    }

    if (
      params.new_name &&
      params.new_name !== params.name &&
      this.config.agents.find((a) => a.name === params.new_name)
    ) {
      return {
        success: false,
        error: `Agent "${params.new_name}" already exists.`,
      };
    }

    if (params.new_name !== undefined) agent.name = params.new_name;
    if (params.system_prompt !== undefined) {
      agent.system_prompt = params.system_prompt;
      if (agent.env.chat && typeof agent.env.chat === 'object') {
        (agent.env.chat as Record<string, unknown>).system_prompt = params.system_prompt;
      }
    }
    if (params.default_mode !== undefined) agent.default_mode = params.default_mode;
    if (params.delay_time !== undefined) agent.delay_time = params.delay_time;
    if (params.actor_role !== undefined) agent.actor_role = params.actor_role;
    if (params.role_division !== undefined) agent.role_division = params.role_division;

    return { success: true, message: 'Agent updated successfully.' };
  }

  deleteAgent(name: string): PBLToolResult {
    const index = this.config.agents.findIndex((a) => a.name === name);
    if (index === -1) {
      return { success: false, error: `Agent "${name}" not found.` };
    }
    this.config.agents.splice(index, 1);
    return { success: true, message: 'Agent deleted successfully.' };
  }
}
