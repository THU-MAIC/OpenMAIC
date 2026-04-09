/**
 * SCORM export endpoint.
 *
 * POST /api/export/scorm/[courseId]
 * Body: { version: '1.2' | '2004', mode: 'full' | 'light' | 'structure', tts?: {...} }
 * Response: application/zip stream
 */
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { readCourse } from '@/lib/server/course-storage';
import { exportCourseToScorm, type ExportMode } from '@/lib/export/scorm/scorm-exporter';
import type { ScormVersion } from '@/lib/export/scorm/manifest-builder';
import type { TTSConfig } from '@/lib/export/scorm/tts-prerenderer';

export const maxDuration = 300; // Up to 5 minutes for TTS-heavy exports

interface Ctx {
  params: Promise<{ courseId: string }>;
}

interface ExportBody {
  version?: ScormVersion;
  mode?: ExportMode;
  tts?: TTSConfig;
}

export async function POST(req: Request, { params }: Ctx) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.user.role !== 'TEACHER' && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { courseId } = await params;
  const course = await readCourse(courseId);
  if (!course) {
    return NextResponse.json({ error: 'Course not found' }, { status: 404 });
  }
  if (course.createdBy && course.createdBy !== session.user.id && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: ExportBody = {};
  try {
    body = (await req.json()) as ExportBody;
  } catch {
    // Empty body is fine — use defaults
  }

  const version: ScormVersion = body.version === '1.2' ? '1.2' : '2004';
  const mode: ExportMode =
    body.mode === 'full' || body.mode === 'light' || body.mode === 'structure'
      ? body.mode
      : 'light';

  if (mode === 'full' && !body.tts) {
    return NextResponse.json(
      { error: 'TTS config required for mode=full' },
      { status: 400 },
    );
  }

  try {
    const result = await exportCourseToScorm({
      courseId,
      version,
      mode,
      ttsConfig: body.tts,
    });

    // Copy into a fresh ArrayBuffer so the Response body type is happy
    const bodyBuffer = new ArrayBuffer(result.zip.byteLength);
    new Uint8Array(bodyBuffer).set(result.zip);

    return new NextResponse(bodyBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Content-Length': String(result.zip.byteLength),
        'X-Export-Stats': JSON.stringify(result.stats),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
