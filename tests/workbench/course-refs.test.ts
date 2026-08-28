/**
 * The course-ref wire contract — the sibling of `element-refs.test.ts`, and
 * deliberately the same shape of scrutiny: the decoder is the only thing
 * standing between a browser-authored JSON blob and a durable event that the
 * runner will later read back and put in front of a model.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_COURSE_REFS,
  addCourseRef,
  decodeCourseRefs,
  hasCourseRef,
  makeCourseRef,
  parseCourseRefs,
  removeCourseRef,
  type CourseRef,
} from '@/lib/workbench/course-refs';

const ref = (stageId: string, title = `课堂 ${stageId}`): CourseRef => ({
  kind: 'course',
  stageId,
  title,
});

describe('makeCourseRef', () => {
  it('trims, and refuses a ref with no id or no label', () => {
    expect(makeCourseRef(' stage-1 ', ' 光的折射 ')).toEqual({
      kind: 'course',
      stageId: 'stage-1',
      title: '光的折射',
    });
    expect(makeCourseRef('', '光的折射')).toBeNull();
    expect(makeCourseRef('stage-1', '   ')).toBeNull();
  });

  it('caps a pathological title rather than handing the wire something it will reject', () => {
    const made = makeCourseRef('stage-1', 'x'.repeat(500));
    expect(made?.title).toHaveLength(120);
    expect(decodeCourseRefs([made]).ok).toBe(true);
  });
});

describe('course ref list helpers', () => {
  it('de-duplicates by stage, keeping array identity when nothing changed', () => {
    const refs = [ref('stage-1')];
    expect(addCourseRef(refs, ref('stage-1', '换了个名字'))).toBe(refs);
    expect(addCourseRef(refs, ref('stage-2'))).toHaveLength(2);
    expect(hasCourseRef(refs, 'stage-1')).toBe(true);
    expect(hasCourseRef(refs, 'stage-2')).toBe(false);
  });

  it('stops at the cap instead of silently dropping the oldest', () => {
    let refs: CourseRef[] = [];
    for (let index = 0; index < MAX_COURSE_REFS + 3; index += 1) {
      refs = addCourseRef(refs, ref(`stage-${index}`));
    }
    expect(refs).toHaveLength(MAX_COURSE_REFS);
    expect(refs[0].stageId).toBe('stage-0');
  });

  it('removes by identity and keeps array identity for a miss', () => {
    const refs = [ref('stage-1'), ref('stage-2')];
    expect(removeCourseRef(refs, 'stage-1')).toEqual([ref('stage-2')]);
    expect(removeCourseRef(refs, 'stage-9')).toBe(refs);
  });
});

describe('decodeCourseRefs — reject mode (the POST boundary)', () => {
  it('accepts a well-formed list verbatim', () => {
    expect(decodeCourseRefs([ref('stage-1'), ref('stage-2')])).toEqual({
      ok: true,
      refs: [ref('stage-1'), ref('stage-2')],
    });
  });

  it('rejects a non-array, an unknown kind, and unknown fields', () => {
    expect(decodeCourseRefs('stage-1')).toMatchObject({ ok: false });
    expect(decodeCourseRefs([{ ...ref('stage-1'), kind: 'classroom' }])).toMatchObject({
      ok: false,
      error: 'courseRefs[0].kind must be "course"',
    });
    expect(decodeCourseRefs([{ ...ref('stage-1'), ownerId: 'user:2' }])).toMatchObject({
      ok: false,
      error: 'courseRefs[0] contains unknown field "ownerId"',
    });
  });

  it('requires a non-empty, bounded stage id and title', () => {
    expect(decodeCourseRefs([{ kind: 'course', title: '课' }])).toMatchObject({
      ok: false,
      error: 'courseRefs[0].stageId must be a non-empty string',
    });
    expect(
      decodeCourseRefs([{ kind: 'course', stageId: 'x'.repeat(65), title: '课' }]),
    ).toMatchObject({ ok: false, error: 'courseRefs[0].stageId cannot exceed 64 characters' });
    expect(decodeCourseRefs([{ kind: 'course', stageId: 'stage-1', title: '  ' }])).toMatchObject({
      ok: false,
      error: 'courseRefs[0].title must be a non-empty string',
    });
    expect(
      decodeCourseRefs([{ kind: 'course', stageId: 'stage-1', title: 'x'.repeat(121) }]),
    ).toMatchObject({ ok: false, error: 'courseRefs[0].title cannot exceed 120 characters' });
  });

  it('de-duplicates by stage id before the cap, keeping the first title', () => {
    expect(decodeCourseRefs([ref('stage-1', '第一份'), ref('stage-1', '第二份')])).toEqual({
      ok: true,
      refs: [ref('stage-1', '第一份')],
    });
  });

  it('rejects more than the cap', () => {
    const many = Array.from({ length: MAX_COURSE_REFS + 1 }, (_, i) => ref(`stage-${i}`));
    expect(decodeCourseRefs(many)).toMatchObject({
      ok: false,
      error: `courseRefs cannot contain more than ${MAX_COURSE_REFS} items`,
    });
  });
});

describe('parseCourseRefs — drop mode (durable replay)', () => {
  it('folds an absent or non-array field to nothing', () => {
    expect(parseCourseRefs(undefined)).toEqual([]);
    expect(parseCourseRefs({ stageId: 'stage-1' })).toEqual([]);
  });

  it('drops malformed historical items and keeps the valid ones in order', () => {
    expect(
      parseCourseRefs([
        ref('stage-1'),
        null,
        { kind: 'course', stageId: 'stage-2' },
        { kind: 'course', stageId: 'stage-3', title: '课', extra: 1 },
        ref('stage-4'),
      ]),
    ).toEqual([ref('stage-1'), ref('stage-4')]);
  });

  it('keeps the first N valid refs even when invalid entries are interleaved', () => {
    const wire = [
      ref('stage-0'),
      { kind: 'course' },
      ...Array.from({ length: MAX_COURSE_REFS + 4 }, (_, i) => ref(`stage-${i + 1}`)),
    ];
    const parsed = parseCourseRefs(wire);
    expect(parsed).toHaveLength(MAX_COURSE_REFS);
    expect(parsed[0].stageId).toBe('stage-0');
    expect(parsed.at(-1)?.stageId).toBe(`stage-${MAX_COURSE_REFS - 1}`);
  });
});
