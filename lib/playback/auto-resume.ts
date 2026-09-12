import type { EngineMode } from './types';

/**
 * Where a chat-session cleanup originated. A confirmed/timed-out soft close or
 * the explicit resume-lesson control may resume lecture playback.
 */
export type CleanupSource =
  | 'soft_close_enter'
  | 'soft_close_confirmed'
  | 'soft_close_timeout'
  | 'resume_lesson'
  | 'manual_stop'
  | 'scene_switch'
  | 'error'
  | 'turn_complete';

export interface AutoResumeArgs {
  /** Which cleanup path is running. */
  source: CleanupSource;
  /** Director-provided reason the Q&A/discussion ended, if any. */
  endReason?: string;
  /** Whether this session interrupted an active lecture (read before cleanup). */
  hadLectureInterruption: boolean;
  /** Engine mode AFTER cleanup restored the saved lecture position. */
  engineMode: EngineMode;
  /** Whether the course has no more content to play. */
  isExhausted: boolean;
  /** Whether playback already reached completion. */
  playbackCompleted: boolean;
}

/**
 * Decide whether an ended Q&A/discussion should auto-resume the lecture it
 * interrupted. Pure and conservative: it only returns true for the narrow
 * "completed soft close after a satisfied/back-to-lesson Q&A" case or the
 * explicit resume-lesson action, and requires the engine to be idle with
 * content still remaining.
 */
export function shouldAutoResumeLecture(args: AutoResumeArgs): boolean {
  const isExplicitResume = args.source === 'resume_lesson';
  if (
    args.source !== 'soft_close_confirmed' &&
    args.source !== 'soft_close_timeout' &&
    !isExplicitResume
  ) {
    return false;
  }
  // An explicit classroom control is authoritative even when the Q&A began
  // before playback, so it can start the lesson instead of leaving the engine idle.
  if (!isExplicitResume && !args.hadLectureInterruption) return false;
  if (args.endReason !== 'user_done' && args.endReason !== 'back_to_lesson') return false;
  if (args.engineMode !== 'idle') return false;
  if (args.isExhausted || args.playbackCompleted) return false;
  return true;
}
