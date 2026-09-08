import type { NextRequest } from 'next/server';

import {
  readTeacherStudentRequest,
  teacherStudentResponse,
  withTeacherStudentRequest,
} from '@/lib/server/teacher/student-http';
import {
  createTeacherStudent,
  defaultTeacherStudentServiceDeps,
  listTeacherStudents,
} from '@/lib/server/teacher/students';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  return withTeacherStudentRequest(req, async (ownerId, headers) => {
    const students = await listTeacherStudents(await defaultTeacherStudentServiceDeps(ownerId));
    return teacherStudentResponse({ students }, headers);
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return withTeacherStudentRequest(req, async (ownerId, headers) => {
    const input = await readTeacherStudentRequest(req);
    const result = await createTeacherStudent(
      await defaultTeacherStudentServiceDeps(ownerId),
      input,
    );
    return teacherStudentResponse(
      { student: result.student },
      headers,
      result.replayed ? 200 : 201,
    );
  });
}
