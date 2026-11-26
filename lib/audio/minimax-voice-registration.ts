import { randomUUID } from 'node:crypto';

import { MINIMAX_CLONE_VOICE_PREFIX } from '@/lib/audio/constants';
import { minimaxEndpoint, minimaxStatusCode } from '@/lib/audio/minimax';
import type { AccountVoice } from '@/lib/audio/types';
import type {
  VoiceRegistrationAdapter,
  VoiceRegistrationConfig,
} from '@/lib/audio/voice-registration';
import {
  voiceRegistrationConfigKey,
  voiceRegistrationKey,
  waitForVoiceRegistration,
} from '@/lib/audio/voice-registration-cache';
import {
  MINIMAX_MIN_REFERENCE_DURATION_SECONDS,
  validateReferenceAudio,
} from '@/lib/audio/wav-validate';
import { appAttributionHeaders } from '@/lib/config/app-attribution';
import { audioEndpointPolicy, audioProviderFetch } from '@/lib/server/audio-provider-fetch';

interface MiniMaxVoice {
  voice_id?: string;
  voice_name?: string | null;
  description?: string[] | null;
}

interface MiniMaxResponse {
  base_resp?: { status_code?: number | string };
  file?: { file_id?: string };
  input_sensitive?: boolean | { type?: number } | null;
  system_voice?: MiniMaxVoice[] | null;
  voice_cloning?: MiniMaxVoice[] | null;
  voice_generation?: MiniMaxVoice[] | null;
}

const voiceErrorHints: Record<number, string> = {
  1004: 'Check the API key and regional endpoint.',
  2038: 'Voice cloning requires MiniMax account verification.',
  2051: 'Use a clearer reference recording.',
  2052: 'The MiniMax account has no free voice slots.',
};

async function post(
  cfg: VoiceRegistrationConfig,
  path: string,
  body: string | FormData,
  signal?: AbortSignal,
): Promise<MiniMaxResponse> {
  const apiKey = cfg.apiKey?.trim();
  if (!apiKey) throw new Error('MiniMax requires an API key');
  const url = minimaxEndpoint(cfg.baseUrl, path);
  const res = await audioProviderFetch(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...appAttributionHeaders(url),
      },
      body,
      signal,
    },
    audioEndpointPolicy(cfg),
  );
  const text = await res.text();
  let data: MiniMaxResponse | undefined;
  try {
    // MiniMax's file_id is an int64. Node 22 exposes the JSON source token before
    // rounding to a JS number, so the clone call can forward the exact ID.
    data = JSON.parse(text, (key, value: unknown, context?: { source: string }) =>
      key === 'file_id' && typeof value === 'number' ? context?.source : value,
    );
  } catch {
    // A gateway may return HTML or an empty body on an HTTP failure.
  }
  const code = minimaxStatusCode(data?.base_resp?.status_code);
  if (code !== undefined && code !== 0) {
    const hint = voiceErrorHints[code];
    throw new Error(`MiniMax ${path} failed (code ${code}).${hint ? ` ${hint}` : ''}`);
  }
  if (!res.ok) throw new Error(`MiniMax ${path} failed (HTTP ${res.status})`);
  if (!data || code !== 0) throw new Error(`Invalid MiniMax ${path} response`);
  return data;
}

function accountVoices(
  voices: MiniMaxVoice[] | null | undefined,
  kind: AccountVoice['kind'],
): AccountVoice[] {
  if (voices == null) return [];
  if (!Array.isArray(voices)) throw new Error('Invalid MiniMax get_voice response');
  return voices.flatMap((voice) => {
    const id = typeof voice?.voice_id === 'string' ? voice.voice_id.trim() : '';
    if (!id) return [];
    const name = typeof voice.voice_name === 'string' ? voice.voice_name.trim() : '';
    const description = Array.isArray(voice.description)
      ? voice.description.find((item) => typeof item === 'string' && item.trim())
      : undefined;
    return [{ id, name: name || description?.trim() || id, kind }];
  });
}

function requirePersonalAccount(cfg: VoiceRegistrationConfig): void {
  if (cfg.managed)
    throw new Error('MiniMax account voice management requires personal credentials');
}

async function createVoice(
  cfg: VoiceRegistrationConfig,
  audio: Buffer<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<string> {
  const upload = new FormData();
  upload.set('purpose', 'voice_clone');
  upload.set('file', new Blob([audio], { type: 'audio/wav' }), 'reference.wav');
  const { file } = await post(cfg, 'files/upload', upload, signal);
  signal?.throwIfAborted();
  const fileId = file?.file_id;
  if (typeof fileId !== 'string' || !/^[1-9]\d*$/.test(fileId)) {
    throw new Error('MiniMax upload returned an invalid file_id');
  }
  // MiniMax reserves IDs even after deletion. A local display name may be
  // reused or contain any script. The clone endpoint expects an integer file_id.
  const voiceId = `${MINIMAX_CLONE_VOICE_PREFIX}${randomUUID()}`;
  const result = await post(
    cfg,
    'voice_clone',
    `{"file_id":${fileId},"voice_id":${JSON.stringify(voiceId)}}`,
    signal,
  );
  const check = result.input_sensitive;
  if (typeof check === 'object' ? check?.type : check) {
    throw new Error('MiniMax rejected the reference sample during its content check');
  }
  return voiceId;
}

interface PendingRegistration {
  controller: AbortController;
  promise: Promise<string>;
  waiters: number;
}

const inFlight = new Map<string, PendingRegistration>();

export const minimaxVoiceRegistrationAdapter: VoiceRegistrationAdapter = {
  minReferenceDurationSeconds: MINIMAX_MIN_REFERENCE_DURATION_SECONDS,
  supportsRegistration: () => true,
  resolveRegistrationModel: () => undefined,
  supportsBootstrapReferenceClip: false,
  async bootstrapReferenceClip() {
    throw new Error('MiniMax voice cloning requires reference audio');
  },
  // MiniMax only offers account-wide discovery, which omits unactivated clones.
  // A registration's free-text name must never select an existing cloud voice.
  async voiceExists() {
    return 'unknown';
  },
  async registerVoice(cfg, params, signal) {
    signal?.throwIfAborted();
    const audio = Buffer.from(params.referenceAudioBase64, 'base64');
    validateReferenceAudio(audio, MINIMAX_MIN_REFERENCE_DURATION_SECONDS);
    // A shared account spans owners. Each managed registration creates its own voice.
    if (cfg.managed) return createVoice(cfg, audio, signal);
    const key = voiceRegistrationKey(voiceRegistrationConfigKey(cfg), params.voiceId, audio);
    let pending = inFlight.get(key);
    if (!pending) {
      const controller = new AbortController();
      const registrationSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      const promise = createVoice(cfg, audio, registrationSignal).finally(() => {
        if (inFlight.get(key)?.controller === controller) inFlight.delete(key);
      });
      pending = { controller, promise, waiters: 0 };
      inFlight.set(key, pending);
    }
    pending.waiters++;
    if (!signal) return pending.promise;

    const leave = () => {
      pending.waiters--;
      if (pending.waiters === 0 && inFlight.get(key) === pending) {
        // An immediate retry must start a fresh upload, even if this one settles late.
        inFlight.delete(key);
        pending.controller.abort(signal.reason);
      }
    };
    signal.addEventListener('abort', leave, { once: true });
    try {
      return await waitForVoiceRegistration(pending.promise, signal);
    } finally {
      signal.removeEventListener('abort', leave);
    }
  },
  async listVoices(cfg, signal) {
    requirePersonalAccount(cfg);
    const data = await post(cfg, 'get_voice', JSON.stringify({ voice_type: 'all' }), signal);
    return [
      ...accountVoices(data.system_voice, 'system'),
      ...accountVoices(data.voice_cloning, 'clone'),
      ...accountVoices(data.voice_generation, 'designed'),
    ];
  },
  async deleteVoice(cfg, voiceId, signal, kind) {
    requirePersonalAccount(cfg);
    if (kind !== 'clone' && kind !== 'designed') {
      throw new Error('Select a cloned or designed MiniMax voice to delete');
    }
    const voiceType = kind === 'clone' ? 'voice_cloning' : 'voice_generation';
    await post(
      cfg,
      'delete_voice',
      JSON.stringify({ voice_type: voiceType, voice_id: voiceId }),
      signal,
    );
  },
};
