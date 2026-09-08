import { describe, expect, it } from 'vitest';
import path from 'path';

import { CLASSROOMS_DIR, resolveClassroomFilePath } from '@/lib/server/classroom-storage';

describe('resolveClassroomFilePath — containment inside CLASSROOMS_DIR', () => {
  it('throws for a traversal-style id', () => {
    expect(() => resolveClassroomFilePath('../../../../tmp/openmaic-escape')).toThrow(
      /outside the classrooms directory/,
    );
  });

  it('throws for an absolute-style id', () => {
    expect(() => resolveClassroomFilePath('/tmp/openmaic-escape')).toThrow(
      /outside the classrooms directory/,
    );
  });

  it('resolves an ordinary id to a path inside CLASSROOMS_DIR', () => {
    expect(resolveClassroomFilePath('abc-123_XY')).toBe(
      path.join(path.resolve(CLASSROOMS_DIR), 'abc-123_XY.json'),
    );
  });
});
