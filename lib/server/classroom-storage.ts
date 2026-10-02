import path from 'path';
import type { NextRequest } from 'next/server';

/**
 * The file-backed classroom directory of earlier versions: `<id>.json` course
 * files plus `<id>/media` and `<id>/audio`. Defaults to `<cwd>/data/classrooms`;
 * `OPENMAIC_CLASSROOMS_DIR` overrides it.
 *
 * Courses no longer live here: server-side generation writes through the
 * document store and the asset pool. What still reads the directory is the
 * one-time import of the courses older versions wrote
 * (`lib/server/legacy-classroom-import.ts`), the agent runtime's
 * narration/material media writer (`classroom-media-bytes.ts`), and the
 * `/api/classroom-media` route that serves both kinds of files to the courses
 * that still name them.
 */
export const CLASSROOMS_DIR = process.env.OPENMAIC_CLASSROOMS_DIR
  ? path.resolve(process.env.OPENMAIC_CLASSROOMS_DIR)
  : path.join(process.cwd(), 'data', 'classrooms');

export function buildRequestOrigin(req: NextRequest): string {
  return req.headers.get('x-forwarded-host')
    ? `${req.headers.get('x-forwarded-proto') || 'http'}://${req.headers.get('x-forwarded-host')}`
    : req.nextUrl.origin;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

const CLASSROOM_MEDIA_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
};

/** The type of a classroom media file, by its extension (`.png`, `.mp3`, ...). */
export function classroomMediaMimeType(extension: string): string | undefined {
  return CLASSROOM_MEDIA_MIME_TYPES[extension.toLowerCase()];
}
