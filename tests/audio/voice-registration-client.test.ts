import { describe, it, expect, vi, beforeEach } from 'vitest';

// db is browser-only (Dexie); stub it so the client module loads in node.
vi.mock('@/lib/device-storage/database', () => ({
  db: {
    autoVoiceCache: {
      get: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
    },
  },
}));

import { ensureRegisteredVoice } from '@/lib/audio/voice-registration-client';

function okFetch() {
  const f = vi.fn(
    async () => new Response(JSON.stringify({ voiceId: 'x', registered: true }), { status: 200 }),
  );
  vi.stubGlobal('fetch', f);
  return f;
}

describe('ensureRegisteredVoice memoization', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('registers a voice once per session and again for another model', async () => {
    const f = okFetch();
    // Distinct descriptor per test so the module-level memo from other tests can't collide.
    const voiceDesign = { identity: 'model-switch teacher', texture: 'warm', delivery: 'calm' };

    await ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, { ttsModelId: 'model-a' });
    // Same model again → memoized, no second round-trip.
    await ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, { ttsModelId: 'model-a' });
    expect(f).toHaveBeenCalledTimes(1);

    // Another model → must NOT be skipped by the memo.
    await ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, { ttsModelId: 'model-b' });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent calls for the same voice into one request', async () => {
    const f = okFetch();
    const voiceDesign = { identity: 'concurrent teacher', texture: 'warm', delivery: 'calm' };
    const req = { ttsModelId: 'model-c' };

    await Promise.all([
      ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, req),
      ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, req),
      ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, req),
    ]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('sends no provider key or endpoint: the server uses the tts slot', async () => {
    const f = okFetch();
    const voiceDesign = { identity: 'slot teacher', texture: 'warm', delivery: 'calm' };

    await ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, { ttsModelId: 'model-d' });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ providerId: 'voxcpm-tts', ttsModelId: 'model-d' });
    expect(body).not.toHaveProperty('ttsApiKey');
    expect(body).not.toHaveProperty('ttsBaseUrl');
  });
});
