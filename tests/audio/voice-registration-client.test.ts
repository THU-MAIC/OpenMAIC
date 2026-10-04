// @vitest-environment jsdom
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

import {
  deleteRegisteredVoice,
  ensureRegisteredVoice,
  registerVoiceFromReference,
} from '@/lib/audio/voice-registration-client';

import { modelSettingsViewFor, setModelSettingsViewForTests } from '../helpers/model-settings-view';
import { modelSettingsClient } from '@/lib/model-settings/client';

function okFetch() {
  const f = vi.fn(
    async () => new Response(JSON.stringify({ voiceId: 'x', registered: true }), { status: 200 }),
  );
  vi.stubGlobal('fetch', f);
  return f;
}

describe('ensureRegisteredVoice memoization', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    setModelSettingsViewForTests(null);
  });

  it('registers again when the tts slot moves to another backend serving the same model', async () => {
    const f = okFetch();
    const voiceDesign = { identity: 'backend-switch teacher', texture: 'warm', delivery: 'calm' };
    const request = { ttsModelId: 'voxcpm-model' };

    setModelSettingsViewForTests({ tts: { registryId: 'voxcpm-tts', providerId: 'voxcpm-a' } });
    await ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, request);
    await ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, request);
    expect(f).toHaveBeenCalledTimes(1);

    // Another backend (another provider of the same preset), same model.
    setModelSettingsViewForTests({ tts: { registryId: 'voxcpm-tts', providerId: 'voxcpm-b' } });
    await ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, request);
    expect(f).toHaveBeenCalledTimes(2);

    // The same provider after an edit to the settings (a new revision).
    const edited = modelSettingsViewFor({
      tts: { registryId: 'voxcpm-tts', providerId: 'voxcpm-b' },
    });
    edited.revision = 7;
    modelSettingsClient.adopt(edited);
    await ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, request);
    expect(f).toHaveBeenCalledTimes(3);
    await ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, request);
    expect(f).toHaveBeenCalledTimes(3);
  });

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

  it('sends no provider, model, key or endpoint: the server uses the tts slot', async () => {
    const f = okFetch();
    const voiceDesign = { identity: 'slot teacher', texture: 'warm', delivery: 'calm' };

    await ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, { ttsModelId: 'model-d' });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    for (const field of ['providerId', 'ttsModelId', 'ttsApiKey', 'ttsBaseUrl']) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it('registers and deletes a user voice without routing fields', async () => {
    const f = okFetch();
    await registerVoiceFromReference('qwen-tts', {
      name: 'My voice',
      referenceAudio: new Blob(['wav'], { type: 'audio/wav' }),
      refText: 'Hello',
    });
    await deleteRegisteredVoice('qwen-tts', 'x');
    for (const call of f.mock.calls as unknown as [string, RequestInit][]) {
      const body = JSON.parse(String(call[1].body));
      expect(body).not.toHaveProperty('providerId');
      expect(body).not.toHaveProperty('ttsModelId');
    }
    expect(f).toHaveBeenCalledTimes(2);
  });
});
