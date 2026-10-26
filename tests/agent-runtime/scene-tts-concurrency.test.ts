import type { AgentTool } from '@earendil-works/pi-agent-core';
import { DEFAULT_MAX_DELAY_MS } from '@openmaic/generation';
import { Type } from 'typebox';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_TOOL_TIMEOUT_ENV,
  DEFAULT_AGENT_TOOL_TIMEOUT_MS,
  withAgentToolTimeout,
} from '@/lib/agent/runtime/tool-timeout';
import { TTSRateLimitError, TTSRequestTimeoutError } from '@/lib/audio/tts-providers';
import type { SceneTtsFailure } from '@/lib/server/agent-runtime/scene-tts';
import { runFailureCode, type RunFailureErrorCode } from '@/lib/server/generation/run/failure-code';
import { SCENE_MAX_RETRIES } from '@/lib/server/generation/run/retry';
import { ProviderQuotaExhaustedError } from '@/lib/server/provider-quota';
import type { Scene } from '@/lib/types/stage';

type ReasonMatchesClassifier = SceneTtsFailure['reason'] extends RunFailureErrorCode
  ? RunFailureErrorCode extends SceneTtsFailure['reason']
    ? true
    : never
  : never;
const reasonMatchesClassifier: ReasonMatchesClassifier = true;
void reasonMatchesClassifier;

const mocks = vi.hoisted(() => ({
  providers: vi.fn(),
  generate: vi.fn(),
  persist: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', () => ({
  resolveTTSModel: vi.fn(() => ''),
  slotTTSModel: vi.fn(() => ''),
}));
vi.mock('@/lib/server/model-config/media', async (original) => ({
  ...(await original<typeof import('@/lib/server/model-config/media')>()),
  serverMediaConnection: (...args: unknown[]) => mocks.providers(...args),
}));
vi.mock('@/lib/audio/tts-providers', async (original) => ({
  ...(await original<typeof import('@/lib/audio/tts-providers')>()),
  generateTTS: (...args: unknown[]) => mocks.generate(...args),
}));
vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: (...args: unknown[]) => mocks.persist(...args),
}));

import {
  resetAgentTtsProviderGatesForTests,
  synthesizeSceneNarration,
} from '@/lib/server/agent-runtime/scene-tts';

/** Parallel agent calls must share one in-flight provider request, not one each. */
const IN_FLIGHT_CAP = 1;
const PARALLEL_CALLS = 8;

const RAW_PROVIDER_BODY = 'RAW_PROVIDER_BODY {"base_resp":{"status_msg":"secret-upstream"}}';

const connection = {
  providerId: 'configured-tts',
  managed: true,
  userEndpoint: false,
  origin: 'configuration',
};

const ToolParams = Type.Object({});

/** A generate_tts-shaped tool. That name is not in the per-tool timeout map, so the env budget is what withAgentToolTimeout stamps. */
function generateTtsTool(
  execute: AgentTool<typeof ToolParams>['execute'],
): AgentTool<typeof ToolParams> {
  return {
    name: 'generate_tts',
    label: 'Generate TTS',
    description: 'Test tool',
    parameters: ToolParams,
    execute,
  };
}

function scene(id: string): Scene {
  return {
    id: `scene-${id}`,
    stageId: 'stage-a',
    order: 1,
    title: 'A',
    type: 'slide',
    content: { type: 'slide' },
    actions: [{ id: `speech-${id}`, type: 'speech', text: 'Hello' }],
  } as Scene;
}

describe('agent TTS in-flight cap', () => {
  beforeEach(() => {
    resetAgentTtsProviderGatesForTests();
    vi.clearAllMocks();
    mocks.providers.mockResolvedValue(connection);
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts.mp3');
  });

  it('never has more provider calls in flight than the shared cap', async () => {
    expect(IN_FLIGHT_CAP).toBeLessThan(PARALLEL_CALLS);

    let inFlight = 0;
    let peak = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.generate.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await gate;
        return { audio: new Uint8Array([1]), format: 'mp3' };
      } finally {
        inFlight -= 1;
      }
    });

    const pending = Promise.all(
      Array.from({ length: PARALLEL_CALLS }, (_, index) =>
        synthesizeSceneNarration({
          scene: scene(String(index)),
          force: false,
          ownerId: 'user:alice',
        }),
      ),
    );

    try {
      await vi.waitFor(() =>
        expect(mocks.generate.mock.calls.length).toBeGreaterThanOrEqual(IN_FLIGHT_CAP),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(peak).toBe(IN_FLIGHT_CAP);
      expect(inFlight).toBeLessThanOrEqual(IN_FLIGHT_CAP);
    } finally {
      release();
    }

    const summaries = await pending;
    expect(peak).toBe(IN_FLIGHT_CAP);
    expect(summaries).toHaveLength(PARALLEL_CALLS);
    expect(
      summaries.every((summary) => summary.generated === 1 && summary.failed.length === 0),
    ).toBe(true);
  });

  it('does not block two owners that use different keys', async () => {
    mocks.providers.mockImplementation(async (_kind: unknown, ownerId: unknown) => ({
      ...connection,
      providerId: 'configured-tts',
      baseUrl: 'https://tts.example/v1',
      apiKey: ownerId === 'user:b' ? 'key-b' : 'key-a',
      managed: false,
    }));
    let inFlightA = 0;
    let inFlightB = 0;
    let peakA = 0;
    let peakB = 0;
    let peakTotal = 0;
    let releaseA = () => {};
    let releaseB = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    mocks.generate.mockImplementation(async (config: { apiKey?: string }) => {
      const ownerA = config.apiKey === 'key-a';
      if (ownerA) inFlightA += 1;
      else inFlightB += 1;
      peakA = Math.max(peakA, inFlightA);
      peakB = Math.max(peakB, inFlightB);
      peakTotal = Math.max(peakTotal, inFlightA + inFlightB);
      try {
        await (ownerA ? gateA : gateB);
        return { audio: new Uint8Array([1]), format: 'mp3' };
      } finally {
        if (ownerA) inFlightA -= 1;
        else inFlightB -= 1;
      }
    });

    const pending = Promise.all([
      synthesizeSceneNarration({ scene: scene('a1'), force: false, ownerId: 'user:a' }),
      synthesizeSceneNarration({ scene: scene('a2'), force: false, ownerId: 'user:a' }),
      synthesizeSceneNarration({ scene: scene('b1'), force: false, ownerId: 'user:b' }),
    ]);
    try {
      await vi.waitFor(() => expect(mocks.generate.mock.calls.length).toBeGreaterThanOrEqual(2));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(peakA).toBe(1);
      expect(peakB).toBe(1);
      expect(peakTotal).toBe(2);
      expect(mocks.generate.mock.calls.length).toBe(2);
    } finally {
      releaseA();
      releaseB();
    }
    const summaries = await pending;
    expect(peakA).toBe(1);
    expect(peakB).toBe(1);
    expect(peakTotal).toBe(2);
    expect(summaries.every((summary) => summary.generated === 1)).toBe(true);
  });

  it('does not block two owners that use different base URLs', async () => {
    mocks.providers.mockImplementation(async (_kind: unknown, ownerId: unknown) => ({
      ...connection,
      providerId: 'configured-tts',
      baseUrl: ownerId === 'user:b' ? 'https://b.example/v1' : 'https://a.example/v1',
      apiKey: 'shared-key',
      managed: false,
    }));
    let inFlight = 0;
    let peak = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.generate.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await gate;
        return { audio: new Uint8Array([1]), format: 'mp3' };
      } finally {
        inFlight -= 1;
      }
    });
    const pending = Promise.all([
      synthesizeSceneNarration({ scene: scene('u1'), force: false, ownerId: 'user:a' }),
      synthesizeSceneNarration({ scene: scene('u2'), force: false, ownerId: 'user:b' }),
    ]);
    try {
      await vi.waitFor(() => expect(mocks.generate.mock.calls.length).toBeGreaterThanOrEqual(2));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(peak).toBe(2);
      expect(mocks.generate.mock.calls.length).toBe(2);
    } finally {
      release();
    }
    const summaries = await pending;
    expect(peak).toBe(2);
    expect(summaries.every((summary) => summary.generated === 1)).toBe(true);
  });

  it('does not block two unmanaged connections that differ only by providerId', async () => {
    mocks.providers.mockImplementation(async (_kind: unknown, ownerId: unknown) => ({
      ...connection,
      providerId: ownerId === 'user:b' ? 'provider-b' : 'provider-a',
      baseUrl: 'https://tts.example/v1',
      apiKey: 'shared-key',
      managed: false,
    }));
    let inFlight = 0;
    let peak = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.generate.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await gate;
        return { audio: new Uint8Array([1]), format: 'mp3' };
      } finally {
        inFlight -= 1;
      }
    });
    const pending = Promise.all([
      synthesizeSceneNarration({ scene: scene('p1'), force: false, ownerId: 'user:a' }),
      synthesizeSceneNarration({ scene: scene('p2'), force: false, ownerId: 'user:b' }),
    ]);
    try {
      await vi.waitFor(() => expect(mocks.generate.mock.calls.length).toBeGreaterThanOrEqual(2));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(peak).toBe(2);
      expect(mocks.generate.mock.calls.length).toBe(2);
    } finally {
      release();
    }
    const summaries = await pending;
    expect(peak).toBe(2);
    expect(summaries.every((summary) => summary.generated === 1)).toBe(true);
  });

  it('shares one cap for one managed connection id', async () => {
    mocks.providers.mockImplementation(async (_kind: unknown, ownerId: unknown) => ({
      ...connection,
      providerId: ownerId === 'user:b' ? 'provider-b' : 'provider-a',
      baseUrl: ownerId === 'user:b' ? 'https://b.example/v1' : 'https://a.example/v1',
      apiKey: ownerId === 'user:b' ? 'key-b' : 'key-a',
      deploymentProviderId: 'managed-tts',
      managed: true,
    }));
    let inFlight = 0;
    let peak = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.generate.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await gate;
        return { audio: new Uint8Array([1]), format: 'mp3' };
      } finally {
        inFlight -= 1;
      }
    });
    const pending = Promise.all([
      synthesizeSceneNarration({ scene: scene('m1'), force: false, ownerId: 'user:a' }),
      synthesizeSceneNarration({ scene: scene('m2'), force: false, ownerId: 'user:b' }),
    ]);
    try {
      await vi.waitFor(() => expect(mocks.generate.mock.calls.length).toBeGreaterThanOrEqual(1));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(peak).toBe(1);
      expect(mocks.generate.mock.calls.length).toBe(1);
    } finally {
      release();
    }
    const summaries = await pending;
    expect(peak).toBe(1);
    expect(summaries.every((summary) => summary.generated === 1)).toBe(true);
  });

  it('releases the in-flight slot during a Retry-After sleep', async () => {
    let inFlight = 0;
    let peak = 0;
    const samplesDuringSleep: number[] = [];
    const limited = new Set<string>();
    let releaseSleep = () => {};
    const sleepGate = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    let enteredSleep: () => void = () => {};
    const sleepStarted = new Promise<void>((resolve) => {
      enteredSleep = resolve;
    });
    mocks.generate.mockImplementation(async (_config: unknown, text: unknown) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        const key = String(text);
        if (!limited.has(key)) {
          limited.add(key);
          throw new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, 5_000);
        }
        return { audio: new Uint8Array([1]), format: 'mp3' };
      } finally {
        inFlight -= 1;
      }
    });

    const sleep = async (ms: number) => {
      // A peer waits for the remaining deadline, which is a few ms under Retry-After.
      expect(ms).toBeGreaterThanOrEqual(4_000);
      expect(ms).toBeLessThanOrEqual(DEFAULT_MAX_DELAY_MS);
      samplesDuringSleep.push(inFlight);
      enteredSleep();
      await sleepGate;
      samplesDuringSleep.push(inFlight);
    };
    const pending = Promise.all([
      synthesizeSceneNarration({
        scene: scene('a'),
        force: false,
        ownerId: 'user:alice',
        sleep,
      }),
      synthesizeSceneNarration({
        scene: scene('b'),
        force: false,
        ownerId: 'user:alice',
        sleep,
      }),
    ]);

    try {
      await sleepStarted;
      await new Promise((resolve) => setTimeout(resolve, 40));
      samplesDuringSleep.push(inFlight);
      expect(inFlight).toBe(0);
      expect(peak).toBeLessThanOrEqual(IN_FLIGHT_CAP);
      // The slot is free, but this connection's Retry-After still blocks the peer.
      expect(mocks.generate.mock.calls.length).toBe(1);
    } finally {
      releaseSleep();
    }

    const summaries = await pending;
    expect(samplesDuringSleep.length).toBeGreaterThan(0);
    expect(samplesDuringSleep.every((count) => count <= IN_FLIGHT_CAP)).toBe(true);
    expect(peak).toBe(IN_FLIGHT_CAP);
    expect(
      summaries.every((summary) => summary.generated === 1 && summary.failed.length === 0),
    ).toBe(true);
  });

  it('honors OPENMAIC_AGENT_TTS_CONCURRENCY for one connection', async () => {
    const previous = process.env.OPENMAIC_AGENT_TTS_CONCURRENCY;
    process.env.OPENMAIC_AGENT_TTS_CONCURRENCY = '2';
    mocks.providers.mockResolvedValue({
      ...connection,
      providerId: 'configured-tts',
      baseUrl: 'https://tts.example/v1',
      apiKey: 'key-configured-cap',
      managed: false,
    });
    let inFlight = 0;
    let peak = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.generate.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await gate;
        return { audio: new Uint8Array([1]), format: 'mp3' };
      } finally {
        inFlight -= 1;
      }
    });
    const pending = Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        synthesizeSceneNarration({
          scene: scene(`cap-${index}`),
          force: false,
          ownerId: 'user:cap',
        }),
      ),
    );
    try {
      await vi.waitFor(() => expect(mocks.generate.mock.calls.length).toBeGreaterThanOrEqual(2));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(peak).toBe(2);
      expect(inFlight).toBeLessThanOrEqual(2);
      expect(mocks.generate.mock.calls.length).toBe(2);
    } finally {
      release();
      if (previous === undefined) delete process.env.OPENMAIC_AGENT_TTS_CONCURRENCY;
      else process.env.OPENMAIC_AGENT_TTS_CONCURRENCY = previous;
    }
    const summaries = await pending;
    expect(peak).toBe(2);
    expect(summaries.every((summary) => summary.generated === 1)).toBe(true);
  });

  it('releases the in-flight slot during a retry sleep that is not a Retry-After', async () => {
    let inFlight = 0;
    let peak = 0;
    const retried = new Set<string>();
    let releaseSleep = () => {};
    const sleepGate = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    let enteredSleep: () => void = () => {};
    const sleepStarted = new Promise<void>((resolve) => {
      enteredSleep = resolve;
    });
    mocks.generate.mockImplementation(async (_config: unknown, text: unknown) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        const key = String(text);
        if (!retried.has(key)) {
          retried.add(key);
          throw Object.assign(new Error('upstream'), { statusCode: 500 });
        }
        return { audio: new Uint8Array([1]), format: 'mp3' };
      } finally {
        inFlight -= 1;
      }
    });
    const sleep = async () => {
      enteredSleep();
      await sleepGate;
    };
    const pending = Promise.all([
      synthesizeSceneNarration({
        scene: scene('retry-a'),
        force: false,
        ownerId: 'user:alice',
        sleep,
      }),
      synthesizeSceneNarration({
        scene: scene('retry-b'),
        force: false,
        ownerId: 'user:alice',
        sleep,
      }),
    ]);
    try {
      await sleepStarted;
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(inFlight).toBeLessThanOrEqual(IN_FLIGHT_CAP);
      expect(mocks.generate.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      releaseSleep();
    }
    const summaries = await pending;
    expect(peak).toBe(IN_FLIGHT_CAP);
    expect(
      summaries.every((summary) => summary.generated === 1 && summary.failed.length === 0),
    ).toBe(true);
  });

  it('drops an idle connection gate so a later concurrency cap applies', async () => {
    const previous = process.env.OPENMAIC_AGENT_TTS_CONCURRENCY;
    mocks.providers.mockResolvedValue({
      ...connection,
      providerId: 'configured-tts',
      baseUrl: 'https://tts.example/v1',
      apiKey: 'key-evict-idle',
      managed: false,
    });
    process.env.OPENMAIC_AGENT_TTS_CONCURRENCY = '1';
    mocks.generate.mockResolvedValue({ audio: new Uint8Array([1]), format: 'mp3' });
    try {
      await synthesizeSceneNarration({
        scene: scene('warm'),
        force: false,
        ownerId: 'user:evict',
      });
      mocks.generate.mockClear();

      process.env.OPENMAIC_AGENT_TTS_CONCURRENCY = '3';
      let inFlight = 0;
      let peak = 0;
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mocks.generate.mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          await gate;
          return { audio: new Uint8Array([1]), format: 'mp3' };
        } finally {
          inFlight -= 1;
        }
      });
      const pending = Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          synthesizeSceneNarration({
            scene: scene(`evict-${index}`),
            force: false,
            ownerId: 'user:evict',
          }),
        ),
      );
      try {
        await vi.waitFor(() => expect(mocks.generate.mock.calls.length).toBeGreaterThanOrEqual(3));
        expect(peak).toBe(3);
        expect(inFlight).toBe(3);
      } finally {
        release();
      }
      const summaries = await pending;
      expect(summaries.every((summary) => summary.generated === 1)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENMAIC_AGENT_TTS_CONCURRENCY;
      else process.env.OPENMAIC_AGENT_TTS_CONCURRENCY = previous;
    }
  });

  it('keeps the connection gate while a caller is still in flight', async () => {
    const previous = process.env.OPENMAIC_AGENT_TTS_CONCURRENCY;
    mocks.providers.mockResolvedValue({
      ...connection,
      providerId: 'configured-tts',
      baseUrl: 'https://tts.example/v1',
      apiKey: 'key-evict-busy',
      managed: false,
    });
    process.env.OPENMAIC_AGENT_TTS_CONCURRENCY = '1';
    let inFlight = 0;
    let peak = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.generate.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await gate;
        return { audio: new Uint8Array([1]), format: 'mp3' };
      } finally {
        inFlight -= 1;
      }
    });
    const pending = Promise.all([
      synthesizeSceneNarration({ scene: scene('busy-1'), force: false, ownerId: 'user:busy' }),
      synthesizeSceneNarration({ scene: scene('busy-2'), force: false, ownerId: 'user:busy' }),
    ]);
    try {
      await vi.waitFor(() => expect(mocks.generate.mock.calls.length).toBeGreaterThanOrEqual(1));
      process.env.OPENMAIC_AGENT_TTS_CONCURRENCY = '4';
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(mocks.generate.mock.calls.length).toBe(1);
      expect(peak).toBe(1);
      expect(inFlight).toBe(1);
    } finally {
      release();
      if (previous === undefined) delete process.env.OPENMAIC_AGENT_TTS_CONCURRENCY;
      else process.env.OPENMAIC_AGENT_TTS_CONCURRENCY = previous;
    }
    const summaries = await pending;
    expect(summaries.every((summary) => summary.generated === 1)).toBe(true);
  });
});

describe('agent TTS failure classification', () => {
  beforeEach(() => {
    resetAgentTtsProviderGatesForTests();
    vi.clearAllMocks();
    mocks.providers.mockResolvedValue(connection);
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts.mp3');
  });

  it.each([
    {
      label: 'provider quota',
      reason: 'PROVIDER_QUOTA_EXHAUSTED',
      makeError: () => new ProviderQuotaExhaustedError('MiniMax', RAW_PROVIDER_BODY),
    },
    {
      label: 'typed rate limit',
      reason: 'RATE_LIMITED',
      makeError: () => new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY),
    },
    {
      label: 'upstream auth status',
      reason: 'UPSTREAM_ERROR',
      makeError: () => Object.assign(new Error(RAW_PROVIDER_BODY), { statusCode: 401 }),
    },
    {
      label: 'http 429',
      reason: 'RATE_LIMITED',
      makeError: () => Object.assign(new Error(RAW_PROVIDER_BODY), { statusCode: 429 }),
    },
    {
      label: 'other provider failure',
      reason: 'INTERNAL_ERROR',
      makeError: () => new Error(RAW_PROVIDER_BODY),
    },
  ])('records $label as { id, reason } ($reason)', async ({ makeError, reason }) => {
    const error = makeError();
    mocks.generate.mockRejectedValue(error);

    const summary = await synthesizeSceneNarration({
      scene: scene('a'),
      force: false,
      ownerId: 'user:alice',
      sleep: async () => {},
    });

    expect(summary.failed).toEqual([{ id: 'speech-a', reason }]);
    expect(reason).toBe(runFailureCode(error).errorCode);
    expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');
    expect(JSON.stringify(summary)).not.toContain('secret-upstream');
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('still aborts the call on TTSRequestTimeoutError', async () => {
    mocks.generate.mockRejectedValue(new TTSRequestTimeoutError('MiniMax', 'request timed out'));

    await expect(
      synthesizeSceneNarration({
        scene: scene('a'),
        force: false,
        ownerId: 'user:alice',
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(TTSRequestTimeoutError);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
});

describe('agent TTS classroom retry throttle', () => {
  beforeEach(() => {
    resetAgentTtsProviderGatesForTests();
    vi.clearAllMocks();
    mocks.providers.mockResolvedValue(connection);
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts.mp3');
  });

  function speeches(ids: string[]): Scene {
    return {
      ...scene('page'),
      actions: ids.map((id) => ({ id, type: 'speech', text: id })),
    } as Scene;
  }

  it('sleeps for Retry-After before the next speech line and retries the limited line', async () => {
    const events: string[] = [];
    let calls = 0;
    mocks.generate.mockImplementation(async (_config: unknown, text: unknown) => {
      calls += 1;
      events.push(`generate:${String(text)}`);
      if (calls === 1) throw new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, 5_000);
      return { audio: new Uint8Array([1]), format: 'mp3' };
    });

    const summary = await synthesizeSceneNarration({
      scene: speeches(['speech-1', 'speech-2']),
      force: false,
      ownerId: 'user:alice',
      sleep: async (ms) => {
        events.push(`sleep:${ms}`);
      },
    });

    expect(events[0]).toBe('generate:speech-1');
    expect(events[1]?.startsWith('sleep:')).toBe(true);
    expect(Number(events[1]?.slice('sleep:'.length))).toBeGreaterThanOrEqual(5_000);
    expect(events[2]).toBe('generate:speech-1');
    expect(events[3]).toBe('generate:speech-2');
    expect(summary.generated).toBe(2);
    expect(summary.failed).toEqual([]);
    expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');
  });

  it('clamps a Retry-After larger than the classroom backoff cap', async () => {
    const huge = DEFAULT_AGENT_TOOL_TIMEOUT_MS * 2;
    const sleeps: number[] = [];
    mocks.generate.mockRejectedValue(new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, huge));

    const summary = await synthesizeSceneNarration({
      scene: scene('a'),
      force: false,
      ownerId: 'user:alice',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(huge).toBeGreaterThan(DEFAULT_MAX_DELAY_MS);
    expect(sleeps).toHaveLength(SCENE_MAX_RETRIES);
    expect(sleeps.every((ms) => ms === DEFAULT_MAX_DELAY_MS)).toBe(true);
    expect(summary.failed).toEqual([{ id: 'speech-a', reason: 'RATE_LIMITED' }]);
    expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');
  });

  it('fails the line instead of sleeping when the remaining budget cannot fit the wait', async () => {
    const sleeps: number[] = [];
    mocks.generate.mockRejectedValue(new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, 5_000));

    const summary = await synthesizeSceneNarration({
      scene: scene('a'),
      force: false,
      ownerId: 'user:alice',
      budgetMs: 1_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps).toEqual([]);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(summary.failed).toEqual([{ id: 'speech-a', reason: 'RATE_LIMITED' }]);
    expect(summary.generated).toBe(0);
    expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');
  });

  it('still aborts on TTSRequestTimeoutError when the remaining budget is too small to wait', async () => {
    mocks.generate.mockRejectedValue(new TTSRequestTimeoutError('MiniMax', 'request timed out'));

    await expect(
      synthesizeSceneNarration({
        scene: scene('a'),
        force: false,
        ownerId: 'user:alice',
        budgetMs: 1,
        sleep: async () => {
          throw new Error('slept');
        },
      }),
    ).rejects.toBeInstanceOf(TTSRequestTimeoutError);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it('uses the classroom narration retry budget before recording a rate limit', async () => {
    const sleeps: number[] = [];
    mocks.generate.mockRejectedValue(new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, 5_000));

    const summary = await synthesizeSceneNarration({
      scene: scene('a'),
      force: false,
      ownerId: 'user:alice',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(mocks.generate).toHaveBeenCalledTimes(SCENE_MAX_RETRIES + 1);
    expect(sleeps).toHaveLength(SCENE_MAX_RETRIES);
    expect(sleeps.every((ms) => ms >= 5_000)).toBe(true);
    expect(summary.failed).toEqual([{ id: 'speech-a', reason: 'RATE_LIMITED' }]);
    expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');
  });

  it('does not retry a rate-limit error whose cause is quota exhaustion', async () => {
    const error = new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, 5_000, {
      cause: new ProviderQuotaExhaustedError('MiniMax', RAW_PROVIDER_BODY),
    });
    const sleeps: number[] = [];
    mocks.generate.mockRejectedValue(error);

    const summary = await synthesizeSceneNarration({
      scene: scene('a'),
      force: false,
      ownerId: 'user:alice',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(summary.failed).toEqual([{ id: 'speech-a', reason: 'PROVIDER_QUOTA_EXHAUSTED' }]);
    expect(summary.failed[0]?.reason).toBe(runFailureCode(error).errorCode);
    expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');
  });

  it('does not pace lines that were never attempted when HTTP 429 is a quota refusal with Retry-After', async () => {
    mocks.providers.mockResolvedValue({
      ...connection,
      providerId: 'configured-tts',
      baseUrl: 'https://tts.example/v1',
      apiKey: 'key-quota-retry-after',
      managed: false,
    });
    // generateTTS shape for HTTP 429 + MiniMax quota body (status_code 2056) + Retry-After.
    const error = new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, 5_000, {
      cause: new ProviderQuotaExhaustedError('MiniMax', RAW_PROVIDER_BODY),
    });
    mocks.generate.mockRejectedValue(error);
    const sleeps: number[] = [];
    const summary = await synthesizeSceneNarration({
      scene: speeches(['speech-1', 'speech-2']),
      force: false,
      ownerId: 'user:quota-retry-after',
      budgetMs: 1_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps).toEqual([]);
    expect(mocks.generate.mock.calls.map((call) => call[1])).toEqual(['speech-1', 'speech-2']);
    expect(summary.failed).toEqual([
      { id: 'speech-1', reason: 'PROVIDER_QUOTA_EXHAUSTED' },
      { id: 'speech-2', reason: 'PROVIDER_QUOTA_EXHAUSTED' },
    ]);
    expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');

    mocks.generate.mockClear();
    const later = await synthesizeSceneNarration({
      scene: scene('quota-later'),
      force: false,
      ownerId: 'user:quota-retry-after',
      budgetMs: 1_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps).toEqual([]);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(later.failed).toEqual([
      { id: 'speech-quota-later', reason: 'PROVIDER_QUOTA_EXHAUSTED' },
    ]);
    expect(JSON.stringify(later)).not.toContain('RAW_PROVIDER_BODY');
  });

  it('waits out the last Retry-After before the next speech line', async () => {
    const huge = DEFAULT_AGENT_TOOL_TIMEOUT_MS * 2;
    const sleeps: number[] = [];
    mocks.generate.mockImplementation(async (_config: unknown, text: unknown) => {
      if (text === 'speech-1') throw new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, huge);
      return { audio: new Uint8Array([1]), format: 'mp3' };
    });

    const summary = await synthesizeSceneNarration({
      scene: speeches(['speech-1', 'speech-2']),
      force: false,
      ownerId: 'user:alice',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(huge).toBeGreaterThan(DEFAULT_MAX_DELAY_MS);
    expect(sleeps).toHaveLength(SCENE_MAX_RETRIES + 1);
    expect(sleeps.slice(0, SCENE_MAX_RETRIES).every((ms) => ms === DEFAULT_MAX_DELAY_MS)).toBe(
      true,
    );
    const carried = sleeps.at(-1) ?? 0;
    expect(carried).toBeGreaterThanOrEqual(DEFAULT_MAX_DELAY_MS - 1_000);
    expect(carried).toBeLessThanOrEqual(DEFAULT_MAX_DELAY_MS);
    expect(summary.generated).toBe(1);
    expect(summary.failed).toEqual([{ id: 'speech-1', reason: 'RATE_LIMITED' }]);
    expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');
  });

  it('makes a later narration call wait for the same connection Retry-After', async () => {
    mocks.providers.mockResolvedValue({
      ...connection,
      providerId: 'configured-tts',
      baseUrl: 'https://tts.example/v1',
      apiKey: 'key-later-cooldown',
      managed: false,
    });
    mocks.generate.mockRejectedValue(new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, 4_000));
    await synthesizeSceneNarration({
      scene: scene('later-1'),
      force: false,
      ownerId: 'user:later',
      sleep: async () => {},
    });

    const sleeps: number[] = [];
    mocks.generate.mockImplementation(async () => {
      return { audio: new Uint8Array([1]), format: 'mp3' };
    });
    const summary = await synthesizeSceneNarration({
      scene: scene('later-2'),
      force: false,
      ownerId: 'user:later',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps[0]).toBeGreaterThanOrEqual(3_000);
    expect(sleeps[0]).toBeLessThanOrEqual(DEFAULT_MAX_DELAY_MS);
    expect(summary.generated).toBe(1);
    expect(summary.failed).toEqual([]);
    expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');
  });

  it('fails a later call instead of sleeping when the carried Retry-After exceeds the budget', async () => {
    mocks.providers.mockResolvedValue({
      ...connection,
      providerId: 'configured-tts',
      baseUrl: 'https://tts.example/v1',
      apiKey: 'key-budget-carry',
      managed: false,
    });
    mocks.generate.mockRejectedValue(new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, 5_000));
    await synthesizeSceneNarration({
      scene: scene('budget-1'),
      force: false,
      ownerId: 'user:budget-carry',
      sleep: async () => {},
    });

    const sleeps: number[] = [];
    mocks.generate.mockClear();
    const summary = await synthesizeSceneNarration({
      scene: scene('budget-2'),
      force: false,
      ownerId: 'user:budget-carry',
      budgetMs: 1_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps).toEqual([]);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(summary.failed).toEqual([{ id: 'speech-budget-2', reason: 'RATE_LIMITED' }]);
    expect(summary.generated).toBe(0);
    expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');
  });

  it('uses the stamped tool budget, not budgetMs, when Retry-After does not fit', async () => {
    mocks.providers.mockResolvedValue({
      ...connection,
      providerId: 'configured-tts',
      baseUrl: 'https://tts.example/v1',
      apiKey: 'key-budget-signal',
      managed: false,
    });
    mocks.generate.mockRejectedValue(new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, 5_000));
    await synthesizeSceneNarration({
      scene: scene('budget-signal-1'),
      force: false,
      ownerId: 'user:budget-signal',
      sleep: async () => {},
    });

    const sleeps: number[] = [];
    mocks.generate.mockClear();
    mocks.generate.mockResolvedValue({ audio: new Uint8Array([1]), format: 'mp3' });
    const previousTimeout = process.env[AGENT_TOOL_TIMEOUT_ENV];
    process.env[AGENT_TOOL_TIMEOUT_ENV] = '1000';
    try {
      let summary: Awaited<ReturnType<typeof synthesizeSceneNarration>> | undefined;
      const tool = withAgentToolTimeout(
        generateTtsTool(async (_id, _args, signal) => {
          summary = await synthesizeSceneNarration({
            scene: scene('budget-signal-2'),
            force: false,
            ownerId: 'user:budget-signal',
            // Large enough to cover the 5s Retry-After. The stamped signal is shorter.
            budgetMs: 60_000,
            signal,
            sleep: async (ms) => {
              sleeps.push(ms);
            },
          });
          return { content: [{ type: 'text', text: 'ok' }], details: {} };
        }),
      );

      await tool.execute('call-budget-signal', {}, undefined);

      expect(sleeps).toEqual([]);
      expect(mocks.generate).not.toHaveBeenCalled();
      expect(summary?.failed).toEqual([{ id: 'speech-budget-signal-2', reason: 'RATE_LIMITED' }]);
      expect(summary?.generated).toBe(0);
      expect(JSON.stringify(summary)).not.toContain('RAW_PROVIDER_BODY');
    } finally {
      if (previousTimeout === undefined) delete process.env[AGENT_TOOL_TIMEOUT_ENV];
      else process.env[AGENT_TOOL_TIMEOUT_ENV] = previousTimeout;
    }
  });

  it('does not apply one connection Retry-After to another connection', async () => {
    mocks.providers.mockImplementation(async (_kind: unknown, ownerId: unknown) => ({
      ...connection,
      providerId: 'configured-tts',
      baseUrl: 'https://tts.example/v1',
      apiKey: ownerId === 'user:other-cooldown' ? 'key-other-cooldown' : 'key-paced-cooldown',
      managed: false,
    }));
    mocks.generate.mockImplementation(async (config: { apiKey?: string }) => {
      if (config.apiKey === 'key-paced-cooldown') {
        throw new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, 5_000);
      }
      return { audio: new Uint8Array([1]), format: 'mp3' };
    });
    await synthesizeSceneNarration({
      scene: scene('paced-conn'),
      force: false,
      ownerId: 'user:paced-cooldown',
      sleep: async () => {},
    });

    const sleeps: number[] = [];
    const summary = await synthesizeSceneNarration({
      scene: scene('other-conn'),
      force: false,
      ownerId: 'user:other-cooldown',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps).toEqual([]);
    expect(summary.generated).toBe(1);
    expect(summary.failed).toEqual([]);
  });

  it('shares one Retry-After across parallel narration calls on the same connection', async () => {
    mocks.providers.mockResolvedValue({
      ...connection,
      providerId: 'configured-tts',
      baseUrl: 'https://tts.example/v1',
      apiKey: 'key-parallel-cooldown',
      managed: false,
    });
    let releaseSleep = () => {};
    const sleepGate = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    let enteredSleep: () => void = () => {};
    const sleepStarted = new Promise<void>((resolve) => {
      enteredSleep = resolve;
    });
    mocks.generate.mockImplementation(async () => {
      throw new TTSRateLimitError('MiniMax', RAW_PROVIDER_BODY, 5_000);
    });
    const sleep = async (ms: number) => {
      expect(ms).toBeGreaterThanOrEqual(4_000);
      expect(ms).toBeLessThanOrEqual(DEFAULT_MAX_DELAY_MS);
      enteredSleep();
      await sleepGate;
    };
    const first = synthesizeSceneNarration({
      scene: scene('par-1'),
      force: false,
      ownerId: 'user:parallel-cooldown',
      sleep,
    });
    await sleepStarted;
    const callsAtSleep = mocks.generate.mock.calls.length;
    const second = synthesizeSceneNarration({
      scene: scene('par-2'),
      force: false,
      ownerId: 'user:parallel-cooldown',
      sleep,
    });
    let summaries: Awaited<ReturnType<typeof synthesizeSceneNarration>>[];
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(mocks.generate.mock.calls.length).toBe(callsAtSleep);
    } finally {
      releaseSleep();
      summaries = await Promise.all([first, second]);
    }
    expect(
      summaries.every((summary) => summary.generated === 0 && summary.failed.length === 1),
    ).toBe(true);
    expect(
      summaries
        .flatMap((summary) => summary.failed)
        .every((failure) => failure.reason === 'RATE_LIMITED'),
    ).toBe(true);
    expect(JSON.stringify(summaries)).not.toContain('RAW_PROVIDER_BODY');
  });
});
