import { type NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/auth/prisma';
import {
  ensureClassroomOwnership,
  getEffectivePermissions,
  userHasClassroomAccess,
  userOwnsClassroom,
} from '@/lib/auth/helpers';
import {
  buildRequestOrigin,
  isValidClassroomId,
  listDeletedClassrooms,
  persistClassroom,
  purgeExpiredDeletedClassrooms,
  readClassroom,
  softDeleteClassroom,
} from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('Classroom API');

export async function POST(request: NextRequest) {
  let stageId: string | undefined;
  let sceneCount: number | undefined;
  try {
    await purgeExpiredDeletedClassrooms();
    const session = await auth();
    if (!session?.user) {
      return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, 'Unauthorized');
    }

    const createPermissions = await getEffectivePermissions(session.user.role);
    if (!createPermissions.includes('create_own_classrooms')) {
      return apiError(API_ERROR_CODES.FORBIDDEN, 403, 'Forbidden');
    }

    const body = await request.json();
    const { stage, scenes } = body;
    stageId = stage?.id;
    sceneCount = scenes?.length;

    if (!stage || !scenes) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required fields: stage, scenes',
      );
    }

    const id = stage.id || randomUUID();
    const baseUrl = buildRequestOrigin(request);

    const persisted = await persistClassroom(
      {
        id,
        stage: { ...stage, id, ownerUserId: stage.ownerUserId || session.user.id },
        scenes,
      },
      baseUrl,
    );
    await ensureClassroomOwnership(session.user.id, id);

    return apiSuccess({ id: persisted.id, url: persisted.url }, 201);
  } catch (error) {
    log.error(
      `Classroom storage failed [stageId=${stageId ?? 'unknown'}, scenes=${sceneCount ?? 0}]:`,
      error,
    );
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to store classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    await purgeExpiredDeletedClassrooms();
    const session = await auth();
    if (!session?.user) {
      return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, 'Unauthorized');
    }

    const id = request.nextUrl.searchParams.get('id');

    if (!id) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required parameter: id',
      );
    }

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const canAccess = await userHasClassroomAccess(session.user.id, session.user.role, id);
    if (!canAccess) {
      return apiError(API_ERROR_CODES.FORBIDDEN, 403, 'Access denied');
    }

    const classroom = await readClassroom(id);
    if (!classroom) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    return apiSuccess({ classroom });
  } catch (error) {
    log.error(
      `Classroom retrieval failed [id=${request.nextUrl.searchParams.get('id') ?? 'unknown'}]:`,
      error,
    );
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to retrieve classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, 'Unauthorized');
    }

    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required parameter: id',
      );
    }

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const deletePermissions = await getEffectivePermissions(session.user.role);
    const canDelete =
      deletePermissions.includes('delete_own_classrooms') && (await userOwnsClassroom(session.user.id, id));
    if (!canDelete) {
      return apiError(API_ERROR_CODES.FORBIDDEN, 403, 'Forbidden');
    }

    const classroom = await readClassroom(id);
    if (!classroom) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }
    const ownershipRows = await prisma.classroomAccess.findMany({
      where: { classroomId: id },
      select: { userId: true, assignedBy: true },
    });
    const ownershipMarker = ownershipRows.find((row) => row.userId === row.assignedBy);
    const ownerUserId =
      classroom.stage?.ownerUserId || ownershipMarker?.userId || ownershipRows[0]?.assignedBy;

    if (!ownerUserId) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Unable to resolve classroom owner');
    }

    const deleted = await softDeleteClassroom({
      id,
      ownerUserId,
      deletedBy: session.user.id,
    });

    if (!deleted.deleted) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    await prisma.classroomAccess.deleteMany({ where: { classroomId: id } });
    const deletedList = await listDeletedClassrooms();
    const record = deletedList.find((r) => r.id === id) ?? null;

    return apiSuccess({
      id,
      ownerUserId,
      deletedAt: record?.deletedAt,
      purgeAt: record?.purgeAt,
    });
  } catch (error) {
    log.error(
      `Classroom deletion failed [id=${request.nextUrl.searchParams.get('id') ?? 'unknown'}]:`,
      error,
    );
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to delete classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, 'Unauthorized');
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid JSON body');
    }

    const payload = body as {
      id?: string;
      title?: string;
      description?: string;
      language?: string;
    };

    const id = payload.id?.trim();
    if (!id) {
      return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'Missing required field: id');
    }
    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    // Authz: owner or ADMIN
    const isAdmin = session.user.role === 'ADMIN';
    if (!isAdmin) {
      const owns = await userOwnsClassroom(session.user.id, id);
      if (!owns) {
        return apiError(API_ERROR_CODES.FORBIDDEN, 403, 'Forbidden');
      }
    }

    const classroom = await readClassroom(id);
    if (!classroom) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    const nextTitle = payload.title?.trim();
    const nextDescription = payload.description?.trim();
    const nextLanguage = payload.language?.trim();

    if (payload.title !== undefined && !nextTitle) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'title cannot be empty');
    }

    if (nextLanguage && nextLanguage !== 'en' && nextLanguage !== 'zh-CN' && nextLanguage !== 'th-TH') {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'language must be en, zh-CN, or th-TH');
    }

    const updated = {
      ...classroom,
      stage: {
        ...classroom.stage,
        name: payload.title !== undefined ? nextTitle! : classroom.stage.name || classroom.id,
        description:
          payload.description !== undefined
            ? nextDescription || ''
            : classroom.stage.description,
        language: nextLanguage || classroom.stage.language,
        updatedAt: Date.now(),
      },
    };

    const baseUrl = buildRequestOrigin(request);
    await persistClassroom(
      {
        id: updated.id,
        stage: updated.stage,
        scenes: updated.scenes,
      },
      baseUrl,
    );

    return apiSuccess({ id, classroom: updated });
  } catch (error) {
    log.error('Classroom update failed:', error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to update classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}
