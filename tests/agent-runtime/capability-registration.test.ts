import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  assembleCapabilityRuntime,
  createCapabilityMap,
  NO_TTS_PROMPT_BLOCK,
  NO_IMAGE_PROMPT_BLOCK,
  noTtsPromptBlock,
  noImagePromptBlock,
  resolveRunnerCapabilities,
  unavailableCapabilitiesPromptBlock,
  type CapabilityDependentTool,
  type ResolvedCapabilityMap,
} from '@/lib/server/agent-runtime/capability-tools';
import { DSL_TOOLS_PROMPT } from '@/lib/server/agent-runtime/course-tools';
import {
  buildGenerateImageTool,
  hasConfiguredImageGeneration,
  generateImagePromptBlock,
} from '@/lib/server/agent-runtime/generate-image';
import {
  buildGenerateVideoTool,
  hasConfiguredVideoGeneration,
  generateVideoPromptBlock,
} from '@/lib/server/agent-runtime/generate-video';
import { hasConfiguredTtsCapability } from '@/lib/server/agent-runtime/scene-tts';
import {
  hasConfiguredVoiceRegistration,
  voiceRegistrationPromptBlock,
} from '@/lib/server/agent-runtime/voice-clone-tools';
import {
  hasConfiguredWebFetchCapability,
  fetchPromptBlock,
} from '@/lib/server/agent-runtime/fetch-url';
import { searchPromptBlock } from '@/lib/server/agent-runtime/web-search';
import { generateTtsPromptBlock } from '@/lib/server/agent-runtime/course-edit/tools';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import * as mediaModule from '@/lib/server/model-config/media';
import { WorkspaceEndpointError } from '@/lib/server/model-config/media';
import { SlotResolutionError } from '@/lib/server/model-config/resolve-slot';

function makeMockTool(name: string): AgentTool<never, never> {
  return {
    name,
    label: name,
    description: `Description for ${name}`,
    execute: vi.fn(),
  } as unknown as AgentTool<never, never>;
}

function makeCapabilityTool(
  name: string,
  capability: keyof ResolvedCapabilityMap['available'],
  promptBlock?: string,
): CapabilityDependentTool {
  const tool = makeMockTool(name) as unknown as CapabilityDependentTool;
  tool.capability = capability;
  if (promptBlock) {
    tool.promptBlock = promptBlock;
  }
  return tool;
}

describe('capability-dependent tool registration (#2102)', () => {
  const baseTools = [
    makeMockTool('read_stage'),
    makeMockTool('patch_stage'),
    makeMockTool('ask_user'),
  ];

  const capabilityTools: CapabilityDependentTool[] = [
    makeCapabilityTool('web_search', 'web_search', '## Web search prompt'),
    makeCapabilityTool('fetch_url', 'web_fetch', '## Web fetch prompt'),
    makeCapabilityTool('generate_image', 'image', '## Image generation prompt'),
    makeCapabilityTool('generate_video', 'video', '## Video generation prompt'),
    makeCapabilityTool('generate_tts', 'tts', '## TTS prompt'),
    makeCapabilityTool('register_voice', 'voice_registration', '## Voice registration prompt'),
  ];

  const allCandidateTools = [...baseTools, ...capabilityTools];

  describe('DSL_TOOLS_PROMPT cleanup', () => {
    it('contains no unconditional image, video, or TTS descriptions', () => {
      expect(DSL_TOOLS_PROMPT).not.toContain('generate_image');
      expect(DSL_TOOLS_PROMPT).not.toContain('generate_video');
      expect(DSL_TOOLS_PROMPT).not.toContain('generate_tts');
    });
  });

  describe('assembleCapabilityRuntime', () => {
    it('when all capabilities are OFF: tools, allowlist, and prompt blocks are all absent', () => {
      const capabilities = createCapabilityMap({
        web_search: false,
        web_fetch: false,
        image: false,
        video: false,
        tts: false,
        voice_registration: false,
      });

      const runtime = assembleCapabilityRuntime({
        capabilities,
        candidateTools: allCandidateTools,
        basePromptBlocks: { dslTools: 'System base prompt' },
      });

      const registeredNames = runtime.tools.map((t) => t.name);
      expect(registeredNames).toEqual(['read_stage', 'patch_stage', 'ask_user']);

      for (const capTool of capabilityTools) {
        expect(registeredNames).not.toContain(capTool.name);
        expect(runtime.allowedToolNames.has(capTool.name)).toBe(false);
      }

      const prompt = runtime.buildSystemPrompt();
      expect(prompt).toContain('System base prompt');
      expect(prompt).not.toContain('## Web search prompt');
      expect(prompt).not.toContain('## Web fetch prompt');
      expect(prompt).not.toContain('## Image generation prompt');
      expect(prompt).not.toContain('## Video generation prompt');
      expect(prompt).not.toContain('## TTS prompt');
      expect(prompt).toContain(NO_TTS_PROMPT_BLOCK);
      expect(prompt).toContain(NO_IMAGE_PROMPT_BLOCK);
      expect(runtime.systemPromptBlocks.unavailableCapabilities).toBe(
        `${NO_IMAGE_PROMPT_BLOCK} ${NO_TTS_PROMPT_BLOCK}`,
      );
      expect(prompt).not.toContain('## Voice registration prompt');
    });

    it('when all capabilities are ON: all tools, allowlist entries, and prompt blocks are present', () => {
      const capabilities = createCapabilityMap({
        web_search: true,
        web_fetch: true,
        image: true,
        video: true,
        tts: true,
        voice_registration: true,
      });

      const runtime = assembleCapabilityRuntime({
        capabilities,
        candidateTools: allCandidateTools,
        basePromptBlocks: { dslTools: 'System base prompt' },
      });

      const registeredNames = runtime.tools.map((t) => t.name);
      for (const capTool of capabilityTools) {
        expect(registeredNames).toContain(capTool.name);
        expect(runtime.allowedToolNames.has(capTool.name)).toBe(true);
      }

      const prompt = runtime.buildSystemPrompt();
      expect(prompt).toContain('System base prompt');
      expect(prompt).toContain('## Web search prompt');
      expect(prompt).toContain('## Web fetch prompt');
      expect(prompt).toContain('## Image generation prompt');
      expect(prompt).toContain('## Video generation prompt');
      expect(prompt).toContain('## TTS prompt');
      expect(prompt).not.toContain(NO_TTS_PROMPT_BLOCK);
      expect(prompt).not.toContain('Audio-generation steps described in skills do not apply');
      expect(prompt).toContain('## Voice registration prompt');
    });

    it('selectively registers only enabled capabilities and their prompts', () => {
      const capabilities = createCapabilityMap({
        web_search: true,
        web_fetch: false,
        image: true,
        video: false,
        tts: false,
        voice_registration: false,
      });

      const runtime = assembleCapabilityRuntime({
        capabilities,
        candidateTools: allCandidateTools,
        basePromptBlocks: { dslTools: 'System base prompt' },
      });

      const registeredNames = runtime.tools.map((t) => t.name);
      expect(registeredNames).toContain('web_search');
      expect(registeredNames).toContain('generate_image');
      expect(registeredNames).not.toContain('fetch_url');
      expect(registeredNames).not.toContain('generate_video');
      expect(registeredNames).not.toContain('generate_tts');
      expect(registeredNames).not.toContain('register_voice');

      expect(runtime.allowedToolNames.has('web_search')).toBe(true);
      expect(runtime.allowedToolNames.has('generate_image')).toBe(true);
      expect(runtime.allowedToolNames.has('fetch_url')).toBe(false);
      expect(runtime.allowedToolNames.has('generate_video')).toBe(false);
      expect(runtime.allowedToolNames.has('generate_tts')).toBe(false);
      expect(runtime.allowedToolNames.has('register_voice')).toBe(false);

      const prompt = runtime.buildSystemPrompt();
      expect(prompt).toContain('## Web search prompt');
      expect(prompt).toContain('## Image generation prompt');
      expect(prompt).not.toContain('## Web fetch prompt');
      expect(prompt).not.toContain('## Video generation prompt');
      expect(prompt).not.toContain('## TTS prompt');
      expect(prompt).toContain(NO_TTS_PROMPT_BLOCK);
      expect(prompt).not.toContain(NO_IMAGE_PROMPT_BLOCK);
      expect(runtime.systemPromptBlocks.unavailableCapabilities).toBe(NO_TTS_PROMPT_BLOCK);
      expect(prompt).not.toContain('## Voice registration prompt');
    });

    it('adds conditional system-prompt instruction when TTS is unavailable', () => {
      const runtime = assembleCapabilityRuntime({
        capabilities: createCapabilityMap({ tts: false, image: true }),
        candidateTools: allCandidateTools,
      });

      expect(runtime.tools.some((t) => t.name === 'generate_tts')).toBe(false);
      expect(runtime.allowedToolNames.has('generate_tts')).toBe(false);
      expect(runtime.systemPromptBlocks.unavailableCapabilities).toBe(NO_TTS_PROMPT_BLOCK);
      expect(noTtsPromptBlock()).toBe(NO_TTS_PROMPT_BLOCK);
      const prompt = runtime.buildSystemPrompt();
      expect(prompt).toContain(NO_TTS_PROMPT_BLOCK);
      expect(prompt).toContain('generate_tts must not be called');
      expect(prompt).toContain('continue without TTS');
      expect(prompt).toContain('Audio-generation steps described in skills do not apply');
      expect(prompt).not.toContain(NO_IMAGE_PROMPT_BLOCK);
    });

    it('adds conditional system-prompt instruction when image generation is unavailable', () => {
      const runtime = assembleCapabilityRuntime({
        capabilities: createCapabilityMap({ image: false, tts: true }),
        candidateTools: allCandidateTools,
      });

      expect(runtime.tools.some((t) => t.name === 'generate_image')).toBe(false);
      expect(runtime.allowedToolNames.has('generate_image')).toBe(false);
      expect(runtime.systemPromptBlocks.unavailableCapabilities).toBe(NO_IMAGE_PROMPT_BLOCK);
      expect(noImagePromptBlock()).toBe(NO_IMAGE_PROMPT_BLOCK);
      const prompt = runtime.buildSystemPrompt();
      expect(prompt).toContain(NO_IMAGE_PROMPT_BLOCK);
      expect(prompt).toContain('generate_image must not be called');
      expect(prompt).toContain('continue without image generation');
      expect(prompt).toContain(
        'Image-generation steps described in skills (such as page-clone) do not apply',
      );
      expect(prompt).not.toContain(NO_TTS_PROMPT_BLOCK);
    });

    it('uses image prompt block and omits no-image instruction when image generation is enabled', () => {
      const runtime = assembleCapabilityRuntime({
        capabilities: createCapabilityMap({ image: true, tts: true }),
        candidateTools: allCandidateTools,
      });

      expect(runtime.tools.some((t) => t.name === 'generate_image')).toBe(true);
      expect(runtime.allowedToolNames.has('generate_image')).toBe(true);
      expect(runtime.systemPromptBlocks.image).toBe('## Image generation prompt');
      const prompt = runtime.buildSystemPrompt();
      expect(prompt).toContain('## Image generation prompt');
      expect(prompt).not.toContain(NO_IMAGE_PROMPT_BLOCK);
    });

    it('combines unavailable instructions when both image generation and TTS are unavailable', () => {
      const caps = createCapabilityMap({ image: false, tts: false });
      expect(unavailableCapabilitiesPromptBlock(caps)).toBe(
        `${NO_IMAGE_PROMPT_BLOCK} ${NO_TTS_PROMPT_BLOCK}`,
      );
      const runtime = assembleCapabilityRuntime({
        capabilities: caps,
        candidateTools: allCandidateTools,
      });

      expect(runtime.tools.some((t) => t.name === 'generate_image')).toBe(false);
      expect(runtime.tools.some((t) => t.name === 'generate_tts')).toBe(false);
      expect(runtime.systemPromptBlocks.unavailableCapabilities).toBe(
        `${NO_IMAGE_PROMPT_BLOCK} ${NO_TTS_PROMPT_BLOCK}`,
      );
      const prompt = runtime.buildSystemPrompt();
      expect(prompt).toContain(NO_IMAGE_PROMPT_BLOCK);
      expect(prompt).toContain(NO_TTS_PROMPT_BLOCK);
      expect(prompt).toContain('generate_image must not be called');
      expect(prompt).toContain('generate_tts must not be called');
    });

    it('uses TTS prompt block and omits no-TTS instruction when TTS is enabled', () => {
      const runtime = assembleCapabilityRuntime({
        capabilities: createCapabilityMap({ tts: true }),
        candidateTools: allCandidateTools,
      });

      expect(runtime.tools.some((t) => t.name === 'generate_tts')).toBe(true);
      expect(runtime.allowedToolNames.has('generate_tts')).toBe(true);
      expect(runtime.systemPromptBlocks.tts).toBe('## TTS prompt');
      const prompt = runtime.buildSystemPrompt();
      expect(prompt).toContain('## TTS prompt');
      expect(prompt).not.toContain(NO_TTS_PROMPT_BLOCK);
    });
  });

  describe('capability resolution and execution consistency', () => {
    it('image: hasConfiguredImageGeneration logic is consistent', () => {
      expect(hasConfiguredImageGeneration(undefined)).toBe(false);
      expect(hasConfiguredImageGeneration(null)).toBe(false);
      expect(hasConfiguredImageGeneration('off')).toBe(false);
      expect(hasConfiguredImageGeneration({ providerId: '' } as never)).toBe(false);
      expect(hasConfiguredImageGeneration({ imageConnection: 'off' } as never)).toBe(false);
      expect(
        hasConfiguredImageGeneration({
          getConfiguredProviders: () => ({ 'openai-image': {} }),
          resolveProviderConfig: () => ({ apiKey: 'sk-test' }),
        } as never),
      ).toBe(true);
    });

    it('video: hasConfiguredVideoGeneration logic is consistent', () => {
      expect(hasConfiguredVideoGeneration(undefined)).toBe(false);
      expect(hasConfiguredVideoGeneration(null)).toBe(false);
      expect(hasConfiguredVideoGeneration('off')).toBe(false);
      expect(hasConfiguredVideoGeneration({ providerId: '' } as never)).toBe(false);
      expect(hasConfiguredVideoGeneration({ videoConnection: 'off' } as never)).toBe(false);
      expect(hasConfiguredVideoGeneration({ videoConnection: null } as never)).toBe(false);
    });

    it('tts: hasConfiguredTtsCapability logic is consistent', () => {
      expect(hasConfiguredTtsCapability(undefined)).toBe(false);
      expect(hasConfiguredTtsCapability(null)).toBe(false);
      expect(hasConfiguredTtsCapability('off')).toBe(false);
      expect(hasConfiguredTtsCapability({ providerId: '' } as never)).toBe(false);
      expect(hasConfiguredTtsCapability({ providerId: 'browser-native-tts' } as never)).toBe(false);
      expect(
        hasConfiguredTtsCapability({
          providerId: 'minimax-tts',
          apiKey: '',
          managed: true,
          userEndpoint: false,
          origin: 'configuration',
        }),
      ).toBe(false);
      expect(
        hasConfiguredTtsCapability({
          providerId: 'minimax-tts',
          apiKey: 'key',
          managed: true,
          userEndpoint: false,
          origin: 'configuration',
        }),
      ).toBe(true);
    });

    it('web_fetch: hasConfiguredWebFetchCapability logic is consistent', () => {
      expect(hasConfiguredWebFetchCapability('off')).toBe(false);
      expect(hasConfiguredWebFetchCapability(null)).toBe(false);
      expect(hasConfiguredWebFetchCapability(undefined)).toBe(false);
      expect(
        hasConfiguredWebFetchCapability({
          providerId: 'browser',
          managed: true,
          userEndpoint: false,
          origin: 'configuration',
        }),
      ).toBe(true);
    });

    it('voice_registration: hasConfiguredVoiceRegistration checks registered adapters', () => {
      expect(hasConfiguredVoiceRegistration(null)).toBe(false);
      expect(hasConfiguredVoiceRegistration('off')).toBe(false);
    });

    it('each migrated capability tool declares its requirement and prompt block', () => {
      expect(typeof generateImagePromptBlock).toBe('function');
      expect(generateImagePromptBlock()).toContain('generate_image');

      expect(typeof generateVideoPromptBlock).toBe('function');
      expect(generateVideoPromptBlock()).toContain('generate_video');

      expect(typeof generateTtsPromptBlock).toBe('function');
      expect(generateTtsPromptBlock()).toContain('generate_tts');

      expect(typeof voiceRegistrationPromptBlock).toBe('function');
      expect(voiceRegistrationPromptBlock()).toContain('register_voice');

      expect(typeof fetchPromptBlock).toBe('function');
      expect(fetchPromptBlock()).toContain('fetch_url');

      expect(typeof searchPromptBlock).toBe('function');
      expect(searchPromptBlock()).toContain('web_search');
    });
  });

  describe('createCapabilityMap helper', () => {
    it('creates a map with defaults and custom availability', () => {
      const caps = createCapabilityMap({
        web_search: true,
        image: true,
      });

      expect(caps.isAvailable('web_search')).toBe(true);
      expect(caps.isAvailable('image')).toBe(true);
      expect(caps.isAvailable('web_fetch')).toBe(false);
      expect(caps.isAvailable('video')).toBe(false);
      expect(caps.isAvailable('tts')).toBe(false);
      expect(caps.isAvailable('voice_registration')).toBe(false);
    });
  });

  describe('media connection resolution failures handling', () => {
    it('catches image resolution failure, treats image as unavailable, and allows other capabilities and agent run to continue', async () => {
      const spy = vi
        .spyOn(mediaModule, 'serverMediaConnection')
        .mockImplementation(async (slot) => {
          if (slot === 'image') {
            throw new SlotResolutionError('image: invalid model reference');
          }
          if (slot === 'video') {
            return { providerId: 'seedance', apiKey: 'vid-key' } as never;
          }
          if (slot === 'tts') {
            return { providerId: 'minimax-tts', apiKey: 'tts-key' } as never;
          }
          return null;
        });

      const capabilities = await resolveRunnerCapabilities({ workspaceId: null });
      expect(capabilities.isAvailable('image')).toBe(false);
      expect(capabilities.isAvailable('video')).toBe(true);
      expect(capabilities.isAvailable('tts')).toBe(true);

      const runtime = assembleCapabilityRuntime({
        capabilities,
        candidateTools: allCandidateTools,
      });

      expect(runtime.tools.some((t) => t.name === 'generate_image')).toBe(false);
      expect(runtime.tools.some((t) => t.name === 'generate_video')).toBe(true);
      expect(runtime.tools.some((t) => t.name === 'generate_tts')).toBe(true);
      expect(runtime.allowedToolNames.has('generate_image')).toBe(false);
      expect(runtime.allowedToolNames.has('generate_video')).toBe(true);
      expect(runtime.allowedToolNames.has('generate_tts')).toBe(true);

      const prompt = runtime.buildSystemPrompt();
      expect(prompt).toContain(NO_IMAGE_PROMPT_BLOCK);
      expect(prompt).not.toContain(NO_TTS_PROMPT_BLOCK);
      expect(prompt).toContain('## Video generation prompt');
      expect(prompt).toContain('## TTS prompt');

      spy.mockRestore();
    });

    it('catches video resolution failure, treats video as unavailable, and allows other capabilities and agent run to continue', async () => {
      const spy = vi
        .spyOn(mediaModule, 'serverMediaConnection')
        .mockImplementation(async (slot) => {
          if (slot === 'video') {
            throw new WorkspaceEndpointError('video: invalid url endpoint');
          }
          if (slot === 'image') {
            return { providerId: 'openai-image', apiKey: 'img-key' } as never;
          }
          if (slot === 'tts') {
            return { providerId: 'minimax-tts', apiKey: 'tts-key' } as never;
          }
          return null;
        });

      const capabilities = await resolveRunnerCapabilities({ workspaceId: null });
      expect(capabilities.isAvailable('video')).toBe(false);
      expect(capabilities.isAvailable('image')).toBe(true);
      expect(capabilities.isAvailable('tts')).toBe(true);

      const runtime = assembleCapabilityRuntime({
        capabilities,
        candidateTools: allCandidateTools,
      });

      expect(runtime.tools.some((t) => t.name === 'generate_video')).toBe(false);
      expect(runtime.tools.some((t) => t.name === 'generate_image')).toBe(true);
      expect(runtime.tools.some((t) => t.name === 'generate_tts')).toBe(true);
      expect(runtime.allowedToolNames.has('generate_video')).toBe(false);
      expect(runtime.allowedToolNames.has('generate_image')).toBe(true);
      expect(runtime.allowedToolNames.has('generate_tts')).toBe(true);

      const prompt = runtime.buildSystemPrompt();
      expect(prompt).toContain('## Image generation prompt');
      expect(prompt).toContain('## TTS prompt');
      expect(prompt).not.toContain('## Video generation prompt');

      spy.mockRestore();
    });

    it('catches tts resolution failure, treats tts as unavailable, and allows other capabilities and agent run to continue', async () => {
      const spy = vi
        .spyOn(mediaModule, 'serverMediaConnection')
        .mockImplementation(async (slot) => {
          if (slot === 'tts') {
            throw new SlotResolutionError('tts: provider not declared');
          }
          if (slot === 'image') {
            return { providerId: 'openai-image', apiKey: 'img-key' } as never;
          }
          if (slot === 'video') {
            return { providerId: 'seedance', apiKey: 'vid-key' } as never;
          }
          return null;
        });

      const capabilities = await resolveRunnerCapabilities({ workspaceId: null });
      expect(capabilities.isAvailable('tts')).toBe(false);
      expect(capabilities.isAvailable('voice_registration')).toBe(false);
      expect(capabilities.isAvailable('image')).toBe(true);
      expect(capabilities.isAvailable('video')).toBe(true);

      const runtime = assembleCapabilityRuntime({
        capabilities,
        candidateTools: allCandidateTools,
      });

      expect(runtime.tools.some((t) => t.name === 'generate_tts')).toBe(false);
      expect(runtime.tools.some((t) => t.name === 'generate_image')).toBe(true);
      expect(runtime.tools.some((t) => t.name === 'generate_video')).toBe(true);
      expect(runtime.allowedToolNames.has('generate_tts')).toBe(false);
      expect(runtime.allowedToolNames.has('generate_image')).toBe(true);
      expect(runtime.allowedToolNames.has('generate_video')).toBe(true);

      const prompt = runtime.buildSystemPrompt();
      expect(prompt).toContain(NO_TTS_PROMPT_BLOCK);
      expect(prompt).not.toContain(NO_IMAGE_PROMPT_BLOCK);
      expect(prompt).toContain('## Image generation prompt');
      expect(prompt).toContain('## Video generation prompt');

      spy.mockRestore();
    });
  });

  describe('positive coverage using real connections', () => {
    afterEach(() => {
      setDeploymentConfigForTests();
    });

    it('registers tools, allowedToolNames entries, and prompt blocks for real image and video connections', async () => {
      setDeploymentConfigForTests({
        layer: {
          source: 'deployment',
          config: {
            providers: {
              img: { preset: 'openai-image', apiKey: 'test-key' },
              vid: { preset: 'seedance', apiKey: 'test-key' },
            },
            slots: {
              image: 'img',
              video: 'vid',
            },
          } as never,
        },
        legacy: false,
        notices: [],
      });

      const capabilities = await resolveRunnerCapabilities({ workspaceId: null });
      expect(capabilities.isAvailable('image')).toBe(true);
      expect(capabilities.isAvailable('video')).toBe(true);

      const imageTool = buildGenerateImageTool({
        ownerId: 'test-owner',
        imageConnection: capabilities.connections.image,
      });
      const videoTool = buildGenerateVideoTool({
        ownerId: 'test-owner',
        videoConnection: capabilities.connections.video,
      });

      const runtime = assembleCapabilityRuntime({
        capabilities,
        candidateTools: [imageTool, videoTool],
      });

      expect(runtime.tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['generate_image', 'generate_video']),
      );
      expect(runtime.allowedToolNames.has('generate_image')).toBe(true);
      expect(runtime.allowedToolNames.has('generate_video')).toBe(true);

      expect(runtime.systemPromptBlocks.image).toBeDefined();
      expect(runtime.systemPromptBlocks.image).toContain('generate_image');
      expect(runtime.systemPromptBlocks.video).toBeDefined();
      expect(runtime.systemPromptBlocks.video).toContain('generate_video');

      const prompt = runtime.buildSystemPrompt();
      expect(prompt).toContain('generate_image');
      expect(prompt).toContain('generate_video');
      expect(prompt).not.toContain(NO_IMAGE_PROMPT_BLOCK);
      expect(prompt).not.toContain('Image-generation steps described in skills');
    });
  });
});
