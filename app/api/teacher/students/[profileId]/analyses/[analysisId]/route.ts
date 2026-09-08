import type { NextRequest } from 'next/server';

import {
  readTeacherAnalysisRequest,
  teacherAnalysisResponse,
  withTeacherAnalysisRequest,
} from '@/lib/server/teacher/analysis-http';
import {
  defaultTeacherAnalysisServiceDeps,
  getTeacherAnalysis,
  updateTeacherAnalysis,
} from '@/lib/server/teacher/analysis-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ profileId: string; analysisId: string }> };

export async function GET(req: NextRequest, context: Context): Promise<Response> {
  return withTeacherAnalysisRequest(req, async (ownerId, headers) => {
    const { profileId, analysisId } = await context.params;
    const analysis = await getTeacherAnalysis(
      await defaultTeacherAnalysisServiceDeps(ownerId),
      profileId,
      analysisId,
    );
    return teacherAnalysisResponse({ analysis }, headers);
  });
}

export async function PATCH(req: NextRequest, context: Context): Promise<Response> {
  return withTeacherAnalysisRequest(req, async (ownerId, headers) => {
    const input = await readTeacherAnalysisRequest(req);
    const { profileId, analysisId } = await context.params;
    const analysis = await updateTeacherAnalysis(
      await defaultTeacherAnalysisServiceDeps(ownerId),
      profileId,
      analysisId,
      input,
    );
    return teacherAnalysisResponse({ analysis }, headers);
  });
}
