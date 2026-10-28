// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classroomModeStorageKey,
  readClassroomMode,
  writeClassroomMode,
} from '@/lib/workbench/classroom-mode';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('per-course classroom mode memory', () => {
  it('defaults to learning and ignores malformed or old values', () => {
    expect(readClassroomMode('a')).toBe('learning');
    localStorage.setItem(classroomModeStorageKey('a'), '{"mode":"editing"}');
    expect(readClassroomMode('a')).toBe('learning');
  });

  it('restores each course independently', () => {
    writeClassroomMode('a', 'editing');
    writeClassroomMode('b', 'learning');
    expect(readClassroomMode('a')).toBe('editing');
    expect(readClassroomMode('b')).toBe('learning');
    writeClassroomMode('b', 'editing');
    writeClassroomMode('a', 'learning');
    expect(readClassroomMode('a')).toBe('learning');
    expect(readClassroomMode('b')).toBe('editing');
  });

  it('keeps storage denial out of the view transition', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readClassroomMode('a')).toBe('learning');
    expect(() => writeClassroomMode('a', 'editing')).not.toThrow();
  });
});
