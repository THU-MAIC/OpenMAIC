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
