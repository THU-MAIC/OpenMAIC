/**
 * Có bật lưu trữ phía máy chủ không, và gọi nó thì mang theo header gì.
 *
 * Tách khỏi `bootstrap.ts` một cách CÓ CHỦ Ý: bootstrap chạy tác dụng phụ ngay
 * ở tầng module — nó cấu hình kho chạy, kho tài liệu và kho tệp cho cả ứng dụng
 * khi cờ bật. Bất cứ module nào import bootstrap đều kéo theo các tác dụng phụ
 * đó, kể cả khi nó chỉ muốn hỏi đúng một câu hỏi đúng/sai. Seam lưu bền cần
 * đúng câu hỏi đó, nên nó đọc ở đây. `bootstrap.ts` cũng đọc ở đây, nên hai bên
 * không thể lệch nhau.
 */
import { BrowserKVStore } from '@openmaic/storage';

import { getLearnerKey } from '@/lib/runtime/learner-key';

let deviceKv: BrowserKVStore | undefined;
let learnerKeyPromise: Promise<string> | undefined;

export function isBrowserPersistenceEnabled(): boolean {
  return typeof window !== 'undefined' && process.env.NEXT_PUBLIC_PERSISTENCE === '1';
}

/**
 * Lựa chọn (cấu hình, hồ sơ) đi theo người qua ngăn tài khoản trên máy chủ.
 *
 * Bật cùng lưu trữ máy chủ đầy đủ, HOẶC riêng một mình bằng
 * `NEXT_PUBLIC_ACCOUNT_SYNC=1`. Cờ riêng tồn tại vì lưu trữ đầy đủ còn chuyển
 * danh sách lớp học sang máy chủ — mà danh sách đó chỉ phục vụ được khi agent
 * runtime (thử nghiệm) cũng bật; không có nó trang chủ trả 404 và lớp học trong
 * trình duyệt biến khỏi danh sách. Cờ riêng chỉ đưa ngăn tài khoản lên mạng;
 * lớp học, tài liệu, tệp ở yên trên máy như trước.
 */
export function isAccountSyncEnabled(): boolean {
  if (isBrowserPersistenceEnabled()) return true;
  return typeof window !== 'undefined' && process.env.NEXT_PUBLIC_ACCOUNT_SYNC === '1';
}

export function getPersistenceLearnerKey(): Promise<string> {
  if (!isBrowserPersistenceEnabled()) {
    return Promise.reject(new Error('Browser persistence is not enabled'));
  }
  return (learnerKeyPromise ??= getLearnerKey((deviceKv ??= new BrowserKVStore())).catch(
    (error) => {
      learnerKeyPromise = undefined;
      throw error;
    },
  ));
}

export async function getPersistenceRequestHeaders(): Promise<Record<string, string>> {
  if (!isBrowserPersistenceEnabled()) return {};
  const resolvedLearnerKey = await getPersistenceLearnerKey();
  const token = process.env.NEXT_PUBLIC_PERSISTENCE_TOKEN;
  return {
    'x-learner-key': resolvedLearnerKey,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}
