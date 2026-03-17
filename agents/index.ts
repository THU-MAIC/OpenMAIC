/**
 * Agent System
 *
 * Core agent primitives, templates, and utilities for the OpenMAIC platform.
 * Agents are the foundation of all AI interactions - teaching, tutoring,
 * moderation, assessment, and platform guidance.
 */
export type {
  AgentPrimitive,
  AgentRole,
  AgentTool,
  AgentMemoryConfig,
  MemoryScope,
  AgentModelPreference,
  AgentPersonality,
  AgentPolicy,
  AgentAppearance,
  AgentMetadata,
} from './types';

export { AGENT_TEMPLATES, createAgentTemplate } from './templates';
