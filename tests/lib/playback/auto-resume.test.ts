import { describe, expect, it } from 'vitest';
import { shouldAutoResumeLecture, type AutoResumeArgs } from '@/lib/playback/auto-resume';

const base: AutoResumeArgs = {
  source: 'soft_close_timeout',
  endReason: 'user_done',
  hadLectureInterruption: true,
  engineMode: 'idle',
  isExhausted: false,
  playbackCompleted: false,
};

describe('shouldAutoResumeLecture', () => {
  it('resumes after a soft-close timeout that ended an interrupting Q&A (user_done)', () => {
    expect(shouldAutoResumeLecture(base)).toBe(true);
  });

  it('resumes when endReason is back_to_lesson', () => {
    expect(shouldAutoResumeLecture({ ...base, endReason: 'back_to_lesson' })).toBe(true);
  });

  it('uses the same resume gate for a user-confirmed soft close', () => {
    expect(shouldAutoResumeLecture({ ...base, source: 'soft_close_confirmed' })).toBe(true);
    expect(
      shouldAutoResumeLecture({
        ...base,
        source: 'soft_close_confirmed',
        endReason: 'user_goodbye',
      }),
    ).toBe(false);
  });

  it('never resumes for a non-soft-close cleanup source', () => {
    expect(shouldAutoResumeLecture({ ...base, source: 'soft_close_enter' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, source: 'manual_stop' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, source: 'scene_switch' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, source: 'error' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, source: 'turn_complete' })).toBe(false);
  });

  it('never resumes when the Q&A did not interrupt a lecture', () => {
    expect(shouldAutoResumeLecture({ ...base, hadLectureInterruption: false })).toBe(false);
  });

  it('never resumes for goodbye/lesson_complete/unknown/undefined endReason', () => {
    expect(shouldAutoResumeLecture({ ...base, endReason: 'user_goodbye' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, endReason: 'lesson_complete' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, endReason: 'something_else' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, endReason: undefined })).toBe(false);
  });

  it('never resumes when the engine is not idle', () => {
    expect(shouldAutoResumeLecture({ ...base, engineMode: 'playing' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, engineMode: 'paused' })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, engineMode: 'live' })).toBe(false);
  });

  it('never resumes when the course is exhausted or already completed', () => {
    expect(shouldAutoResumeLecture({ ...base, isExhausted: true })).toBe(false);
    expect(shouldAutoResumeLecture({ ...base, playbackCompleted: true })).toBe(false);
  });
});
