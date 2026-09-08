import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudentProfilePanel, TeacherWorkbench } from '@/components/teacher/TeacherWorkbench';
import {
  createStudentDraft,
  createTeacherRequestId,
  filterStudents,
  studentDraftError,
  studentDraftPayload,
  teacherRequest,
  TeacherRequestError,
} from '@/components/teacher/student-ui';
import { getTeacherCopy, teacherResourceFor } from '@/lib/i18n/teacher';
import type { TeacherStudent } from '@/lib/teacher/students';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import { createUnknownField } from '@/lib/zhongkao/observed-field';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ locale: 'zh-CN', t: (key: string) => key }),
}));

const createdAt = '2026-09-08T10:00:00.000Z';
function student(id: string, nickname: string, archived = false): TeacherStudent {
  const profile = createInitialStudentProfile({ profileId: id, createdAt });
  profile.grade = createUnknownField(createdAt);
  profile.examYear = createUnknownField(createdAt);
  profile.displayName = {
    value: nickname,
    status: 'confirmed',
    confidence: 1,
    evidence: [{ type: 'user_input', createdAt }],
    updatedAt: createdAt,
  };
  return { profile, archived };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('teacher student UI', () => {
  it('starts new student drafts with no inherited grade, year or region', () => {
    expect(createStudentDraft()).toEqual({ nickname: '', grade: '', examYear: '', region: '' });
    expect(
      studentDraftPayload({ nickname: '  Fictional A  ', grade: '', examYear: '', region: ' ' }),
    ).toEqual({ nickname: 'Fictional A', grade: null, examYear: null, region: null });
  });

  it('validates optional entries and rejects fabricated fallback names or invalid numbers', () => {
    const base = { ...createStudentDraft(), nickname: 'Fictional A' };
    expect(studentDraftError(base)).toBeNull();
    expect(studentDraftError({ ...base, nickname: '同学' })).toBe('invalidNickname');
    expect(studentDraftError({ ...base, grade: '1.5' })).toBe('invalidGrade');
    expect(studentDraftError({ ...base, grade: '13' })).toBe('invalidGrade');
    expect(studentDraftError({ ...base, examYear: '2101' })).toBe('invalidExamYear');
    expect(studentDraftError({ ...base, region: 'x'.repeat(101) })).toBe('invalidRegion');
    expect(studentDraftPayload({ ...base, grade: '9', examYear: '2027' })).toMatchObject({
      grade: 9,
      examYear: 2027,
    });
  });

  it('keeps archived students and search results separate', () => {
    const rows = [
      student('a', 'Fictional Alpha'),
      student('b', 'Fictional Beta'),
      student('c', 'Fictional Alpha', true),
    ];
    expect(filterStudents(rows, false, ' ALPHA ').map((row) => row.profile.profileId)).toEqual([
      'a',
    ]);
    expect(filterStudents(rows, true, 'alpha').map((row) => row.profile.profileId)).toEqual(['c']);
    expect(filterStudents(rows, false, 'missing')).toEqual([]);
  });

  it('renders an unknown profile without inventing mastery, textbook or exam-year facts', () => {
    const html = renderToStaticMarkup(
      createElement(StudentProfilePanel, {
        student: student('a', 'Fictional A'),
        copy: getTeacherCopy('zh-CN'),
        locale: 'zh-CN',
        onEdit: vi.fn(),
        onArchive: vi.fn(),
        busy: false,
      }),
    );
    expect(html).toContain('探索计划');
    expect(html).toContain('未确认');
    expect(html).toContain('通用课程');
    expect(html).not.toContain('2027');
    expect(html).not.toContain('%');
    expect(html).not.toContain('薄弱');
    expect(html).not.toContain('人教版');
  });

  it('retains inferred labels instead of rendering them as confirmed', () => {
    const row = student('a', 'Fictional A');
    row.profile.region = {
      value: 'Fictional region',
      status: 'inferred',
      confidence: 0.4,
      evidence: [{ type: 'diagnostic', createdAt }],
      updatedAt: createdAt,
    };
    const html = renderToStaticMarkup(
      createElement(StudentProfilePanel, {
        student: row,
        copy: getTeacherCopy('en-US'),
        locale: 'en-US',
        onEdit: vi.fn(),
        onArchive: vi.fn(),
        busy: false,
      }),
    );
    expect(html).toContain('Fictional region');
    expect(html).toContain('Inferred');
  });

  it('shows a configured-storage prerequisite without displaying a misleading create action', () => {
    const html = renderToStaticMarkup(
      createElement(TeacherWorkbench, { configured: false, lessonPrepHref: '/' }),
    );
    expect(html).toContain('教师工作台尚未配置');
    expect(html).not.toContain('新建学生');
    expect(html).not.toContain('DATABASE_URL');
  });

  it('provides matching bilingual resources and English fallback for other locales', () => {
    expect(Object.keys(teacherResourceFor('zh-CN')).sort()).toEqual(
      Object.keys(teacherResourceFor('en-US')).sort(),
    );
    expect(teacherResourceFor('fr-FR').title).toBe('Teacher workspace');
    expect(teacherResourceFor('zh-CN').gradeValue).toBe('{{grade}} 年级');
  });

  it('creates UUID v4 request IDs on private-network HTTP without randomUUID', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(1);
        return bytes;
      },
    });
    expect(createTeacherRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('keeps credentials same-origin, bypasses caches, and returns safe typed errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ students: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errorCode: 'TEACHER_STUDENT_CONFLICT' }), { status: 409 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(teacherRequest('/api/teacher/students')).resolves.toEqual({ students: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/teacher/students',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }),
    );
    await expect(teacherRequest('/api/teacher/students')).rejects.toMatchObject({
      status: 409,
      code: 'TEACHER_STUDENT_CONFLICT',
    } satisfies Partial<TeacherRequestError>);
  });
});
