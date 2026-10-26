import { createHash } from 'node:crypto';

import type { VoiceRegistrationConfig } from './voice-registration';

/** Connection and policy isolation shared by agent and adapter registration caches. */
export function voiceRegistrationConfigKey(cfg: VoiceRegistrationConfig): string {
  return createHash('sha256')
    .update(cfg.baseUrl)
    .update('\0')
    .update(cfg.apiKey || '')
    .update('\0')
    .update(cfg.model || '')
    .update('\0')
    .update(cfg.publicOnly ? 'public-only' : cfg.managed ? 'managed' : 'server-policy')
    .digest('hex');
}

/** Identity of the provider request: wire name and decoded audio, never display metadata. */
export function voiceRegistrationKey(
  configKey: string,
  wireName: string,
  audio: Uint8Array,
): string {
  return createHash('sha256')
    .update(configKey)
    .update('\0')
    .update(wireName)
    .update('\0')
    .update(audio)
    .digest('hex');
}

/** Cancel only this caller's wait; the shared registration keeps its own lifetime. */
export function waitForVoiceRegistration<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
    // Observe the shared operation even when this caller has already left.
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
