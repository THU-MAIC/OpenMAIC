/**
 * Per-provider-family SSRF regression tests.
 *
 * Each case drives the real provider adapter against a loopback HTTP server so
 * the adapter's own fetch path (not just the helper in isolation) is shown to:
 *
 *  - fail closed when the origin answers `302` to a cloud metadata address;
 *  - fail closed when an origin hostname rebinds to loopback at connect time;
 *  - still return a normal `200` body; and
 *  - honor the server-selected policy (client BYOK is strict; a server-managed
 *    local backend may be permitted).
 *
 * The loopback origins are IP literals, so the pinned dispatcher is exercised
 * by the dedicated rebinding cases (which use a hostname and a `node:dns`
 * double) and the redirect cases (which use the URL-layer guard).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateTTS } from '@/lib/audio/tts-providers';
import { transcribeAudio } from '@/lib/audio/asr-providers';
import { registerVoxCPMVoice, voxCPMVoiceExists } from '@/lib/audio/voxcpm-registration';
import { registerQwenVoice } from '@/lib/audio/qwen-voice-clone';
import { findUnsafeNetworkTargetError } from '@/lib/server/ssrf-guard';
import type { ASRModelConfig, TTSModelConfig } from '@/lib/audio/types';

const dnsMocks = vi.hoisted(() => ({
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: (...args: unknown[]) => dnsMocks.callbackLookup(...args),
    promises: { ...actual.promises, lookup: dnsMocks.promisesLookup },
  };
});

type Answer = { address: string; family: number };
const LOOPBACK: Answer[] = [{ address: '127.0.0.1', family: 4 }];

const METADATA_BLOCK_MESSAGE = 'Cloud instance metadata endpoints are never allowed';
const PRIVATE_BLOCK_MESSAGE = 'Local/private network URLs are not allowed';

function answerWith(addresses: Answer[]) {
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ): void => {
    if (options?.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0]!.address, addresses[0]!.family);
    }
  };
}

const servers: Server[] = [];

interface LoopbackServer {
  port: number;
  url: string;
  requests: () => number;
}

async function startLoopback(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LoopbackServer> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { port, url: `http://127.0.0.1:${port}`, requests: () => count };
}

function redirectTo(location: string) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(302, { Location: location });
    res.end();
  };
}

function jsonResponse(body: unknown, status = 200) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

/** A keyed BYOK-style config that reaches the provider fetch, with local allowed. */
function openAiTts(baseUrl: string): TTSModelConfig {
  return {
    providerId: 'openai-tts',
    apiKey: 'sk-test',
    baseUrl,
    voice: 'alloy',
    publicOnly: false,
  };
}

function openAiAsr(baseUrl: string): ASRModelConfig {
  return {
    providerId: 'openai-whisper',
    apiKey: 'sk-test',
    baseUrl,
    modelId: 'whisper-1',
    publicOnly: false,
  };
}

/** Each entry must build a request that reaches the outbound provider fetch. */
const TTS_CASES: Array<{ name: string; config: (baseUrl: string) => TTSModelConfig }> = [
  { name: 'openai-tts', config: (baseUrl) => openAiTts(baseUrl) },
  {
    name: 'lemonade-tts',
    config: (baseUrl) => ({
      providerId: 'lemonade-tts',
      baseUrl,
      voice: 'af_heart',
      publicOnly: false,
    }),
  },
  {
    name: 'azure-tts',
    config: (baseUrl) => ({
      providerId: 'azure-tts',
      apiKey: 'k',
      baseUrl,
      voice: 'en-US-AriaNeural',
      publicOnly: false,
    }),
  },
  {
    name: 'glm-tts',
    config: (baseUrl) => ({
      providerId: 'glm-tts',
      apiKey: 'k',
      baseUrl,
      voice: 'tongtong',
      publicOnly: false,
    }),
  },
  {
    name: 'qwen-tts',
    config: (baseUrl) => ({
      providerId: 'qwen-tts',
      apiKey: 'k',
      baseUrl,
      voice: 'Cherry',
      publicOnly: false,
    }),
  },
  {
    name: 'minimax-tts',
    config: (baseUrl) => ({
      providerId: 'minimax-tts',
      apiKey: 'k',
      baseUrl,
      voice: 'male-qn-qingse',
      publicOnly: false,
    }),
  },
  {
    name: 'elevenlabs-tts',
    config: (baseUrl) => ({
      providerId: 'elevenlabs-tts',
      apiKey: 'k',
      baseUrl,
      voice: 'Rachel',
      publicOnly: false,
    }),
  },
  {
    name: 'doubao-tts',
    config: (baseUrl) => ({
      providerId: 'doubao-tts',
      apiKey: 'app:key',
      baseUrl,
      voice: 'BV001',
      publicOnly: false,
    }),
  },
  {
    name: 'voxcpm-tts (vllm-omni)',
    config: (baseUrl) => ({
      providerId: 'voxcpm-tts',
      baseUrl: `${baseUrl}/v1`,
      voice: 'default',
      providerOptions: { backend: 'vllm-omni' },
      publicOnly: false,
    }),
  },
  {
    name: 'voxcpm-tts (python-api)',
    config: (baseUrl) => ({
      providerId: 'voxcpm-tts',
      baseUrl,
      voice: 'default',
      providerOptions: { backend: 'python-api' },
      publicOnly: false,
    }),
  },
  {
    name: 'voxcpm-tts (nano-vllm)',
    config: (baseUrl) => ({
      providerId: 'voxcpm-tts',
      baseUrl,
      voice: 'default',
      providerOptions: { backend: 'nano-vllm' },
      publicOnly: false,
    }),
  },
];

const ASR_CASES: Array<{ name: string; config: (baseUrl: string) => ASRModelConfig }> = [
  { name: 'openai-whisper (AI SDK)', config: (baseUrl) => openAiAsr(baseUrl) },
  {
    name: 'custom-asr',
    config: (baseUrl) => ({
      providerId: 'custom-asr-local',
      apiKey: 'k',
      baseUrl,
      modelId: 'whisper-1',
      publicOnly: false,
    }),
  },
  {
    name: 'funasr-asr',
    config: (baseUrl) => ({ providerId: 'funasr-asr', baseUrl, publicOnly: false }),
  },
  {
    name: 'lemonade-asr',
    config: (baseUrl) => ({ providerId: 'lemonade-asr', baseUrl, publicOnly: false }),
  },
  {
    name: 'qwen-asr',
    config: (baseUrl) => ({
      providerId: 'qwen-asr',
      apiKey: 'k',
      baseUrl,
      publicOnly: false,
    }),
  },
  {
    name: 'azure-asr',
    config: (baseUrl) => ({
      providerId: 'azure-asr',
      apiKey: 'k',
      baseUrl,
      publicOnly: false,
    }),
  },
];

function wavBuffer(): Buffer {
  const buf = Buffer.alloc(16);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(8, 4);
  buf.write('WAVE', 8, 'ascii');
  return buf;
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;

describe('audio provider adapters — SSRF hardening', () => {
  beforeEach(() => {
    dnsMocks.promisesLookup.mockReset();
    dnsMocks.callbackLookup.mockReset();
    delete process.env.ALLOW_LOCAL_NETWORKS;
  });

  afterEach(async () => {
    if (originalAllowLocal === undefined) {
      delete process.env.ALLOW_LOCAL_NETWORKS;
    } else {
      process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
    }
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  describe('a 302 to cloud metadata is never followed', () => {
    it.each(TTS_CASES)('$name', async ({ config }) => {
      const origin = await startLoopback(redirectTo('http://169.254.169.254/latest/meta-data/'));

      await expect(generateTTS(config(origin.url), 'Hello')).rejects.toThrow(
        METADATA_BLOCK_MESSAGE,
      );

      expect(origin.requests()).toBe(1);
    });

    it.each(ASR_CASES)('$name', async ({ config }) => {
      const origin = await startLoopback(redirectTo('http://169.254.169.254/latest/meta-data/'));

      let caught: unknown;
      try {
        await transcribeAudio(config(origin.url), wavBuffer());
      } catch (error) {
        caught = error;
      }
      // The AI SDK wraps the transport failure, so check the whole cause chain.
      const blocked = findUnsafeNetworkTargetError(caught);
      expect(blocked?.message ?? (caught as Error)?.message).toContain(METADATA_BLOCK_MESSAGE);

      expect(origin.requests()).toBe(1);
    });

    it('Qwen voice registration', async () => {
      process.env.ALLOW_LOCAL_NETWORKS = 'true';
      const origin = await startLoopback(redirectTo('http://169.254.169.254/latest/meta-data/'));
      dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

      await expect(
        registerQwenVoice(
          {
            apiKey: 'k',
            baseUrl: `http://localhost:${origin.port}`,
            targetModel: 'qwen3-tts-vc',
            publicOnly: false,
          },
          { name: 'teacher', audio: new Uint8Array(64), text: 'reference' },
        ),
      ).rejects.toThrow(METADATA_BLOCK_MESSAGE);

      expect(origin.requests()).toBe(1);
    });
  });

  describe('a normal 200 response is returned', () => {
    it('OpenAI-compatible TTS returns the audio bytes', async () => {
      const origin = await startLoopback((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(Buffer.from([82, 73, 70, 70]));
      });

      const result = await generateTTS(openAiTts(origin.url), 'Hello');
      expect(result.audio).toEqual(new Uint8Array([82, 73, 70, 70]));
    });

    it('OpenAI-compatible ASR returns the transcript', async () => {
      const origin = await startLoopback(jsonResponse({ text: 'hello class' }));

      const result = await transcribeAudio(openAiAsr(origin.url), wavBuffer());
      expect(result).toEqual({ text: 'hello class' });
    });

    it('VoxCPM voice registration returns the registered name', async () => {
      const origin = await startLoopback(
        jsonResponse({ success: true, voice: { name: 'voxcpm:voice:abc' } }),
      );

      const id = await registerVoxCPMVoice(
        { baseUrl: origin.url, apiKey: 'k', publicOnly: false },
        { voiceId: 'voxcpm:voice:abc', referenceAudioBase64: btoa('RIFFdata') },
      );
      expect(id).toBe('voxcpm:voice:abc');
    });
  });

  describe('DNS rebinding at connect time is refused by the pinned dispatcher', () => {
    it('OpenAI TTS never reaches the rebound loopback server', async () => {
      const internal = await startLoopback(jsonResponse({ ok: true }));
      dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

      await expect(
        generateTTS(
          {
            providerId: 'openai-tts',
            apiKey: 'sk',
            baseUrl: `http://rebind.test:${internal.port}`,
            voice: 'alloy',
            publicOnly: true,
          },
          'Hello',
        ),
      ).rejects.toThrow(PRIVATE_BLOCK_MESSAGE);

      expect(internal.requests()).toBe(0);
    });

    it('custom ASR never reaches the rebound loopback server', async () => {
      const internal = await startLoopback(jsonResponse({ text: 'secret' }));
      dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

      await expect(
        transcribeAudio(
          {
            providerId: 'custom-asr-local',
            apiKey: 'k',
            baseUrl: `http://rebind.test:${internal.port}`,
            modelId: 'whisper-1',
            publicOnly: true,
          },
          wavBuffer(),
        ),
      ).rejects.toThrow(PRIVATE_BLOCK_MESSAGE);

      expect(internal.requests()).toBe(0);
    });

    it('voice registration never reaches the rebound loopback server', async () => {
      const internal = await startLoopback(jsonResponse({ voices: [] }));
      dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

      await expect(
        voxCPMVoiceExists(
          {
            baseUrl: `http://rebind.test:${internal.port}`,
            apiKey: 'k',
            publicOnly: true,
          },
          'voxcpm:voice:abc',
        ),
      ).rejects.toThrow(PRIVATE_BLOCK_MESSAGE);

      expect(internal.requests()).toBe(0);
    });
  });

  describe('server-selected policy', () => {
    it('permits a server-managed localhost backend when local networks are allowed', async () => {
      process.env.ALLOW_LOCAL_NETWORKS = 'true';
      const origin = await startLoopback(
        jsonResponse({ output: { voice: 'qwen_vc_authoritative' } }),
      );
      // The Qwen adapter accepts `localhost` over http; the pinned dispatcher
      // resolves it through the DNS double.
      dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

      const result = await registerQwenVoice(
        {
          apiKey: 'k',
          baseUrl: `http://localhost:${origin.port}`,
          targetModel: 'qwen3-tts-vc',
          publicOnly: false,
        },
        { name: 'teacher', audio: new Uint8Array(64), text: 'reference' },
      );
      expect(result.voiceId).toBe('qwen_vc_authoritative');
      expect(origin.requests()).toBe(1);
    });

    it('keeps metadata blocked through a redirect even when local networks are allowed', async () => {
      process.env.ALLOW_LOCAL_NETWORKS = 'true';
      const origin = await startLoopback(redirectTo('http://169.254.169.254/latest/meta-data/'));

      await expect(
        registerVoxCPMVoice(
          {
            baseUrl: origin.url,
            apiKey: 'k',
            publicOnly: false,
          },
          { voiceId: 'v', referenceAudioBase64: btoa('x') },
        ),
      ).rejects.toThrow(METADATA_BLOCK_MESSAGE);

      expect(origin.requests()).toBe(1);
    });
  });
});
