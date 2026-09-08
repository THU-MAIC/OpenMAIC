import type { NextRequest } from 'next/server';

import {
  readTeacherAnalysisRequest,
  teacherAnalysisResponse,
  withTeacherAnalysisRequest,
} from '@/lib/server/teacher/analysis-http';
import {
  createTeacherAnalysis,
  defaultTeacherAnalysisServiceDeps,
  listTeacherAnalyses,
} from '@/lib/server/teacher/analysis-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ profileId: string }> };

export async function GET(req: NextRequest, context: Context): Promise<Response> {
  return withTeacherAnalysisRequest(req, async (ownerId, headers) => {
    const { profileId } = await context.params;
    const analyses = await listTeacherAnalyses(
      await defaultTeacherAnalysisServiceDeps(ownerId),
      profileId,
    );
    return teacherAnalysisResponse({ analyses }, headers);
  });
}

export async function POST(req: NextRequest, context: Context): Promise<Response> {
  return withTeacherAnalysisRequest(req, async (ownerId, headers) => {
    const input = await readTeacherAnalysisRequest(req);
    const { profileId } = await context.params;
    const result = await createTeacherAnalysis(
      await defaultTeacherAnalysisServiceDeps(ownerId, req),
      profileId,
      input,
      AbortSignal.any([req.signal, AbortSignal.timeout(120_000)]),
    );
    return teacherAnalysisResponse(
      { analysis: result.analysis },
      headers,
      result.replayed ? 200 : 201,
    );
  });
}
