import { supabase } from '@/lib/supabase/client';
import {
  COURSE_ASSET_BUCKET,
  MATERIAL_EXTENSIONS,
  MATERIAL_MAX_BYTES,
  MATERIAL_MIME_TYPES,
  type CourseAssetKind,
} from './shared';

export {
  COURSE_ASSET_BUCKET,
  MATERIAL_MAX_BYTES,
  type CourseAssetKind,
} from './shared';

const DATA_URI = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/;

function extensionFor(contentType: string, kind: CourseAssetKind): string {
  const subtype = contentType.split('/')[1]?.toLowerCase().split(';')[0];

  if (kind === 'images') {
    const allowed = new Set(['png', 'jpeg', 'jpg', 'webp', 'gif', 'svg+xml']);
    if (!subtype || !allowed.has(subtype)) return 'png';
    if (subtype === 'jpeg') return 'jpg';
    if (subtype === 'svg+xml') return 'svg';
    return subtype;
  }

  if (kind === 'audio') {
    const allowed = new Set(['mpeg', 'mp3', 'wav', 'ogg', 'webm', 'mp4', 'aac']);
    if (!subtype || !allowed.has(subtype)) return 'mp3';
    if (subtype === 'mpeg') return 'mp3';
    return subtype;
  }

  // material: 从 contentType 反查(优先),否则用 subtype
  for (const [ext, mime] of Object.entries(MATERIAL_MIME_TYPES)) {
    if (mime === contentType) return ext;
  }
  if (subtype && MATERIAL_EXTENSIONS.has(subtype)) return subtype;
  return 'pdf';
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

async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SignedUploadRequest {
  courseId: string;
  kind: CourseAssetKind;
  contentType: string;
  size?: number;
}

export interface SignedUploadResponse {
  path: string;
  token: string;
  publicUrl: string;
}

/**
 * 申请一个直传 Supabase 的预签名 URL。
 *
 * 关键点:对于 material 类型必须传 size 参数,服务端会做大小二次校验。
 */
async function requestSignedUpload({
  courseId,
  kind,
  contentType,
  size,
  hash,
  extension,
}: SignedUploadRequest & { hash: string; extension: string }): Promise<SignedUploadResponse> {
  const response = await fetch('/api/course-assets/sign-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courseId, kind, hash, contentType, extension, size }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.data?.token || !result?.data?.path || !result?.data?.publicUrl) {
    const err = new Error(result?.error || `申请资产上传授权失败(HTTP ${response.status})`);
    (err as Error & { code?: string; status?: number }).code = result?.code;
    (err as Error & { code?: string; status?: number }).status = response.status;
    throw err;
  }
  return result.data as SignedUploadResponse;
}

/**
 * 通过 Supabase 直传 Blob 到 course-assets bucket,文件不经过 Serverless Function。
 */
export async function uploadCourseBlob(
  courseId: string,
  kind: CourseAssetKind,
  blob: Blob,
): Promise<string> {
  const contentType = blob.type || (kind === 'images' ? 'image/png' : kind === 'audio' ? 'audio/mpeg' : 'application/pdf');
  const hash = await hashBlob(blob);
  const extension = extensionFor(contentType, kind);

  const signed = await requestSignedUpload({ courseId, kind, contentType, size: blob.size, hash, extension });
  const { error } = await supabase.storage
    .from(COURSE_ASSET_BUCKET)
    .uploadToSignedUrl(signed.path, signed.token, blob, { contentType, upsert: true });
  if (error) throw new Error(`资产直传失败:${error.message}`);
  return signed.publicUrl as string;
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

/**
 * 课程材料直传。返回 Supabase Storage 内的对象路径(如 `courses/{id}/material/{hash}.pdf`),
 * 由调用方在后续请求里把这个 path 传给 extract-document / parse-pdf。
 *
 * 与 uploadCourseBlob 的区别:不返回 publicUrl,因为课程材料路径只需服务端解析用,
 * 不在前端展示。
 */
export async function uploadCourseMaterial(
  courseId: string,
  file: File | Blob,
): Promise<{ path: string; size: number }> {
  const contentType = file.type || 'application/pdf';
  const hash = await hashBlob(file);
  const extension = extensionFor(contentType, 'material');
  const signed = await requestSignedUpload({
    courseId,
    kind: 'material',
    contentType,
    size: file.size,
    hash,
    extension,
  });
  const { error } = await supabase.storage
    .from(COURSE_ASSET_BUCKET)
    .uploadToSignedUrl(signed.path, signed.token, file, { contentType, upsert: true });
  if (error) throw new Error(`课程材料直传失败:${error.message}`);
  return { path: signed.path, size: file.size };
}

/**
 * 文本(代码作业)直传为 material 类型 — 文本文件统一当 .txt 处理。
 */
export async function uploadCourseTextMaterial(
  courseId: string,
  text: string,
): Promise<{ path: string; size: number }> {
  const blob = new Blob([text], { type: 'text/plain' });
  const hash = await hashText(text);
  const signed = await requestSignedUpload({
    courseId,
    kind: 'material',
    contentType: 'text/plain',
    size: blob.size,
    hash,
    extension: 'txt',
  });
  const { error } = await supabase.storage
    .from(COURSE_ASSET_BUCKET)
    .uploadToSignedUrl(signed.path, signed.token, blob, { contentType: 'text/plain', upsert: true });
  if (error) throw new Error(`文本作业直传失败:${error.message}`);
  return { path: signed.path, size: blob.size };
}