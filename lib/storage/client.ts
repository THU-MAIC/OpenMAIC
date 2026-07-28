/**
 * @deprecated 2026-07-27
 *
 * 这个文件原本的 uploadBlobToStorage 指向不存在的 /api/storage/upload 路由,
 * 永远返回 null — 是已知的隐藏 bug。
 *
 * 替代方案:
 *   - 课程资产(图片/音频/材料):用 @/lib/course-assets/client 的 uploadCourseBlob / uploadCourseMaterial
 *   - 课程内联 data URL 迁移:用 externalizeCourseAssets (lib/course-assets/externalize.ts)
 *
 * 这个文件保留 export,只为不破坏仍在调用 uploadBlobToStorage 的旧代码(PBL 学生提交)。
 * 后续清理 PBL 客户端时再删。
 */

export async function uploadBlobToStorage(
  _blob: Blob,
  _type: 'media' | 'audio' | 'poster',
  _signal?: AbortSignal,
): Promise<string | null> {
  console.warn(
    '[lib/storage/client] uploadBlobToStorage is deprecated and a no-op. ' +
      'Use uploadCourseBlob from @/lib/course-assets/client instead.',
  );
  return null;
}

export async function sha256(_blob: Blob): Promise<string> {
  throw new Error('sha256 moved to @/lib/course-assets/client — use uploadCourseBlob');
}