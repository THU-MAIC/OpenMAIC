/** Semantics supplied by an audio adapter; callers retain their own retry policy. */
export type AudioFailureKind = 'voice-incompatible' | 'timeout';

/** Keeps provider identity/status intact without teaching orchestration vendor codes. */
export class AudioProviderError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus?: number,
    readonly audioFailureKind?: AudioFailureKind,
  ) {
    super(code);
    this.name = 'AudioProviderError';
  }
}

export function audioFailureKind(error: unknown): AudioFailureKind | undefined {
  return error instanceof AudioProviderError ? error.audioFailureKind : undefined;
}

/** Synthesis refused this voice for the active account. */
export class TTSVoiceUnavailableError extends Error {
  readonly code = 'TTS_VOICE_UNAVAILABLE';
  readonly httpStatus = 404;

  constructor() {
    super('The selected voice is unavailable for this account.');
  }
}

/** Also accept the existing public error returned for a missing Qwen clone. */
export function isVoiceUnavailableCode(code: unknown): boolean {
  return code === 'TTS_VOICE_UNAVAILABLE' || code === 'QWEN_VC_VOICE_NOT_FOUND';
}
