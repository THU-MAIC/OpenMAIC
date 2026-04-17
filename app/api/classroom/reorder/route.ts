import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { userOwnsClassroom } from '@/lib/auth/helpers';
import { apiError, apiSuccess, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  buildRequestOrigin,
  isValidClassroomId,
  persistClassroom,
  readClassroom,
} from '@/lib/server/classroom-storage';

const reorderSchema = z.object({
  classroomId: z.string().min(1),
  sceneOrder: z.array(z.string().min(1)).min(1),
});

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, 'Unauthorized');
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid JSON body');
  }

  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      400,
      parsed.error.issues[0]?.message ?? 'Invalid request body',
    );
  }

  const { classroomId, sceneOrder } = parsed.data;
  if (!isValidClassroomId(classroomId)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
  }

  const isAdmin = session.user.role === 'ADMIN';
  if (!isAdmin) {
    const owns = await userOwnsClassroom(session.user.id, classroomId);
    if (!owns) {
      return apiError(API_ERROR_CODES.FORBIDDEN, 403, 'Forbidden');
    }
  }

  const classroom = await readClassroom(classroomId);
  if (!classroom) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
  }

  // Ensure provided scene IDs match exactly the existing scene set
  const existingIds = classroom.scenes.map((s) => s.id);
  if (sceneOrder.length !== existingIds.length) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'sceneOrder length mismatch');
  }

  const existingSet = new Set(existingIds);
  const incomingSet = new Set(sceneOrder);
  if (existingSet.size !== incomingSet.size) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'sceneOrder contains duplicates');
  }
  for (const id of sceneOrder) {
    if (!existingSet.has(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'sceneOrder contains unknown scene id');
    }
  }

  const byId = new Map(classroom.scenes.map((s) => [s.id, s]));
  const reorderedScenes = sceneOrder.map((sceneId, idx) => {
    const scene = byId.get(sceneId)!;
    return { ...scene, order: idx + 1 };
  });

  const baseUrl = buildRequestOrigin(req);
  await persistClassroom(
    {
      id: classroom.id,
      stage: {
        ...classroom.stage,
        updatedAt: Date.now(),
      },
      scenes: reorderedScenes,
    },
    baseUrl,
  );

  return apiSuccess({ id: classroom.id, sceneCount: reorderedScenes.length });
}
