import { supabase } from '@/lib/supabase/client';
import { COURSE_ASSET_BUCKET, type CourseAssetKind } from './shared';

export { COURSE_ASSET_BUCKET, type CourseAssetKind } from './shared';

const DATA_URI = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/;

function extensionFor(contentType: string, kind: CourseAssetKind): string {
  const subtype = contentType.split('/')[1]?.toLowerCase();
  const allowed = kind === 'images'
    ? new Set(['png', 'jpeg', 'jpg', 'webp', 'gif', 'svg+xml'])
    : new Set(['mpeg', 'mp3', 'wav', 'ogg', 'webm', 'mp4', 'aac']);
  if (!subtype || !allowed.has(subtype)) return kind === 'images' ? 'png' : 'mp3';
  if (subtype === 'jpeg') return 'jpg';
  if (subtype === 'mpeg') return 'mp3';
  if (subtype === 'svg+xml') return 'svg';
  return subtype;
}

export function dataUriToBlob(value: string): Blob | null {
  const match = value.match(DATA_URI);
  if (!match) return null;
  const contentType = match[1] || 'application/octet-stream';
  try {
    if (match[2]) {
      const binary = atob(match[3]);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new Blob([bytes], { type: contentType });
    }
    return new Blob([decodeURIComponent(match[3])], { type: contentType });
  } catch {
    throw new Error('资产 data URI 无法解码');
  }
}

async function hashBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Upload through a server-authorized Supabase signed-upload URL. The asset bytes
 * go browser → Storage directly and never become part of the courses JSON POST.
 */
export async function uploadCourseBlob(
  courseId: string,
  kind: CourseAssetKind,
  blob: Blob,
): Promise<string> {
  const contentType = blob.type || (kind === 'images' ? 'image/png' : 'audio/mpeg');
  const hash = await hashBlob(blob);
  const response = await fetch('/api/course-assets/sign-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courseId, kind, hash, contentType, extension: extensionFor(contentType, kind) }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.data?.token || !result?.data?.path || !result?.data?.publicUrl) {
    throw new Error(result?.error || `申请资产上传授权失败（HTTP ${response.status}）`);
  }

  const { error } = await supabase.storage
    .from(COURSE_ASSET_BUCKET)
    .uploadToSignedUrl(result.data.path, result.data.token, blob, { contentType, upsert: true });
  if (error) throw new Error(`资产直传失败：${error.message}`);
  return result.data.publicUrl as string;
}

export async function uploadCourseDataUri(
  courseId: string,
  kind: CourseAssetKind,
  value: string,
): Promise<string> {
  const blob = dataUriToBlob(value);
  if (!blob) return value;
  return uploadCourseBlob(courseId, kind, blob);
}
