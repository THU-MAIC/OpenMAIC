import { describe, expect, it, vi } from 'vitest';
import {
  classroomEntryHref,
  classroomExitLabelKey,
  exitClassroom,
  resolveClassroomExit,
} from '@/lib/workbench/classroom-exit';

const params = (query = '') => new URLSearchParams(query);

describe('resolveClassroomExit', () => {
  it('returns to the workspace for an explicit workspace source', () => {
    expect(resolveClassroomExit({ searchParams: params('from=workspace') })).toEqual({
      kind: 'push',
      href: '/workspace',
    });
  });

  it('goes home for a classic classroom even when browser history exists', () => {
    // The previous history entry is often an entry-time flow (generation-preview)
    // that must never be a return target, so the classic arrow always pushes home.
    expect(resolveClassroomExit({ searchParams: params() })).toEqual({ kind: 'push', href: '/' });
  });

  it('falls back to home for a direct link such as /shared/<token>', () => {
    expect(resolveClassroomExit({ searchParams: params() })).toEqual({ kind: 'push', href: '/' });
  });

  it('prioritizes an explicit workspace source over everything else', () => {
    expect(resolveClassroomExit({ searchParams: params('from=workspace') })).toEqual({
      kind: 'push',
      href: '/workspace',
    });
  });

  it('returns to home explicitly instead of reopening Pro through browser history', () => {
    expect(resolveClassroomExit({ searchParams: params('returnTo=home') })).toEqual({
      kind: 'push',
      href: '/',
    });
  });
});

describe('exitClassroom', () => {
  it('pushes the resolved destination and never uses browser history', () => {
    const router = { push: vi.fn() };

    exitClassroom(router, params());

    expect(router.push).toHaveBeenCalledWith('/');
  });

  it('returns to the workspace for a workspace-attached classroom', () => {
    const router = { push: vi.fn() };

    exitClassroom(router, params('from=workspace'));

    expect(router.push).toHaveBeenCalledWith('/workspace');
  });
});

describe('classroom navigation metadata', () => {
  it('marks workspace entries and leaves classic entries unchanged', () => {
    expect(classroomEntryHref('course-1', true)).toBe('/classroom/course-1?from=workspace');
    expect(classroomEntryHref('course-1', false)).toBe('/classroom/course-1');
  });

  it('uses workspace copy instead of home copy for workspace exits', () => {
    expect(classroomExitLabelKey(params('from=workspace'))).toBe(
      'workbench.common.backToWorkspace',
    );
    expect(classroomExitLabelKey(params())).toBe('generation.backToHome');
  });
});
