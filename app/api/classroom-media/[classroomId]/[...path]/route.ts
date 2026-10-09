import { promises as fs, createReadStream, type ReadStream } from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import {
  CLASSROOMS_DIR,
  classroomMediaMimeType,
  isValidClassroomId,
} from '@/lib/server/classroom-storage';
import { parseRangeHeader } from '@/lib/server/http-range';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { resolveStageAccess } from '@/lib/server/stage-access';
import { createLogger } from '@/lib/logger';

const log = createLogger('ClassroomMedia');

const CACHE_CONTROL = 'private, no-store';

/** Bridge a fs ReadStream into a web ReadableStream, propagating errors and cancel. */
function toWebStream(stream: ReadStream): ReadableStream {
  return new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: Buffer | string) => controller.enqueue(chunk));
      stream.on('end', () => controller.close());
      stream.on('error', (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ classroomId: string; path: string[] }> },
) {
  return withRequestOwner(req, async (_principal, responseHeaders) => {
    responseHeaders.set('Cache-Control', CACHE_CONTROL);
    const { classroomId, path: pathSegments } = await params;

    // Validate classroomId
    if (!isValidClassroomId(classroomId)) {
      return NextResponse.json(
        { error: 'Invalid classroom ID' },
        { status: 400, headers: responseHeaders },
      );
    }

    // Validate path segments — no traversal
    const joined = pathSegments.join('/');
    if (joined.includes('..') || pathSegments.some((s) => s.includes('\0'))) {
      return NextResponse.json(
        { error: 'Invalid path' },
        { status: 400, headers: responseHeaders },
      );
    }

    // Only allow media/ and audio/ subdirectories
    const subDir = pathSegments[0];
    if (subDir !== 'media' && subDir !== 'audio') {
      return NextResponse.json(
        { error: 'Invalid path' },
        { status: 404, headers: responseHeaders },
      );
    }

    const filePath = path.join(CLASSROOMS_DIR, classroomId, ...pathSegments);
    const resolvedBase = path.resolve(CLASSROOMS_DIR, classroomId);

    try {
      // Course reads are capability-by-id, but a tombstone revokes that
      // capability. Resolve liveness before observing whether old bytes remain.
      const access = await resolveStageAccess(classroomId);
      if (!access) {
        return NextResponse.json({ error: 'Not found' }, { status: 404, headers: responseHeaders });
      }

      // Resolve symlinks and verify the real path stays within the classroom dir
      const realPath = await fs.realpath(filePath);
      if (!realPath.startsWith(resolvedBase + path.sep) && realPath !== resolvedBase) {
        return NextResponse.json({ error: 'Not found' }, { status: 404, headers: responseHeaders });
      }

      const stat = await fs.stat(realPath);
      if (!stat.isFile()) {
        return NextResponse.json({ error: 'Not found' }, { status: 404, headers: responseHeaders });
      }

      const ext = path.extname(realPath).toLowerCase();
      const contentType = classroomMediaMimeType(ext) ?? 'application/octet-stream';

      // Range requests enable progressive playback and seeking for hosted media
      // (e.g. <video> streams the moov atom first, then fetches on seek).
      const range = parseRangeHeader(req.headers.get('range'), stat.size);

      if (range.kind === 'unsatisfiable') {
        const headers = new Headers(responseHeaders);
        headers.set('Content-Range', `bytes */${stat.size}`);
        return new NextResponse(null, { status: 416, headers });
      }

      if (range.kind === 'range') {
        const stream = createReadStream(realPath, { start: range.start, end: range.end });
        const headers = new Headers(responseHeaders);
        headers.set('Content-Type', contentType);
        headers.set('Content-Length', String(range.end - range.start + 1));
        headers.set('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
        headers.set('Accept-Ranges', 'bytes');
        return new NextResponse(toWebStream(stream), { status: 206, headers });
      }

      // Stream the file to avoid loading large videos into memory
      const headers = new Headers(responseHeaders);
      headers.set('Content-Type', contentType);
      headers.set('Content-Length', String(stat.size));
      headers.set('Accept-Ranges', 'bytes');
      return new NextResponse(toWebStream(createReadStream(realPath)), {
        status: 200,
        headers,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return NextResponse.json({ error: 'Not found' }, { status: 404, headers: responseHeaders });
      }
      log.error(
        `Classroom media serving failed [classroomId=${classroomId}, path=${joined}]:`,
        error,
      );
      return NextResponse.json(
        { error: 'Internal error' },
        { status: 500, headers: responseHeaders },
      );
    }
  });
}
