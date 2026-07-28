export const COURSE_ASSET_BUCKET = 'course-assets';
export type CourseAssetKind = 'images' | 'audio' | 'material';

/**
 * 课程材料支持的文件类型(扩展名 + MIME)。
 * 维持现状:.pdf / .docx / .pptx / .txt / .md / .markdown。
 * 与 lib/document/mime.ts 的 COURSE_MATERIAL_ACCEPT 语义对齐,
 * 这里只取子集以保证 bucket 一致放行。
 */
export const MATERIAL_EXTENSIONS = new Set([
  'pdf',
  'docx',
  'pptx',
  'txt',
  'md',
  'markdown',
]);

export const MATERIAL_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
};

/**
 * 业务侧课程材料上传上限:49 MB(49,000,000 字节)。
 *
 * Supabase FREE plan 单文件硬顶 50,000,000 字节。留约 1MB 余量给
 * multipart 边界 / 后续 metadata,避免边界 case 报错。
 * 与 sign-upload 服务端校验、前端校验、文案 三处必须保持完全一致。
 */
export const MATERIAL_MAX_BYTES = 49_000_000;

/** 面向用户的上限文案(49MB)。 */
export const MATERIAL_MAX_HUMAN = '49MB';

/**
 * course-assets bucket 期望的 file_size_limit(字节)。
 *
 * Supabase dashboard 显示 "47.68 MB" 是用二进制单位(MiB)反算 50,000,000 字节
 * 造成的视觉误导,实际原始字节数就是 50,000,000。
 * 代码不依赖 Dashboard 手动配置:sign-upload 首次调用时检测不一致就 updateBucket。
 */
export const COURSE_ASSET_BUCKET_EXPECTED_FILE_SIZE_LIMIT = 50_000_000;