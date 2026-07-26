// lib/export/classroom-zip-types.ts
import type { GeneratedAgentConfig, SceneType, SceneContent } from '@/lib/types/stage';
import type { Action } from '@/lib/types/action';
import type { AgentVoiceConfig, Slide, VoiceDesign } from '@openmaic/dsl';

export const CLASSROOM_ZIP_FORMAT_VERSION = 1;
export const CLASSROOM_ZIP_EXTENSION = '.maic.zip';

export interface ClassroomManifest {
  formatVersion: number;
  exportedAt: string;
  appVersion: string;
  stage: ManifestStage;
  agents: ManifestAgent[];
  scenes: ManifestScene[];
  mediaIndex: Record<string, MediaIndexEntry>;
}

export interface ManifestStage {
  name: string;
  description?: string;
  language?: string;
  style?: string;
  createdAt: number;
  updatedAt: number;
  // Note: Stage.interactiveMode is intentionally NOT exported — it reflects the
  // original generation prompt branch, which imports can't faithfully reproduce.
}

export interface ManifestAgent {
  name: string;
  role: string;
  persona: string;
  avatar: string;
  color: string;
  priority: number;
  /** Bound TTS voice carried over from the stage roster, when present. */
  voiceConfig?: AgentVoiceConfig;
  /** 3-layer vocal descriptor carried over from the stage roster, when present. */
  voiceDesign?: VoiceDesign;
}

/**
 * Map a stage roster config to its portable manifest shape. Agent identity is
 * positional in the manifest (index into `manifest.agents`), so the id is
 * dropped; the voice fields travel verbatim.
 */
export function manifestAgentFromConfig(config: GeneratedAgentConfig): ManifestAgent {
  return {
    name: config.name,
    role: config.role,
    persona: config.persona,
    avatar: config.avatar,
    color: config.color,
    priority: config.priority,
    ...(config.voiceConfig ? { voiceConfig: config.voiceConfig } : {}),
    ...(config.voiceDesign ? { voiceDesign: config.voiceDesign } : {}),
  };
}

/**
 * Rebuild a stage roster config from a manifest agent under a freshly minted
 * id — the inverse of {@link manifestAgentFromConfig}, so an export/import
 * round trip preserves the roster (voice included) up to id renaming.
 */
export function agentConfigFromManifest(agent: ManifestAgent, id: string): GeneratedAgentConfig {
  return {
    id,
    name: agent.name,
    role: agent.role,
    persona: agent.persona,
    avatar: agent.avatar,
    color: agent.color,
    priority: agent.priority,
    ...(agent.voiceConfig ? { voiceConfig: agent.voiceConfig } : {}),
    ...(agent.voiceDesign ? { voiceDesign: agent.voiceDesign } : {}),
  };
}

export interface ManifestScene {
  type: SceneType;
  title: string;
  order: number;
  content: SceneContent;
  actions?: ManifestAction[];
  whiteboards?: Slide[];
  multiAgent?: {
    enabled: boolean;
    agentIndices: number[];
    directorPrompt?: string;
  };
}

export type ManifestAction = Omit<Action, 'audioId'> & {
  audioRef?: string;
  /**
   * Portable discussion-agent reference.
   * New exports use the agent's index in manifest.agents instead of runtime IDs.
   * Legacy ZIPs may still carry discussion.agentId directly.
   */
  agentIndex?: number;
};

export interface MediaIndexEntry {
  type: 'audio' | 'image' | 'generated';
  mimeType?: string;
  format?: string;
  duration?: number;
  voice?: string;
  size?: number;
  prompt?: string;
  missing?: boolean;
}
