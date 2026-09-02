import { createHash } from 'node:crypto';

import {
  QwenVoiceCloneError,
  deleteQwenVoice,
  qwenVoiceExists,
  registerQwenVoice,
} from '@/lib/audio/qwen-voice-clone';
import { QWEN_TTS_VOICE_CLONE_MODEL } from '@/lib/audio/constants';
import { resolveQwenVoiceCloneModel } from '@/lib/server/provider-config';
import { validateReferenceAudio } from '@/lib/audio/wav-validate';
import type {
  VoiceRegistrationAdapter,
  VoiceRegistrationConfig,
} from '@/lib/audio/voice-registration';

const REGISTRATION_MEMO_TTL_MS = 60 * 60 * 1000;
const REGISTRATION_MEMO_MAX_ENTRIES = 256;

const inFlightRegistrations = new Map<string, Promise<string>>();
const registrations = new Map<string, { voiceId: string; expiresAt: number; configKey: string }>();
const registrationKeysByVoice = new Map<string, Set<string>>();

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function registrationConfigKey(cfg: VoiceRegistrationConfig): string {
  return createHash('sha256')
    .update(cfg.baseUrl)
    .update('\0')
    .update(cfg.apiKey || '')
    .update('\0')
    .update(cfg.model || '')
    .digest('hex');
}

function registrationKey(
  configKey: string,
  params: {
    voiceId: string;
    referenceAudioBase64: string;
    refText?: string;
  },
): string {
  return createHash('sha256')
    .update(configKey)
    .update('\0')
    .update(params.voiceId)
    .update('\0')
    .update(params.refText || '')
    .update('\0')
    .update(params.referenceAudioBase64)
    .digest('hex');
}

async function registerVoice(
  cfg: VoiceRegistrationConfig,
  params: {
    voiceId: string;
    referenceAudioBase64: string;
    mimeType?: string;
    refText?: string;
  },
  signal?: AbortSignal,
): Promise<string> {
  const refText = params.refText || '';
  if (!refText.trim()) throw new QwenVoiceCloneError('QWEN_VC_CONFIG_MISSING', 400);

  const configKey = registrationConfigKey(cfg);
  const key = registrationKey(configKey, params);
  const memoized = registrations.get(key);
  if (memoized) {
    if (memoized.expiresAt > Date.now()) {
      registrations.delete(key);
      registrations.set(key, memoized);
      return memoized.voiceId;
    }
    removeRegistrationKey(key, memoized.voiceId);
  }

  const existing = inFlightRegistrations.get(key);
  if (existing) return waitForRegistration(existing, signal);

  const pending = (async () => {
    const audio = decodeBase64(params.referenceAudioBase64);
    validateReferenceAudio(audio);
    const result = await registerQwenVoice(
      {
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        targetModel: cfg.model || QWEN_TTS_VOICE_CLONE_MODEL,
      },
      { name: params.voiceId, audio, text: refText },
      undefined,
    );
    rememberRegistration(key, configKey, result.voiceId);
    return result.voiceId;
  })().finally(() => inFlightRegistrations.delete(key));
  inFlightRegistrations.set(key, pending);
  return waitForRegistration(pending, signal);
}

function waitForRegistration(pending: Promise<string>, signal?: AbortSignal): Promise<string> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(
      (voiceId) => {
        signal.removeEventListener('abort', aborted);
        resolve(voiceId);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

function rememberRegistration(key: string, configKey: string, voiceId: string): void {
  registrations.delete(key);
  registrations.set(key, {
    voiceId,
    expiresAt: Date.now() + REGISTRATION_MEMO_TTL_MS,
    configKey,
  });
  const keys = registrationKeysByVoice.get(voiceId) ?? new Set<string>();
  keys.add(key);
  registrationKeysByVoice.set(voiceId, keys);
  while (registrations.size > REGISTRATION_MEMO_MAX_ENTRIES) {
    const oldestKey = registrations.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = registrations.get(oldestKey);
    if (oldest) removeRegistrationKey(oldestKey, oldest.voiceId);
  }
}

function removeRegistrationKey(key: string, voiceId: string): void {
  registrations.delete(key);
  const keys = registrationKeysByVoice.get(voiceId);
  keys?.delete(key);
  if (keys?.size === 0) registrationKeysByVoice.delete(voiceId);
}

/**
 * Query the provider rather than trusting the memo. The memo is intentionally
 * process-local: it coalesces concurrent enrollment and retains up to 256
 * successful registrations for one hour. It is neither durable nor shared
 * across replicas.
 */
async function voiceExists(
  cfg: VoiceRegistrationConfig,
  voiceId: string,
  signal?: AbortSignal,
): Promise<boolean | 'unknown'> {
  const result = await qwenVoiceExists(
    { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, targetModel: cfg.model },
    voiceId,
    signal,
  );
  if (result !== 'unknown') return result;

  const configKey = registrationConfigKey(cfg);
  const keys = registrationKeysByVoice.get(voiceId);
  if (!keys) return result;
  for (const key of [...keys]) {
    const registration = registrations.get(key);
    if (!registration || registration.expiresAt <= Date.now()) {
      removeRegistrationKey(key, voiceId);
      continue;
    }
    if (registration.configKey === configKey) return true;
  }
  return result;
}

async function deleteVoice(
  cfg: VoiceRegistrationConfig,
  voiceId: string,
  signal?: AbortSignal,
): Promise<void> {
  await deleteQwenVoice(
    { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, targetModel: cfg.model },
    voiceId,
    signal,
  );
  evictQwenVoiceRegistrationMemo(voiceId);
}

/** Qwen enrollment requires a real voice sample and its verbatim transcript. */
async function bootstrapReferenceClip(): Promise<never> {
  throw new QwenVoiceCloneError('QWEN_VC_BOOTSTRAP_UNSUPPORTED', 400);
}

/** Enrollment targets the server-resolved clone model, not the synthesis model. */
function resolveRegistrationModel(): string {
  return resolveQwenVoiceCloneModel();
}

export const qwenVoiceCloneRegistrationAdapter: VoiceRegistrationAdapter = {
  supportsRegistration: () => true,
  supportsBootstrapReferenceClip: false,
  resolveRegistrationModel,
  voiceExists,
  registerVoice,
  deleteVoice,
  bootstrapReferenceClip,
};

export function clearQwenVoiceRegistrationMemoForTests(): void {
  inFlightRegistrations.clear();
  registrations.clear();
  registrationKeysByVoice.clear();
}

/** Evict process-local registration entries after the provider reports a missing voice. */
export function evictQwenVoiceRegistrationMemo(voiceId: string): void {
  const keys = registrationKeysByVoice.get(voiceId);
  if (!keys) return;
  for (const key of keys) registrations.delete(key);
  registrationKeysByVoice.delete(voiceId);
}
