import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';
import { resolveMediaServingOrigin } from '@/lib/server/media-origin';

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

export async function persistClassroomMediaBytes(input: {
  stageId: string;
  bytes: Buffer | Uint8Array;
  mime: string;
  prefix?: string;
  baseUrl?: string;
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
  return `${resolveMediaServingOrigin(input.baseUrl)}/api/classroom-media/${input.stageId}/media/${filename}`;
}
