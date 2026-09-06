import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// A client-supplied ASR base URL must be validated in every environment, not
// only when NODE_ENV === 'production'. The self-hosting escape hatch is
// ALLOW_LOCAL_NETWORKS, which the guard itself honors. This file keeps the
// real ssrf-guard (no mock) so the private-address classification is exercised
// end to end.

const mocks = vi.hoisted(() => ({
  transcribeAudio: vi.fn(),
  serverManaged: false,
  serverDisabled: false,
}));

vi.mock('@/lib/audio/asr-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audio/asr-providers')>();
  return {
    ...actual,
    transcribeAudio: mocks.transcribeAudio,
  };
});

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: () => mocks.serverManaged,
  isServerProviderDisabled: () => mocks.serverDisabled,
  resolveASRApiKey: (_id: string, clientKey?: string | null) => clientKey || 'server-key',
  resolveASRBaseUrl: (_id: string, clientBaseUrl?: string | null) => clientBaseUrl || undefined,
  resolveASRModel: (_id: string, clientModel?: string | null) => clientModel || 'whisper-1',
  resolveServerASRProviderId: () => undefined,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function postTranscription(baseUrl: string) {
  const { POST } = await import('@/app/api/transcription/route');
  const formData = new FormData();
  formData.append('audio', new File([new Uint8Array([1, 2, 3])], 'clip.mp3'), 'clip.mp3');
  formData.append('providerId', 'openai');
  formData.append('modelId', 'whisper-1');
  formData.append('language', 'en');
  formData.append('apiKey', 'client-key');
  formData.append('baseUrl', baseUrl);
  const req = new NextRequest('http://localhost/api/transcription', {
    method: 'POST',
    body: formData,
  });
  return POST(req);
}

describe('transcription — client-supplied base URL guard applies in every environment', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.transcribeAudio.mockReset();
    mocks.transcribeAudio.mockResolvedValue({ text: 'hello' });
    mocks.serverManaged = false;
    mocks.serverDisabled = false;
  });

  it('rejects a metadata-address base URL when NODE_ENV is not production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const res = await postTranscription('http://169.254.169.254/latest/meta-data/');
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toMatchObject({ success: false, errorCode: 'INVALID_URL' });
    expect(mocks.transcribeAudio).not.toHaveBeenCalled();
  });

  it('still lets the same local base URL through when ALLOW_LOCAL_NETWORKS=true', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    const res = await postTranscription('http://169.254.169.254/latest/meta-data/');
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true });
    expect(mocks.transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai',
        baseUrl: 'http://169.254.169.254/latest/meta-data/',
      }),
      expect.any(File),
    );
  });
});
