import { setTimeout as delay } from 'node:timers/promises';
import {
  voiceRegistrationConfigKey,
  voiceRegistrationKey,
  waitForVoiceRegistration,
} from './voice-registration-cache';

import {
  QwenVoiceCloneError,
  type QwenVoiceCloneConfig,
  assertQwenVoiceTarget,
  preferredVoiceName,
  deleteQwenVoice,
  qwenVoiceExists,
  queryQwenVoiceReadiness,
  registerQwenVoice,
} from '@/lib/audio/qwen-voice-clone';
import {
  DEFAULT_QWEN_TTS_VOICE_CLONE_MODEL,
  isQwenCloneVoice,
  qwenVoiceMatchesTargetModel,
} from '@/lib/audio/constants';
import { resolveQwenVoiceCloneModel } from '@/lib/server/provider-config';
import {
  QWEN_MIN_REFERENCE_DURATION_SECONDS,
  validateReferenceAudio,
} from '@/lib/audio/wav-validate';
import type {
  VoiceRegistrationAdapter,
  VoiceRegistrationConfig,
} from '@/lib/audio/voice-registration';

// Leave room for the route's five-second preflight within its 29-second limit.
const REGISTRATION_DEADLINE_MS = 23_000;
const READINESS_POLL_MS = 1_000;
const REGISTRATION_MEMO_TTL_MS = 60 * 60 * 1000;
const REGISTRATION_MEMO_MAX_ENTRIES = 256;

interface RegistrationOperation {
  /** Underlying create/query work, including a create response after the wait deadline. */
  completion: Promise<string>;
  /** Deadline-bounded result shared by callers, each with its own cancellation. */
  result: Promise<string>;
}
const inFlightRegistrations = new Map<string, RegistrationOperation>();
const registrations = new Map<
  string,
  { voiceId: string; state: 'pending' | 'ready'; expiresAt: number; configKey: string }
>();
const registrationKeysByVoice = new Map<string, Set<string>>();

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function providerConfig(
  cfg: VoiceRegistrationConfig,
): QwenVoiceCloneConfig & { targetModel: string } {
  return {
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    targetModel: cfg.model || DEFAULT_QWEN_TTS_VOICE_CLONE_MODEL,
    publicOnly: cfg.publicOnly,
    managed: cfg.managed,
  };
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
  const configKey = voiceRegistrationConfigKey(cfg);
  const key = voiceRegistrationKey(
    configKey,
    preferredVoiceName(params.voiceId),
    decodeBase64(params.referenceAudioBase64),
  );
  let memoized = registrations.get(key);
  if (memoized) {
    if (memoized.expiresAt > Date.now()) {
      registrations.delete(key);
      registrations.set(key, memoized);
      if (memoized.state === 'ready') return memoized.voiceId;
    } else {
      removeRegistrationKey(key, memoized.voiceId);
      memoized = undefined;
    }
  }

  const existing = inFlightRegistrations.get(key);
  if (existing) return waitForVoiceRegistration(existing.result, signal);

  // This deadline bounds waiting and readiness polling, not create transport.
  // Disconnecting a waiter must not cancel enrollment for the other waiters,
  // or discard the provider-created ID.
  const controller = new AbortController();
  let processing = false;
  const timer = setTimeout(
    () =>
      controller.abort(
        new QwenVoiceCloneError(
          processing ? 'QWEN_VC_VOICE_PROCESSING' : 'QWEN_VC_TIMEOUT',
          processing ? 409 : 504,
        ),
      ),
    REGISTRATION_DEADLINE_MS,
  );
  const provider = providerConfig(cfg);
  const work = (async () => {
    let voiceId = memoized?.voiceId;
    if (!voiceId) {
      const audio = decodeBase64(params.referenceAudioBase64);
      validateReferenceAudio(audio, QWEN_MIN_REFERENCE_DURATION_SECONDS);
      const result = await registerQwenVoice(
        provider,
        { name: params.voiceId, audio },
        // Creation keeps postJson's independent 30s transport/body deadline.
        // Aborting it at the 23s wait limit could lose an already-created ID.
      );
      voiceId = result.voiceId;
      rememberRegistration(key, configKey, voiceId, 'pending');
    }
    while (true) {
      controller.signal.throwIfAborted();
      const state = await queryQwenVoiceReadiness(provider, voiceId, controller.signal);
      controller.signal.throwIfAborted();
      if (state === 'ready') {
        rememberRegistration(key, configKey, voiceId, 'ready');
        return voiceId;
      }
      if (state === 'missing') {
        removeRegistrationKey(key, voiceId);
        throw new QwenVoiceCloneError('QWEN_VC_VOICE_NOT_FOUND', 404);
      }
      if (state === 'rejected') {
        removeRegistrationKey(key, voiceId);
        throw new QwenVoiceCloneError('QWEN_VC_VOICE_REJECTED', 422);
      }
      if (state === 'incompatible') throw new QwenVoiceCloneError('QWEN_VC_RECLONE_REQUIRED', 409);
      if (state === 'unavailable') throw new QwenVoiceCloneError('QWEN_VC_HTTP_ERROR', 409);
      processing = state === 'processing';
      await delay(READINESS_POLL_MS, undefined, { signal: controller.signal });
    }
  })();
  // Race the complete operation too, including response-body consumption.
  const pending = waitForVoiceRegistration(work, controller.signal).finally(() => {
    clearTimeout(timer);
  });
  const operation: RegistrationOperation = { completion: work, result: pending };
  inFlightRegistrations.set(key, operation);
  // Keep ownership until the underlying operation settles, even when the
  // deadline wins. A late create response must record its ID before any retry
  // can consume another voice slot.
  const release = () => {
    if (inFlightRegistrations.get(key) === operation) inFlightRegistrations.delete(key);
  };
  void operation.completion.then(release, release);
  return waitForVoiceRegistration(operation.result, signal);
}

function rememberRegistration(
  key: string,
  configKey: string,
  voiceId: string,
  state: 'pending' | 'ready',
): void {
  registrations.delete(key);
  registrations.set(key, {
    voiceId,
    state,
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
 * pending and ready registrations for one hour. It is neither durable nor shared
 * across replicas. If create's own transport deadline or a network failure loses
 * the response, the provider outcome is unknown; retries may still create another
 * voice. This memo cannot provide exactly-once enrollment without a provider
 * idempotency key or durable reconciliation.
 */
async function voiceExists(
  cfg: VoiceRegistrationConfig,
  voiceId: string,
  signal?: AbortSignal,
): Promise<boolean | 'unknown'> {
  // Enrollment names are labels, not provider IDs. Only query IDs for this
  // target, or an authoritative ID returned by our own enrollment request.
  const provider = providerConfig(cfg);
  const configKey = voiceRegistrationConfigKey(cfg);
  const matchingKeys = [...(registrationKeysByVoice.get(voiceId) ?? [])].filter(
    (key) => registrations.get(key)?.configKey === configKey,
  );
  if (!qwenVoiceMatchesTargetModel(voiceId, provider.targetModel) && matchingKeys.length === 0)
    return false;

  const result = await qwenVoiceExists(provider, voiceId, signal).catch((error: unknown) => {
    if (error instanceof QwenVoiceCloneError && error.code === 'QWEN_VC_VOICE_REJECTED')
      for (const key of matchingKeys) removeRegistrationKey(key, voiceId);
    throw error;
  });
  if (result !== 'unknown') return result;

  const keys = registrationKeysByVoice.get(voiceId);
  if (!keys) return result;
  for (const key of [...keys]) {
    const registration = registrations.get(key);
    if (!registration || registration.expiresAt <= Date.now()) {
      removeRegistrationKey(key, voiceId);
      continue;
    }
    if (registration.configKey === configKey && registration.state === 'ready') return true;
  }
  return result;
}

async function deleteVoice(
  cfg: VoiceRegistrationConfig,
  voiceId: string,
  signal?: AbortSignal,
): Promise<void> {
  await deleteQwenVoice(providerConfig(cfg), voiceId, signal);
  evictQwenVoiceRegistrationMemo(voiceId);
}

/** Qwen enrollment requires a real voice sample. */
async function bootstrapReferenceClip(): Promise<never> {
  throw new QwenVoiceCloneError('QWEN_VC_BOOTSTRAP_UNSUPPORTED', 400);
}

/** Enrollment targets the server-resolved clone model, not the synthesis model. */
function resolveRegistrationModel(): string {
  return resolveQwenVoiceCloneModel();
}

export const qwenVoiceCloneRegistrationAdapter: VoiceRegistrationAdapter = {
  normalizeRegistrationName: preferredVoiceName,
  assertVoiceCompatible(voiceId, configuredVoices) {
    if (isQwenCloneVoice(voiceId, configuredVoices))
      assertQwenVoiceTarget(voiceId, resolveRegistrationModel());
  },
  minReferenceDurationSeconds: QWEN_MIN_REFERENCE_DURATION_SECONDS,
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
