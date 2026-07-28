import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import {
  COURSE_ASSET_BUCKET,
  COURSE_ASSET_BUCKET_EXPECTED_FILE_SIZE_LIMIT,
  MATERIAL_EXTENSIONS,
  MATERIAL_MAX_BYTES,
  MATERIAL_MIME_TYPES,
  type CourseAssetKind,
} from '@/lib/course-assets/shared';

export const runtime = 'nodejs';

const MIME_TYPES: Record<Exclude<CourseAssetKind, 'material'>, RegExp> = {
  images: /^image\/(png|jpeg|gif|webp|svg\+xml)$/,
  audio: /^audio\/(mpeg|mp3|wav|ogg|webm|mp4|aac)$/,
};

function extensionForContentType(contentType: string, kind: 'material'): string | null {
  const subtype = contentType.split('/')[1]?.toLowerCase().split(';')[0] ?? '';
  // 处理 jpeg / vnd.openxmlformats-... 等命名不规则的情况
  if (kind === 'material') {
    for (const [ext, mime] of Object.entries(MATERIAL_MIME_TYPES)) {
      if (mime === contentType) return ext;
    }
  }
  return subtype || null;
}

function isMaterialContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase().split(';')[0].trim();
  return Object.values(MATERIAL_MIME_TYPES).includes(lower) || lower.startsWith('text/plain');
}

function isMaterialExtension(extension: string): boolean {
  return MATERIAL_EXTENSIONS.has(extension.toLowerCase());
}

/**
 * 确保 course-assets bucket 存在,且 file_size_limit 精确等于期望值。
 * 存在但限额不符时调用 updateBucket 修正(allowed_mime_types 始终保持 null,
 * 类型限制只在应用层做,避免 dashboard 反算 unit 误导)。
 */
async function ensureBucket() {
  const service = getServiceSupabase();
  const { data: existing, error: getError } = await service.storage.getBucket(COURSE_ASSET_BUCKET);
  if (getError || !existing) {
    const { error } = await service.storage.createBucket(COURSE_ASSET_BUCKET, {
      public: true,
      fileSizeLimit: String(COURSE_ASSET_BUCKET_EXPECTED_FILE_SIZE_LIMIT),
      allowedMimeTypes: null,
    });
    if (error) throw new Error(`无法创建课程资产 bucket:${error.message}`);
    return service;
  }

  if (existing.file_size_limit !== COURSE_ASSET_BUCKET_EXPECTED_FILE_SIZE_LIMIT) {
    const { error: updateError } = await service.storage.updateBucket(COURSE_ASSET_BUCKET, {
      public: existing.public ?? true,
      fileSizeLimit: String(COURSE_ASSET_BUCKET_EXPECTED_FILE_SIZE_LIMIT),
      allowedMimeTypes: null,
    });
    if (updateError) {
      // 限额不一致不致命 — 用当前配置继续,只是上传超过当前上限会失败
      console.warn(
        `[sign-upload] bucket ${COURSE_ASSET_BUCKET} file_size_limit update failed:`,
        updateError.message,
      );
    }
  }

  return service;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSupabase();
    const { data: { user } } = await session.auth.getUser();
    if (!user) return NextResponse.json({ success: false, error: '请先登录后再上传资产' }, { status: 401 });

    const body = (await request.json()) as {
      courseId?: string;
      kind?: CourseAssetKind;
      hash?: string;
      contentType?: string;
      extension?: string;
      size?: number;
    };
    const { courseId, kind, hash, contentType, extension, size } = body;

    if (!courseId || !kind || !hash || !contentType || !extension) {
      return NextResponse.json({ success: false, error: '资产上传参数无效' }, { status: 400 });
    }
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(courseId) || !/^[a-f0-9]{64}$/.test(hash) || !/^[a-z0-9]{2,8}$/.test(extension)) {
      return NextResponse.json({ success: false, error: '资产上传参数格式无效' }, { status: 400 });
    }

    // 类型分支校验
    if (kind === 'material') {
      if (!isMaterialContentType(contentType)) {
        return NextResponse.json(
          { success: false, error: `不支持的课程材料类型:${contentType}` },
          { status: 400 },
        );
      }
      if (!isMaterialExtension(extension)) {
        return NextResponse.json(
          { success: false, error: `不支持的课程材料扩展名:.${extension}` },
          { status: 400 },
        );
      }
      // 服务端二次校验文件大小 — 前端校验不可信,这里必须再卡一次
      if (typeof size !== 'number' || size <= 0) {
        return NextResponse.json({ success: false, error: '请提供文件大小 size' }, { status: 400 });
      }
      if (size > MATERIAL_MAX_BYTES) {
        return NextResponse.json(
          {
            success: false,
            code: 'FILE_TOO_LARGE',
            error: `课程材料超过最大支持 ${MATERIAL_MAX_HUMAN}(实际 ${(size / 1024 / 1024).toFixed(1)} MB)`,
            maxBytes: MATERIAL_MAX_BYTES,
          },
          { status: 413 },
        );
      }
    } else if (kind === 'images' || kind === 'audio') {
      if (!MIME_TYPES[kind].test(contentType)) {
        return NextResponse.json({ success: false, error: '资产上传参数无效' }, { status: 400 });
      }
    } else {
      return NextResponse.json({ success: false, error: '资产上传参数无效' }, { status: 400 });
    }

    const service = await ensureBucket();

    // 路径前缀解析:
    //   - pbl-{userId}-{projectId} → 学生 PBL 提交,无需 courses 表鉴权
    //   - pending-{nanoid}           → 临时上传(课程材料尚未绑定课程),只允许创建者本人
    //   - 其他                        → 真实 courseId,必须存在于 courses 表
    let pathPrefix: string;
    const pblMatch = courseId.match(/^pbl-([a-zA-Z0-9_-]{1,64})-([a-zA-Z0-9_-]{1,64})$/);
    const pendingMatch = courseId.match(/^pending-[a-zA-Z0-9_-]{1,32}$/);
    if (pblMatch) {
      if (pblMatch[1] !== user.id) {
        return NextResponse.json({ success: false, error: '您没有权限上传此 PBL 项目的资产' }, { status: 403 });
      }
      pathPrefix = `pbl/${pblMatch[2]}/${kind}`;
    } else if (pendingMatch) {
      // pending 命名空间:目前任何登录用户都可上传(用于课程创建前的材料暂存)。
      // 安全性靠后续 extract-document 时通过 path 中的 pending 标识 + user.id 二次校验。
      pathPrefix = `pending/${user.id}/${kind}`;
    } else {
      const { data: course } = await service.from('courses').select('created_by').eq('id', courseId).maybeSingle();
      if (!course) {
        return NextResponse.json({ success: false, error: '课程不存在' }, { status: 404 });
      }
      if (course.created_by !== user.id) {
        const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).maybeSingle();
        if (profile?.role !== 'admin') {
          return NextResponse.json({ success: false, error: '您没有权限上传此课程的资产' }, { status: 403 });
        }
      }
      pathPrefix = `courses/${courseId}/${kind}`;
    }

    const path = `${pathPrefix}/${hash}.${extension}`;
    const { data, error } = await service.storage.from(COURSE_ASSET_BUCKET).createSignedUploadUrl(path, { upsert: true });
    if (error || !data) throw new Error(error?.message || '无法创建资产上传授权');
    const { data: publicData } = service.storage.from(COURSE_ASSET_BUCKET).getPublicUrl(path);
    return NextResponse.json({ success: true, data: { path, token: data.token, publicUrl: publicData.publicUrl } });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '资产上传授权失败' },
      { status: 500 },
    );
  }
}