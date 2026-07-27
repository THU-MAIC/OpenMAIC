import { describe, expect, it } from 'vitest';

// The production migration is intentionally a standalone CommonJS script.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { analyzeCourse } = require('../../scripts/normalize-course-scene-order.js');

function course(stage: object, scenes: object[]) {
  return { id: 'course-1', data: { stage, scenes } };
}

describe('normalize-course-scene-order', () => {
  it('uses valid seq for trusted courses and writes contiguous order/seq', () => {
    const result = analyzeCourse(
      course({ sceneOrderTrusted: true }, [
        { id: 'second', seq: 20, order: 99 },
        { id: 'first', seq: 10, order: 42 },
      ]),
    );

    expect(result).toMatchObject({ eligible: true, source: 'seq', changed: true });
    expect(result.after).toEqual([
      { id: 'first', order: 0, seq: 0 },
      { id: 'second', order: 1, seq: 1 },
    ]);
  });

  it('uses the stable legacy recovery key for untrusted courses', () => {
    const result = analyzeCourse(
      course({}, [
        { id: 'late', createdAt: 20, updatedAt: 1 },
        { id: 'b-tie', createdAt: 10, updatedAt: 2 },
        { id: 'a-tie', createdAt: 10, updatedAt: 2 },
      ]),
    );

    expect(result.source).toBe('createdAt→updatedAt→id');
    expect(result.after.map((scene: { id: string }) => scene.id)).toEqual([
      'a-tie',
      'b-tie',
      'late',
    ]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'created-at-tie', blocking: false }),
    );
  });

  it('blocks duplicate or missing scene ids instead of guessing', () => {
    const duplicate = analyzeCourse(course({}, [{ id: 'same' }, { id: 'same' }]));
    const missing = analyzeCourse(course({}, [{ id: 'ok' }, { order: 1 }]));

    expect(duplicate.eligible).toBe(false);
    expect(duplicate.issues).toContainEqual(
      expect.objectContaining({ code: 'duplicate-scene-id' }),
    );
    expect(missing.eligible).toBe(false);
    expect(missing.issues).toContainEqual(expect.objectContaining({ code: 'invalid-scene-id' }));
  });

  it('is idempotent after a normalized result is written', () => {
    const first = analyzeCourse(
      course({}, [
        { id: 'b', createdAt: 2 },
        { id: 'a', createdAt: 1 },
      ]),
    );
    const second = analyzeCourse({ id: 'course-1', data: first.nextData });

    expect(second).toMatchObject({ eligible: true, changed: false, source: 'seq' });
  });
});
