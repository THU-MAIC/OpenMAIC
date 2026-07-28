import { getServiceSupabase } from '@/lib/supabase/server';
import { COURSE_ASSET_BUCKET } from '@/lib/course-assets/shared';

export interface FetchedCourseMaterial {
  buffer: Buffer;
  fileName: string;
  contentType: string;
  size: number;
}

/**
 * 服务端从 Supabase Storage 拉取课程材料(用 service role,走管理 API)。
 *
 * 这是 4.5MB 限制绕过的关键:Function 主动出站 fetch 不计入响应体上限,
 * 但响应体本身仍受 4.5MB 限制,所以拉到的 buffer 必须在路由层做服务端截断
 * 再返回给前端。
 *
 * 支持三种路径前缀:
 *   - courses/{courseId}/...   — 老师课程材料,需校验 courseId 与 path 一致
 *   - pbl/{projectId}/...      — 学生 PBL 提交,需校验 projectId 与 path 一致
 *   - pending/{userId}/...     — 老师课程材料暂存,**强制 callerUserId === path 里的 userId**
 *
 * 不允许 .. 跳出;projectId / courseId 仅作越权检查,实际不查表(路由层负责鉴权)。
 *
 * 返回的 Error 实例带一个 `code` 字段,让路由层区分:
 *   - 'UNAUTHORIZED' (401):没传 callerUserId(路由层忘补登录校验)
 *   - 'FORBIDDEN'    (403):pending 前缀但 userId 不匹配
 *   - 其他           (404):路径不合法或文件不存在
 */
export async function fetchCourseMaterialFromStorage(
  courseIdOrProjectIdOrUserId: string,
  path: string,
  callerUserId?: string,
): Promise<FetchedCourseMaterial> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(courseIdOrProjectIdOrUserId)) {
    throw new MaterialFetchError('INVALID_ID', '无效的 courseId/projectId/userId');
  }
  if (path.includes('..')) {
    throw new MaterialFetchError('INVALID_PATH', '文件路径非法');
  }

  // 路径必须以三种合法前缀之一开头
  const expectedCoursesPrefix = `courses/${courseIdOrProjectIdOrUserId}/`;
  const expectedPblPrefix = `pbl/${courseIdOrProjectIdOrUserId}/`;
  const expectedPendingPrefix = `pending/${courseIdOrProjectIdOrUserId}/`;
  const isCourses = path.startsWith(expectedCoursesPrefix);
  const isPbl = path.startsWith(expectedPblPrefix);
  const isPending = path.startsWith(expectedPendingPrefix);
  if (!isCourses && !isPbl && !isPending) {
    throw new MaterialFetchError('NOT_FOUND', '文件路径与课程/PBL 项目不匹配');
  }

  // pending/ 前缀必须强制 callerUserId === path 里的 userId
  if (isPending) {
    if (!callerUserId) {
      throw new MaterialFetchError(
        'UNAUTHORIZED',
        'pending 路径必须先校验调用方登录态,缺少 callerUserId',
      );
    }
    if (callerUserId !== courseIdOrProjectIdOrUserId) {
      throw new MaterialFetchError(
        'FORBIDDEN',
        '无权访问该 pending 文件(只能本人访问自己的临时素材)',
      );
    }
  }

  const service = getServiceSupabase();
  const { data, error } = await service.storage.from(COURSE_ASSET_BUCKET).download(path);
  if (error || !data) {
    throw new MaterialFetchError('NOT_FOUND', `无法从存储拉取文件:${error?.message ?? 'unknown'}`);
  }

  const arrayBuffer = await data.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const fileName = path.split('/').pop() || 'document';

  return {
    buffer,
    fileName,
    contentType: data.type || 'application/octet-stream',
    size: buffer.length,
  };
}

export class MaterialFetchError extends Error {
  constructor(
    public code: 'INVALID_ID' | 'INVALID_PATH' | 'NOT_FOUND' | 'UNAUTHORIZED' | 'FORBIDDEN',
    message: string,
  ) {
    super(message);
    this.name = 'MaterialFetchError';
  }
}