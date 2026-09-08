import type { NextRequest } from 'next/server';

import {
  readTeacherStudentRequest,
  teacherStudentResponse,
  withTeacherStudentRequest,
} from '@/lib/server/teacher/student-http';
import {
  defaultTeacherStudentServiceDeps,
  getTeacherStudent,
  updateTeacherStudent,
} from '@/lib/server/teacher/students';

export const runtime = 'nodejs';
type Context = { params: Promise<{ profileId: string }> };

export async function GET(req: NextRequest, context: Context): Promise<Response> {
  return withTeacherStudentRequest(req, async (ownerId, headers) => {
    const { profileId } = await context.params;
    const student = await getTeacherStudent(
      await defaultTeacherStudentServiceDeps(ownerId),
      profileId,
    );
    return teacherStudentResponse({ student }, headers);
  });
}

export async function PATCH(req: NextRequest, context: Context): Promise<Response> {
  return withTeacherStudentRequest(req, async (ownerId, headers) => {
    const input = await readTeacherStudentRequest(req);
    const { profileId } = await context.params;
    const student = await updateTeacherStudent(
      await defaultTeacherStudentServiceDeps(ownerId),
      profileId,
      input,
    );
    return teacherStudentResponse({ student }, headers);
  });
}
