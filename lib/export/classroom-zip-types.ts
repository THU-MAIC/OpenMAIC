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
 * Structurally validate a manifest voice binding. Manifests are parsed JSON
 * from user-supplied ZIPs, so the typed shape is a claim, not a guarantee: a
 * malformed binding is dropped (the agent itself survives) rather than being
 * written into the document and reaching the registry/TTS path.
 */
function sanitizeManifestVoiceConfig(value: unknown): AgentVoiceConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { providerId, voiceId } = value as Record<string, unknown>;
  if (typeof providerId !== 'string' || typeof voiceId !== 'string') return undefined;
  return { providerId, voiceId };
}

/** Same contract as {@link sanitizeManifestVoiceConfig}, for the 3-layer descriptor. */
function sanitizeManifestVoiceDesign(value: unknown): VoiceDesign | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { identity, texture, delivery } = value as Record<string, unknown>;
  if (typeof identity !== 'string' || typeof texture !== 'string' || typeof delivery !== 'string') {
    return undefined;
  }
  return { identity, texture, delivery };
}

/**
 * Rebuild a stage roster config from a manifest agent under a freshly minted
 * id — the inverse of {@link manifestAgentFromConfig}, so an export/import
 * round trip preserves the roster (voice included) up to id renaming. The
 * voice fields are structurally validated on the way in; malformed ones are
 * dropped per field.
 */
export function agentConfigFromManifest(agent: ManifestAgent, id: string): GeneratedAgentConfig {
  const voiceConfig = sanitizeManifestVoiceConfig(agent.voiceConfig);
  const voiceDesign = sanitizeManifestVoiceDesign(agent.voiceDesign);
  return {
    id,
    name: agent.name,
    role: agent.role,
    persona: agent.persona,
    avatar: agent.avatar,
    color: agent.color,
    priority: agent.priority,
    ...(voiceConfig ? { voiceConfig } : {}),
    ...(voiceDesign ? { voiceDesign } : {}),
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
