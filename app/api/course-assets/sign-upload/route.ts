import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { COURSE_ASSET_BUCKET, type CourseAssetKind } from '@/lib/course-assets/shared';

export const runtime = 'nodejs';

const MIME_TYPES: Record<CourseAssetKind, RegExp> = {
  images: /^image\/(png|jpeg|gif|webp|svg\+xml)$/,
  audio: /^audio\/(mpeg|mp3|wav|ogg|webm|mp4|aac)$/,
};

async function ensureBucket() {
  const service = getServiceSupabase();
  const { error: getError } = await service.storage.getBucket(COURSE_ASSET_BUCKET);
  if (!getError) return service;
  const { error } = await service.storage.createBucket(COURSE_ASSET_BUCKET, {
    public: true,
    fileSizeLimit: '50MB',
    allowedMimeTypes: [
      'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac',
    ],
  });
  if (error) throw new Error(`无法创建课程资产 bucket：${error.message}`);
  return service;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSupabase();
    const { data: { user } } = await session.auth.getUser();
    if (!user) return NextResponse.json({ success: false, error: '请先登录后再上传资产' }, { status: 401 });

    const { courseId, kind, hash, contentType, extension } = await request.json() as {
      courseId?: string; kind?: CourseAssetKind; hash?: string; contentType?: string; extension?: string;
    };
    if (!courseId || !kind || !hash || !contentType || !extension || !/^[a-zA-Z0-9_-]{1,128}$/.test(courseId)
      || !/^[a-f0-9]{64}$/.test(hash) || !/^[a-z0-9]{2,8}$/.test(extension) || !MIME_TYPES[kind].test(contentType)) {
      return NextResponse.json({ success: false, error: '资产上传参数无效' }, { status: 400 });
    }

    const service = await ensureBucket();
    const { data: course } = await service.from('courses').select('created_by').eq('id', courseId).maybeSingle();
    if (course?.created_by && course.created_by !== user.id) {
      const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).maybeSingle();
      if (profile?.role !== 'admin') {
        return NextResponse.json({ success: false, error: '您没有权限上传此课程的资产' }, { status: 403 });
      }
    }

    const path = `courses/${courseId}/${kind}/${hash}.${extension}`;
    const { data, error } = await service.storage.from(COURSE_ASSET_BUCKET).createSignedUploadUrl(path, { upsert: true });
    if (error || !data) throw new Error(error?.message || '无法创建资产上传授权');
    const { data: publicData } = service.storage.from(COURSE_ASSET_BUCKET).getPublicUrl(path);
    return NextResponse.json({ success: true, data: { path, token: data.token, publicUrl: publicData.publicUrl } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : '资产上传授权失败' }, { status: 500 });
  }
}
