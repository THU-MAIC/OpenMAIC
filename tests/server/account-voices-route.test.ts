import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as route from '@/app/api/generate/voice/route';
import {
  setDeploymentConfigForTests,
  setWorkspaceLayerLoaderForTests,
} from '@/lib/server/model-config/runtime';
import type { ModelConfigFile } from '@/lib/server/model-config/openmaic-yml';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  delete: vi.fn(),
  workspaceId: vi.fn(async () => 'user:one'),
}));

vi.mock('@/lib/server/model-config/runtime', async (original) => ({
  ...(await original<typeof import('@/lib/server/model-config/runtime')>()),
  requestWorkspaceId: mocks.workspaceId,
}));
vi.mock('@/lib/audio/voice-registration', async (original) => {
  const actual = await original<typeof import('@/lib/audio/voice-registration')>();
  return {
    ...actual,
    getVoiceRegistrationAdapter: (id: string) =>
      id === 'minimax-tts'
        ? {
            ...actual.getVoiceRegistrationAdapter(id),
            listVoices: mocks.list,
            deleteVoice: mocks.delete,
          }
        : actual.getVoiceRegistrationAdapter(id),
  };
});

const url = 'http://localhost/api/generate/voice';
const cloud = { id: 'my-narrator', name: 'My narrator', kind: 'designed' };
const model = 'speech-2.8-hd';

function config(apiKey: string, voices?: { id: string; name: string }[]): ModelConfigFile {
  return {
    providers: { speech: { preset: 'minimax-tts', apiKey, models: [model], voices } },
    slots: { tts: `speech:${model}` },
  };
}

function list(providerId = 'minimax-tts') {
  return route.GET(new NextRequest(`${url}?providerId=${providerId}`));
}

function remove(kind: string) {
  return route.DELETE(
    new NextRequest(url, {
      method: 'DELETE',
      body: JSON.stringify({ providerId: 'minimax-tts', voiceId: cloud.id, kind }),
    }),
  );
}

describe('account voice management on the active workspace speech service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceId.mockResolvedValue('user:one');
    mocks.list.mockResolvedValue([cloud]);
    setDeploymentConfigForTests({ layer: null, legacy: false, notices: [] });
    setWorkspaceLayerLoaderForTests(async (ownerId) => ({
      source: 'workspace',
      config: config(`key-for-${ownerId}`),
    }));
  });
  afterEach(() => {
    setDeploymentConfigForTests();
    setWorkspaceLayerLoaderForTests();
  });

  it('reads only the requesting workspace’s own account and marks the response private', async () => {
    const response = await list();
    expect(await response.json()).toEqual({
      success: true,
      voices: [cloud],
      canDeleteRemote: true,
    });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'key-for-user:one' }),
      expect.any(AbortSignal),
    );
    mocks.workspaceId.mockResolvedValue('user:two');
    await list();
    expect(mocks.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: 'key-for-user:two' }),
      expect.any(AbortSignal),
    );
  });

  it.each([undefined, [{ id: 'published', name: 'Classroom voice' }]])(
    'keeps the upstream catalogue and remote delete private for deployment keys (%j)',
    async (voices) => {
      setDeploymentConfigForTests({
        layer: { source: 'deployment', config: config('shared', voices) },
        legacy: false,
        notices: [],
      });
      // A workspace choosing an operator provider does not own the provider's key.
      setWorkspaceLayerLoaderForTests(async () => ({
        source: 'workspace',
        config: { slots: { tts: `speech:${model}` } },
      }));
      expect(await (await list()).json()).toEqual({
        success: true,
        voices: [],
        canDeleteRemote: false,
      });
      expect((await remove('clone')).status).toBe(403);
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.delete).not.toHaveBeenCalled();
    },
  );

  it('never fetches an account list when there is an explicit catalogue', async () => {
    setWorkspaceLayerLoaderForTests(async () => ({
      source: 'workspace',
      config: config('key', [{ id: 'published', name: 'Classroom voice' }]),
    }));
    expect((await (await list()).json()).voices).toEqual([]);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('deletes a designed voice only in the caller’s account and refuses system voices', async () => {
    expect((await remove('system')).status).toBe(400);
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(await (await remove('designed')).json()).toMatchObject({
      success: true,
      vendorDeleted: true,
    });
    expect(mocks.delete).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'key-for-user:one' }),
      cloud.id,
      expect.any(AbortSignal),
      'designed',
    );
  });

  it.each([
    { referenceAudioBase64: [1, 2, 3] },
    { referenceAudioBase64: 42 },
    { referenceAudioBase64: null, descriptor: { identity: 'Narrator' } },
  ])(
    'rejects non-string reference audio before resolving the speech service (%j)',
    async (input) => {
      const response = await route.POST(
        new NextRequest(url, {
          method: 'POST',
          body: JSON.stringify({ voiceId: 'Narrator', ...input }),
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ errorCode: 'INVALID_REQUEST' });
      expect(mocks.workspaceId).not.toHaveBeenCalled();
    },
  );

  it('refuses a stale picker when its provider no longer matches the TTS slot', async () => {
    expect((await list('qwen-tts')).status).toBe(409);
    const response = await route.POST(
      new NextRequest(url, {
        method: 'POST',
        body: JSON.stringify({
          expectedProviderId: 'qwen-tts',
          voiceId: 'my voice',
          referenceAudioBase64: 'ignored',
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('keeps an old tab from uploading, listing or deleting after its service key is replaced', async () => {
    setWorkspaceLayerLoaderForTests(async () => ({
      source: 'workspace',
      config: config('replacement-account-key'),
      revision: 8,
    }));
    const stale = { expectedServiceId: 'speech', expectedRevision: 7 };
    const get = (revision: number) =>
      route.GET(
        new NextRequest(
          `${url}?providerId=minimax-tts&expectedServiceId=speech&expectedRevision=${revision}`,
        ),
      );
    expect((await get(7)).status).toBe(409);
    expect(
      (
        await route.POST(
          new NextRequest(url, {
            method: 'POST',
            body: JSON.stringify({
              ...stale,
              expectedProviderId: 'minimax-tts',
              voiceId: 'Reference',
              referenceAudioBase64: 'private-audio',
            }),
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await route.DELETE(
          new NextRequest(url, {
            method: 'DELETE',
            body: JSON.stringify({
              ...stale,
              providerId: 'minimax-tts',
              voiceId: cloud.id,
              kind: 'designed',
            }),
          }),
        )
      ).status,
    ).toBe(409);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
    expect((await get(8)).status).toBe(200);
  });

  it('refuses account operations from another saved service using the same MiniMax preset', async () => {
    const staleService = { providerId: 'minimax-tts', expectedServiceId: 'other-speech' };
    const get = new NextRequest(`${url}?${new URLSearchParams(staleService)}`);
    expect((await route.GET(get)).status).toBe(409);
    expect(
      (
        await route.DELETE(
          new NextRequest(url, {
            method: 'DELETE',
            body: JSON.stringify({
              ...staleService,
              voiceId: cloud.id,
              kind: 'clone',
            }),
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await route.POST(
          new NextRequest(url, {
            method: 'POST',
            body: JSON.stringify({
              expectedProviderId: 'minimax-tts',
              expectedServiceId: 'other-speech',
              voiceId: 'new voice',
              referenceAudioBase64: 'ignored',
            }),
          }),
        )
      ).status,
    ).toBe(409);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});
