import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { auth } from '@/lib/auth/auth';
import { userOwnsClassroom } from '@/lib/auth/helpers';
import { apiError, apiSuccess, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  buildRequestOrigin,
  isValidClassroomId,
  persistClassroom,
  readClassroom,
} from '@/lib/server/classroom-storage';
import { createDefaultSlideContent } from '@/lib/api/stage-api-defaults';
import type { SceneType } from '@/lib/types/stage';

const addSceneSchema = z.object({
  classroomId: z.string().min(1),
  title: z.string().min(1).max(200),
  type: z.enum(['slide', 'quiz', 'interactive', 'pbl']).optional().default('slide'),
});

const deleteSceneSchema = z.object({
  classroomId: z.string().min(1),
  sceneId: z.string().min(1),
});

const updateSceneSchema = z.object({
  classroomId: z.string().min(1),
  sceneId: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  type: z.enum(['slide', 'quiz', 'interactive', 'pbl']).optional(),
  content: z.unknown().optional(),
  actions: z.unknown().optional(),
});

async function authorizeOwner(userId: string, role: string, classroomId: string): Promise<boolean> {
  if (role === 'ADMIN') return true;
  return userOwnsClassroom(userId, classroomId);
}

export async function POST(req: NextRequest) {
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

  const parsed = addSceneSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      400,
      parsed.error.issues[0]?.message ?? 'Invalid request body',
    );
  }

  const { classroomId, title, type } = parsed.data;

  if (!isValidClassroomId(classroomId)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
  }

  const authorized = await authorizeOwner(session.user.id, session.user.role ?? '', classroomId);
  if (!authorized) {
    return apiError(API_ERROR_CODES.FORBIDDEN, 403, 'Forbidden');
  }

  const classroom = await readClassroom(classroomId);
  if (!classroom) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
  }

  const maxOrder = classroom.scenes.reduce((max, s) => Math.max(max, s.order), 0);

  let content;
  if (type === 'slide') {
    content = createDefaultSlideContent();
  } else if (type === 'quiz') {
    content = { type: 'quiz' as const, questions: [] };
  } else if (type === 'interactive') {
    content = { type: 'interactive' as const, url: '' };
  } else {
    content = { type: 'pbl' as const, projectConfig: null };
  }

  const newScene = {
    id: nanoid(10),
    stageId: classroom.id,
    type: type as SceneType,
    title,
    order: maxOrder + 1,
    content,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const updatedScenes = [...classroom.scenes, newScene];

  const baseUrl = buildRequestOrigin(req);
  await persistClassroom(
    {
      id: classroom.id,
      stage: { ...classroom.stage, updatedAt: Date.now() },
      scenes: updatedScenes,
    },
    baseUrl,
  );

  return apiSuccess({ scene: newScene });
}

export async function DELETE(req: NextRequest) {
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

  const parsed = deleteSceneSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      400,
      parsed.error.issues[0]?.message ?? 'Invalid request body',
    );
  }

  const { classroomId, sceneId } = parsed.data;

  if (!isValidClassroomId(classroomId)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
  }

  const authorized = await authorizeOwner(session.user.id, session.user.role ?? '', classroomId);
  if (!authorized) {
    return apiError(API_ERROR_CODES.FORBIDDEN, 403, 'Forbidden');
  }

  const classroom = await readClassroom(classroomId);
  if (!classroom) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
  }

  const exists = classroom.scenes.some((s) => s.id === sceneId);
  if (!exists) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Scene not found');
  }

  const updatedScenes = classroom.scenes
    .filter((s) => s.id !== sceneId)
    .map((s, idx) => ({ ...s, order: idx + 1 }));

  const baseUrl = buildRequestOrigin(req);
  await persistClassroom(
    {
      id: classroom.id,
      stage: { ...classroom.stage, updatedAt: Date.now() },
      scenes: updatedScenes,
    },
    baseUrl,
  );

  return apiSuccess({ deleted: sceneId });
}

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

  const parsed = updateSceneSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      400,
      parsed.error.issues[0]?.message ?? 'Invalid request body',
    );
  }

  const { classroomId, sceneId, title, type, content, actions } = parsed.data;

  if (!isValidClassroomId(classroomId)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
  }

  const authorized = await authorizeOwner(session.user.id, session.user.role ?? '', classroomId);
  if (!authorized) {
    return apiError(API_ERROR_CODES.FORBIDDEN, 403, 'Forbidden');
  }

  const classroom = await readClassroom(classroomId);
  if (!classroom) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
  }

  const targetIndex = classroom.scenes.findIndex((s) => s.id === sceneId);
  if (targetIndex < 0) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Scene not found');
  }

  const target = classroom.scenes[targetIndex];
  const updatedScene = {
    ...target,
    ...(title !== undefined ? { title } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(actions !== undefined ? { actions: actions as never } : {}),
    updatedAt: Date.now(),
  };

  const updatedScenes = [...classroom.scenes];
  updatedScenes[targetIndex] = updatedScene;

  const baseUrl = buildRequestOrigin(req);
  await persistClassroom(
    {
      id: classroom.id,
      stage: { ...classroom.stage, updatedAt: Date.now() },
      scenes: updatedScenes,
    },
    baseUrl,
  );

  return apiSuccess({ scene: updatedScene });
}
