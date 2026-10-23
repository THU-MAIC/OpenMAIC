import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSessionMaterial } from '@openmaic/storage';
import type { RegisteredVoiceInfo } from '@/lib/audio/voice-catalog';
import { clearQwenVoiceRegistrationMemoForTests } from '@/lib/audio/qwen-voice-clone-registration';
import { DEFAULT_QWEN_TTS_VOICE_CLONE_MODEL } from '@/lib/audio/constants';
import { buildVoiceCloneTools } from '@/lib/server/agent-runtime/voice-clone-tools';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';

// Exercise both real registration adapters, including Qwen's readiness polling.
// Only the HTTP/DNS boundary and owner-scoped material storage are substituted.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('undici', async (original) => ({
  ...(await original<typeof import('undici')>()),
  fetch: fetchMock,
}));
vi.mock('node:dns', async (original) => {
  const actual = await original<typeof import('node:dns')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    },
  };
});

function referenceWav(): Buffer {
  const bytes = Buffer.alloc(44 + 24_000 * 5 * 2);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24);
  bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

const clip: AgentSessionMaterial = {
  id: 'clip',
  sessionId: 'session',
  kind: 'audio-track',
  title: 'Reference',
  sourceUrl: null,
  textAssetId: null,
  rawAssetId: 'audio',
  textChars: 0,
  derivedFrom: null,
  extraction: { status: 'done', attempts: 0 },
  createdAt: new Date(0).toISOString(),
};

afterEach(() => {
  vi.restoreAllMocks();
  clearQwenVoiceRegistrationMemoForTests();
  setDeploymentConfigForTests();
});

for (const providerId of ['qwen-tts', 'voxcpm-tts'] as const) {
  it.each([0, 1])(
    `${providerId}: cancel caller %i without canceling its peer or recording its result`,
    async (canceledIndex) => {
      fetchMock.mockReset();
      const model = DEFAULT_QWEN_TTS_VOICE_CLONE_MODEL;
      setDeploymentConfigForTests({
        layer: {
          source: 'deployment',
          config: {
            providers: { speech: { preset: providerId, apiKey: 'test', models: [model] } },
          },
        },
        legacy: false,
        notices: [],
      });
      let release!: () => void;
      const transportGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let creates = 0;
      fetchMock.mockImplementation(async (_url: unknown, init: RequestInit) => {
        if (providerId === 'qwen-tts') {
          const body = JSON.parse(String(init.body)) as { input: { action: string } };
          if (body.input.action === 'query_voice') {
            return Response.json({ output: { target_model: model, status: 'OK' } });
          }
          expect(body.input.action).toBe('create_voice');
        } else {
          expect((init.body as FormData).get('name')).toBe('Teacher');
        }
        creates++;
        // A transport that truly honors cancellation: do not hide accidental
        // cancellation of the shared operation by ignoring init.signal.
        await new Promise<void>((resolve, reject) => {
          const signal = init.signal;
          const aborted = () => reject(signal?.reason);
          if (signal?.aborted) return aborted();
          signal?.addEventListener('abort', aborted, { once: true });
          void transportGate.then(() => {
            signal?.removeEventListener('abort', aborted);
            resolve();
          });
        });
        return providerId === 'qwen-tts'
          ? Response.json({ output: { voice_id: `${model}-teacher` } })
          : Response.json({ voice: { name: 'Teacher' } });
      });
      const registry: RegisteredVoiceInfo[] = [];
      const registryChecks = vi.spyOn(registry, 'some');
      const readRawAsset = vi.fn(async () => ({ bytes: referenceWav(), mime: 'audio/wav' }));
      const register = buildVoiceCloneTools({
        sessionId: 'session',
        ttsConnection: {
          providerId,
          deploymentProviderId: 'speech',
          origin: 'configuration',
          apiKey: `test-${canceledIndex}`,
          baseUrl: 'https://speech.example.com/api/v1',
          managed: true,
          userEndpoint: false,
        },
        getMaterial: async () => clip,
        readRawAsset,
        registeredVoices: registry,
      }).find((candidate) => candidate.name === 'register_voice')!;
      const signals = [new AbortController(), new AbortController()];
      const params = { name: 'Teacher', clipId: 'clip', refText: 'Reference words.' };
      const first = register.execute('first', params as never, signals[0].signal);
      const observedFirst = Promise.allSettled([first]);
      await vi.waitFor(() => expect(creates).toBe(1));
      const second = register.execute('second', params as never, signals[1].signal);
      const observedSecond = Promise.allSettled([second]);
      await vi.waitFor(() => expect(readRawAsset).toHaveBeenCalledTimes(2));
      await new Promise<void>((resolve) => setImmediate(resolve));
      let canceledSettled = false;
      void (canceledIndex === 0 ? observedFirst : observedSecond).then(() => {
        canceledSettled = true;
      });
      const cancellation = new Error('caller stopped');
      signals[canceledIndex].abort(cancellation);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const settledBeforeTransport = canceledSettled;
      release();
      const results = [...(await observedFirst), ...(await observedSecond)];
      expect(results.map((result) => result.status)).toEqual(
        canceledIndex === 0 ? ['rejected', 'fulfilled'] : ['fulfilled', 'rejected'],
      );
      const canceledResult = results[canceledIndex];
      expect(canceledResult.status).toBe('rejected');
      if (canceledResult.status === 'rejected') expect(canceledResult.reason).toBe(cancellation);
      expect(settledBeforeTransport).toBe(true);
      expect(registry).toHaveLength(1);
      // Only the surviving caller enters the session registry, not even a
      // deduplicated registration attempt from the canceled caller.
      expect(registryChecks).toHaveBeenCalledTimes(1);
      expect(creates).toBe(1);
      await register.execute('retry', params as never, new AbortController().signal);
      expect(creates).toBe(1);
    },
  );
}
