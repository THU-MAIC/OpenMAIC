import type { TeacherStudent } from '@/lib/teacher/students';

export interface StudentDraft {
  nickname: string;
  grade: string;
  examYear: string;
  region: string;
}

export function createStudentDraft(student?: TeacherStudent): StudentDraft {
  return {
    nickname: student?.profile.displayName.value ?? '',
    grade: student?.profile.grade.value?.toString() ?? '',
    examYear: student?.profile.examYear.value?.toString() ?? '',
    region: student?.profile.region.value ?? '',
  };
}

export function studentDraftError(
  draft: StudentDraft,
): 'invalidNickname' | 'invalidGrade' | 'invalidExamYear' | 'invalidRegion' | null {
  if (
    !draft.nickname.trim() ||
    draft.nickname.trim() === '\u540c\u5b66' ||
    draft.nickname.trim().length > 80
  )
    return 'invalidNickname';
  if (draft.grade.trim() && (!/^\d+$/.test(draft.grade) || +draft.grade < 1 || +draft.grade > 12)) {
    return 'invalidGrade';
  }
  if (
    draft.examYear.trim() &&
    (!/^\d+$/.test(draft.examYear) || +draft.examYear < 2000 || +draft.examYear > 2100)
  ) {
    return 'invalidExamYear';
  }
  return draft.region.trim().length > 100 ? 'invalidRegion' : null;
}

export function studentDraftPayload(draft: StudentDraft) {
  return {
    nickname: draft.nickname.trim(),
    grade: draft.grade.trim() ? Number(draft.grade) : null,
    examYear: draft.examYear.trim() ? Number(draft.examYear) : null,
    region: draft.region.trim() || null,
  };
}

export function filterStudents(
  students: TeacherStudent[],
  archived: boolean,
  query: string,
): TeacherStudent[] {
  const normalized = query.trim().toLocaleLowerCase();
  return students.filter(
    (student) =>
      student.archived === archived &&
      (student.profile.displayName.value ?? '').toLocaleLowerCase().includes(normalized),
  );
}

export function createTeacherRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Web Crypto randomUUID requires HTTPS; getRandomValues also works on trusted LAN HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class TeacherRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code?: string,
  ) {
    super('Teacher request failed');
  }
}

export async function teacherRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new TeacherRequestError(
      response.status,
      typeof body?.errorCode === 'string' ? body.errorCode : undefined,
    );
  }
  return response.json() as Promise<T>;
}
