import { describe, expect, it } from 'vitest';
import { classroomFileName } from '@/lib/export/classroom-filename';

const exportedAt = '2026-09-16T02:34:56.789Z';

describe('classroomFileName', () => {
  it('includes a readable title, source ID and UTC export time with milliseconds', () => {
    expect(classroomFileName('网络入门', 'course-a', exportedAt)).toBe(
      '网络入门_course-a_20260916T023456789Z.maic.zip',
    );
  });

  it('distinguishes same-title courses exported at the same time', () => {
    expect(classroomFileName('Lesson', 'course-a', exportedAt)).not.toBe(
      classroomFileName('Lesson', 'course-b', exportedAt),
    );
  });

  it('distinguishes exports within the same second', () => {
    expect(classroomFileName('Lesson', 'course-a', exportedAt)).not.toBe(
      classroomFileName('Lesson', 'course-a', '2026-09-16T02:34:56.790Z'),
    );
  });

  it('normalizes an offset timestamp to UTC', () => {
    expect(classroomFileName('Lesson', 'course-a', '2026-09-16T10:34:56.789+08:00')).toBe(
      classroomFileName('Lesson', 'course-a', exportedAt),
    );
  });

  it('sanitizes path separators, reserved punctuation and control characters', () => {
    const name = classroomFileName(
      ' A/B\\C:D*E?F"G<H>I|J\u0000\n\u007f ',
      '../course:a',
      exportedAt,
    );
    expect(name).toBe('A_B_C_D_E_F_G_H_I_J_______course_a_20260916T023456789Z.maic.zip');
    expect(name).not.toMatch(/[\\/:*?"<>|\u0000-\u001f\u007f]/);
  });

  it('uses a fallback for whitespace-only titles and empty IDs', () => {
    expect(classroomFileName('   ', '', exportedAt)).toBe(
      'classroom_classroom_20260916T023456789Z.maic.zip',
    );
  });

  it('bounds Unicode filenames without cutting a surrogate pair', () => {
    const name = classroomFileName('😀'.repeat(100), 'a'.repeat(100), exportedAt);
    expect(name.startsWith('😀'.repeat(40) + '_')).toBe(true);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    expect(name).toBe('😀'.repeat(40) + '_' + 'a'.repeat(64) + '_20260916T023456789Z.maic.zip');
  });
});
