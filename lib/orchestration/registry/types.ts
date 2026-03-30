/**
 * Agent Configuration Types
 * Defines the structure for configurable AI agents in the multi-agent system
 */

import type { TTSProviderId } from '@/lib/audio/types';

export interface AgentConfig {
  id: string; // Unique agent ID
  name: string; // Display name (Chinese)
  role: string; // Short role description
  persona: string; // Full system prompt (personality, responsibilities)
  avatar: string; // Emoji or image URL
  color: string; // UI theme color (hex)
  allowedActions: string[]; // Action types this agent can use
  priority: number; // Priority for director selection (1-10)
  voiceConfig?: { providerId: TTSProviderId; modelId?: string; voiceId: string }; // Per-agent TTS voice selection

  // Metadata
  createdAt: Date;
  updatedAt: Date;
  isDefault: boolean; // Is this a default template?

  // LLM-generated agent fields
  isGenerated?: boolean; // true for LLM-generated agents
  boundStageId?: string; // stage ID this agent was generated for
}

export interface AgentTemplate {
  // Same as AgentConfig but without id/dates (for creating new agents)
  name: string;
  role: string;
  persona: string;
  avatar: string;
  color: string;
  allowedActions: string[];
  priority: number;
  voiceConfig?: { providerId: TTSProviderId; modelId?: string; voiceId: string }; // Per-agent TTS voice selection

  // LLM-generated agent fields
  isGenerated?: boolean; // true for LLM-generated agents
  boundStageId?: string; // stage ID this agent was generated for
}

/**
 * Create a new AgentConfig from a template
 */
export function createAgentFromTemplate(template: AgentTemplate, id: string): AgentConfig {
  return {
    id,
    ...template,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: false,
  };
}

// Action types available to agents (canonical source for role-based mapping)
export const WHITEBOARD_ACTIONS = [
  'wb_open',
  'wb_close',
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_chart',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_clear',
  'wb_delete',
];

export const SLIDE_ACTIONS = ['spotlight', 'laser', 'play_video'];

/**
 * Maps agent roles to their allowed action sets.
 * Teachers get slide + whiteboard control; others get whiteboard only.
 */
export const ROLE_ACTIONS: Record<string, string[]> = {
  teacher: [...SLIDE_ACTIONS, ...WHITEBOARD_ACTIONS],
  assistant: [...WHITEBOARD_ACTIONS],
  student: [...WHITEBOARD_ACTIONS],
};

/**
 * Get the default allowed actions for a given role.
 * Falls back to whiteboard-only actions for unknown roles.
 */
export function getActionsForRole(role: string): string[] {
  return ROLE_ACTIONS[role] || [...WHITEBOARD_ACTIONS];
}
