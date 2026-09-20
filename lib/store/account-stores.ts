/**
 * Mọi kho thuộc phạm vi `account`, và cách CHỨNG rằng chúng đã nhận đúng dữ
 * liệu của chủ sở hữu mới.
 *
 * Vòng nghiệm thu thứ nhất tìm ra «nhận xong báo thành công trong khi chỉ nạp
 * lại một nửa». Vòng thứ hai tìm ra «nhận xong báo thành công trong khi có thể
 * không nạp lại được gì cả» — cùng một lớp lỗi, nên vá lần nữa là vá sai chỗ.
 * Gốc của lớp đó: lời báo thành công nối vào việc GỌI `rehydrate()`, mà
 * `rehydrate()` luôn trả về êm — máy trạng thái của seam cố ý biến một lần đọc
 * hỏng thành `null` để một sự cố mạng không xoá cấu hình người dùng.
 *
 * Khuôn ở đây đổi câu hỏi: thay vì hỏi «đã gọi nạp chưa», hỏi **«ngăn của chủ
 * sở hữu mới có ĐỌC ĐƯỢC không»** — hỏi thẳng kho, nơi một lần hỏng vẫn còn là
 * một lần hỏng. Ngăn rỗng vẫn là đọc được: chủ mới chưa lưu gì là chuyện bình
 * thường, còn không với tới ngăn thì không phải.
 */
import { getAccountKv } from '@/lib/store/kv-persist';
import { useSettingsStore } from '@/lib/store/settings';
import { useUserProfileStore } from '@/lib/store/user-profile';

interface RehydratableStore {
  persist: { rehydrate: () => void | Promise<void> };
}

/** Tên kho → chính kho đó. Tên chỉ để thông điệp lỗi gọi đúng thứ bị sót. */
export const ACCOUNT_SCOPE_STORES: Readonly<Record<string, RehydratableStore>> = {
  settings: useSettingsStore as unknown as RehydratableStore,
  userProfile: useUserProfileStore as unknown as RehydratableStore,
};

export class AccountPartitionUnreadableError extends Error {
  constructor(cause?: unknown) {
    super(
      'account partition was never read: the adopted owner’s store could not be reached, ' +
        'so nothing proves the reload happened',
    );
    this.name = 'AccountPartitionUnreadableError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Nạp lại mọi kho phạm vi account, RỒI chứng rằng ngăn của chủ mới đọc được.
 * Ném khi chưa chứng được — bên gọi tuyệt đối không được báo xong sau một lần ném.
 */
export async function reloadAccountStoresAndConfirm(): Promise<void> {
  await Promise.all(Object.values(ACCOUNT_SCOPE_STORES).map((store) => store.persist.rehydrate()));

  // Bằng chứng, không phải lời hứa: hỏi thẳng kho. `keys()` trả mảng rỗng là
  // ĐỌC ĐƯỢC (chủ mới chưa lưu gì), còn ném là chưa với tới ngăn.
  const kv = getAccountKv();
  if (!kv) throw new AccountPartitionUnreadableError();
  try {
    await kv.keys('', 'account');
  } catch (error) {
    throw new AccountPartitionUnreadableError(error);
  }
}
