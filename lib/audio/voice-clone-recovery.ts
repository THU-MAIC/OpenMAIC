export type VoiceCloneRecoveryReason = 'missing' | 'reclone-required';

/** Playback can temporarily use another voice without changing the saved binding. */
export function voiceCloneRecoveryReason(error: unknown): VoiceCloneRecoveryReason | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { errorCode, code } = error as { errorCode?: unknown; code?: unknown };
  switch (errorCode ?? code) {
    case 'QWEN_VC_VOICE_NOT_FOUND':
      return 'missing';
    case 'QWEN_VC_RECLONE_REQUIRED':
      return 'reclone-required';
    default:
      return undefined;
  }
}
