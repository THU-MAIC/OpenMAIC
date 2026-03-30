import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import { getClassroomIndex } from '@/lib/server/classroom-index';
import { auth } from '@/auth';

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 401, 'Authentication required');
    }

    const classrooms = await getClassroomIndex(
      session.user.id,
      session.user.role,
    );
    return apiSuccess({ classrooms });
  } catch (error) {
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to list classrooms',
      error instanceof Error ? error.message : String(error),
    );
  }
}
