/**
 * Agent System Types
 *
 * Defines the agent primitive with: role, prompt, tools, memory, model,
 * personality, and behavior policies. This is the foundation for all
 * AI agents in the platform.
 */

/**
 * Agent primitive - the core building block for all AI agents
 */
export interface AgentPrimitive {
  id: string;
  /** Display name */
  name: string;
  /** Agent role category */
  role: AgentRole;
  /** System prompt defining personality and behavior */
  systemPrompt: string;
  /** Available tools this agent can use */
  tools: AgentTool[];
  /** Memory configuration */
  memory: AgentMemoryConfig;
  /** Model preference (overrides default) */
  modelPreference?: AgentModelPreference;
  /** Personality traits */
  personality: AgentPersonality;
  /** Behavior policies and constraints */
  policies: AgentPolicy[];
  /** Visual configuration */
  appearance: AgentAppearance;
  /** Priority for turn-taking (1-10) */
  priority: number;
  /** Metadata */
  metadata: AgentMetadata;
}

/**
 * Pre-built agent roles
 */
export type AgentRole =
  | 'teacher'
  | 'student'
  | 'moderator'
  | 'examiner'
  | 'research-assistant'
  | 'mentor'
  | 'debater-pro'
  | 'debater-con'
  | 'guide'
  | 'custom';

/**
 * Tool available to agents
 */
export interface AgentTool {
  id: string;
  name: string;
  description: string;
  /** Tool category for permission management */
  category: 'content' | 'navigation' | 'assessment' | 'communication' | 'system';
  /** Whether this tool requires user confirmation */
  requiresConfirmation: boolean;
}

/**
 * Agent memory configuration
 */
export interface AgentMemoryConfig {
  /** Short-term memory (within current session) */
  shortTerm: {
    enabled: boolean;
    maxMessages: number;
  };
  /** Long-term memory (persisted across sessions) */
  longTerm: {
    enabled: boolean;
    storageType: 'local' | 'vector' | 'database';
  };
  /** Vector memory for semantic search */
  vector: {
    enabled: boolean;
    collection?: string;
  };
  /** Memory scope */
  scope: MemoryScope;
}

export type MemoryScope = 'session' | 'course' | 'student' | 'global';

/**
 * Agent model preference
 */
export interface AgentModelPreference {
  providerId?: string;
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Agent personality configuration
 */
export interface AgentPersonality {
  /** Personality trait scores (0-1) */
  traits: {
    formality: number;
    humor: number;
    patience: number;
    encouragement: number;
    detail: number;
  };
  /** Communication style */
  communicationStyle: 'formal' | 'casual' | 'academic' | 'friendly';
  /** Language complexity */
  languageComplexity: 'simple' | 'moderate' | 'advanced';
}

/**
 * Agent behavior policy
 */
export interface AgentPolicy {
  id: string;
  name: string;
  description: string;
  type: 'restriction' | 'guideline' | 'requirement';
  rule: string;
}

/**
 * Agent visual appearance
 */
export interface AgentAppearance {
  avatar: string;
  color: string;
  badge?: string;
}

/**
 * Agent metadata
 */
export interface AgentMetadata {
  createdAt: string;
  updatedAt: string;
  isBuiltIn: boolean;
  isGenerated: boolean;
  version: number;
  boundStageId?: string;
  tags: string[];
}
