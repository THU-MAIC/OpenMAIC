import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';
import type { MediaConnection } from '@/lib/server/model-config/media';
import { serverMediaConnection } from '@/lib/server/model-config/media';
import { resolveWebSearchCapability, type WebSearchCapability } from './web-search';
import { resolveWebFetchCapability, untrustedContentPolicyPromptBlock } from './fetch-url';
import { hasConfiguredImageGeneration } from './generate-image';
import { hasConfiguredVideoGeneration } from './generate-video';
import { hasConfiguredTtsCapability } from './scene-tts';
import { hasConfiguredVoiceRegistrationCapability } from './voice-clone-tools';
import { courseSystemPrompt, DSL_TOOLS_PROMPT, type CoursePromptBlocks } from './course-tools';

export type CapabilityRequirement =
  | 'tts'
  | 'image'
  | 'video'
  | 'web_search'
  | 'web_fetch'
  | 'voice_registration';

export interface CapabilityDependentTool<
  TParameters extends TSchema = TSchema,
  TDetails = unknown,
> extends AgentTool<TParameters, TDetails> {
  capability: CapabilityRequirement;
  promptBlock?: string | (() => string);
}

export function isCapabilityTool(tool: unknown): tool is CapabilityDependentTool {
  return typeof tool === 'object' && tool !== null && 'capability' in tool;
}

export interface ResolvedCapabilityMap {
  connections: {
    web_search: WebSearchCapability | null;
    web_fetch: MediaConnection | null;
    tts: MediaConnection | 'off' | null;
    image: MediaConnection | 'off' | null;
    video: MediaConnection | 'off' | null;
  };
  available: Record<CapabilityRequirement, boolean>;
  isAvailable(capability: CapabilityRequirement): boolean;
}

export async function resolveRunnerCapabilities({
  ownerId,
  workspaceId,
}: {
  ownerId?: string;
  workspaceId: string | null;
}): Promise<ResolvedCapabilityMap> {
  const [search, fetchConnection, ttsConnection, imageConnection, videoConnection] =
    await Promise.all([
      resolveWebSearchCapability(workspaceId),
      resolveWebFetchCapability(workspaceId),
      serverMediaConnection('tts', ownerId),
      serverMediaConnection('image', ownerId),
      serverMediaConnection('video', ownerId),
    ]);

  const available: Record<CapabilityRequirement, boolean> = {
    web_search: search !== null,
    web_fetch: fetchConnection !== null,
    tts: hasConfiguredTtsCapability(ttsConnection),
    image: hasConfiguredImageGeneration({ imageConnection }),
    video: hasConfiguredVideoGeneration({ videoConnection }),
    voice_registration: hasConfiguredVoiceRegistrationCapability(ttsConnection),
  };

  return {
    connections: {
      web_search: search,
      web_fetch: fetchConnection,
      tts: ttsConnection,
      image: imageConnection,
      video: videoConnection,
    },
    available,
    isAvailable: (cap: CapabilityRequirement) => available[cap] ?? false,
  };
}

export function createCapabilityMap(
  available: Partial<Record<CapabilityRequirement, boolean>> = {},
  connections: Partial<ResolvedCapabilityMap['connections']> = {},
): ResolvedCapabilityMap {
  const fullAvailable: Record<CapabilityRequirement, boolean> = {
    web_search: false,
    web_fetch: false,
    tts: false,
    image: false,
    video: false,
    voice_registration: false,
    ...available,
  };
  return {
    connections: {
      web_search: null,
      web_fetch: null,
      tts: null,
      image: null,
      video: null,
      ...connections,
    },
    available: fullAvailable,
    isAvailable: (cap: CapabilityRequirement) => fullAvailable[cap] ?? false,
  };
}

export interface AssembleCapabilityRuntimeOptions {
  capabilities: ResolvedCapabilityMap;
  candidateTools: ReadonlyArray<AgentTool | ReadonlyArray<AgentTool>>;
  baseAllowedToolNames?: ReadonlyArray<string> | ReadonlySet<string>;
  basePromptBlocks?: CoursePromptBlocks | (() => CoursePromptBlocks);
  wrapTools?: (tools: AgentTool[]) => AgentTool[];
}

export interface AssembledCapabilityRuntime {
  tools: AgentTool[];
  allowedToolNames: ReadonlySet<string>;
  systemPrompt: string;
  systemPromptBlocks: CoursePromptBlocks;
  buildSystemPrompt: () => string;
}

export function assembleCapabilityRuntime(
  options: AssembleCapabilityRuntimeOptions,
): AssembledCapabilityRuntime {
  const flattened: AgentTool[] = options.candidateTools.flat();
  const keptTools: AgentTool[] = [];
  const capabilityPromptBlocks: Partial<Record<CapabilityRequirement, string>> = {};

  for (const tool of flattened) {
    if (isCapabilityTool(tool)) {
      if (options.capabilities.isAvailable(tool.capability)) {
        keptTools.push(tool);
        if (tool.promptBlock && !capabilityPromptBlocks[tool.capability]) {
          capabilityPromptBlocks[tool.capability] =
            typeof tool.promptBlock === 'function' ? tool.promptBlock() : tool.promptBlock;
        }
      }
    } else {
      keptTools.push(tool);
    }
  }

  const tools = options.wrapTools ? options.wrapTools(keptTools) : keptTools;
  const allowedToolNames = new Set([
    ...(options.baseAllowedToolNames ?? []),
    ...tools.map((t) => t.name),
  ]);

  const buildPromptBlocks = (): CoursePromptBlocks => {
    const base =
      typeof options.basePromptBlocks === 'function'
        ? options.basePromptBlocks()
        : (options.basePromptBlocks ?? {});

    const blocks: CoursePromptBlocks = {
      ...base,
      search: capabilityPromptBlocks.web_search,
      fetch: capabilityPromptBlocks.web_fetch,
      image: capabilityPromptBlocks.image,
      video: capabilityPromptBlocks.video,
      tts: capabilityPromptBlocks.tts,
      voiceRegistration: capabilityPromptBlocks.voice_registration,
    };
    if (blocks.untrustedContent === undefined) {
      blocks.untrustedContent = untrustedContentPolicyPromptBlock(
        options.capabilities.isAvailable('web_fetch'),
      );
    }
    return blocks;
  };

  const buildSystemPrompt = () => {
    const blocks = buildPromptBlocks();
    return courseSystemPrompt({ dslTools: DSL_TOOLS_PROMPT, ...blocks });
  };

  return {
    tools,
    allowedToolNames,
    get systemPrompt() {
      return buildSystemPrompt();
    },
    get systemPromptBlocks() {
      return buildPromptBlocks();
    },
    buildSystemPrompt,
  };
}
