import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';

function extensionForMime(mime: string): string {
  const known: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
  };
  return known[mime] ?? 'bin';
}

/**
 * Persist raw media bytes under the stage's classroom-media path and return
 * an origin-independent serving reference.
 *
 * The returned reference is a RELATIVE path (`/api/classroom-media/...`), not
 * an absolute URL. This is the agent runtime's only byte-persist path: it runs
 * with no HTTP request to derive an origin from, and the durable value must
 * stay valid regardless of which origin serves the app. The browser resolves
 * the relative path against the page origin (image/video `src`, narration
 * `audioUrl` playback), and every server-side consumer of the reference reads
 * the local file or fetches it relative to the same origin. Request-bearing
 * routes that DO have an origin build absolute URLs through
 * `resolveMediaServingOrigin` (`classroom-media-generation.ts`).
 */
export async function persistClassroomMediaBytes(input: {
  stageId: string;
  bytes: Buffer | Uint8Array;
  mime: string;
  prefix?: string;
  signal?: AbortSignal;
}): Promise<string> {
  if (input.signal?.aborted) throw new Error('aborted');
  const hash = createHash('sha256').update(input.bytes).digest('hex');
  const filename = `${input.prefix ?? 'generated'}-${hash}.${extensionForMime(input.mime)}`;
  const mediaDir = path.join(CLASSROOMS_DIR, input.stageId, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  if (input.signal?.aborted) throw new Error('aborted');
  await fs.writeFile(path.join(mediaDir, filename), input.bytes);
  if (input.signal?.aborted) throw new Error('aborted');
  return `/api/classroom-media/${input.stageId}/media/${filename}`;
}
