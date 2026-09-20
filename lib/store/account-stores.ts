/**
 * Mọi kho thuộc phạm vi `account` — MỘT bản khai, nhiều bên đọc.
 *
 * Khi một máy nhận lựa chọn từ máy khác, cookie đã trỏ sang chủ sở hữu mới
 * nhưng các kho trong bộ nhớ vẫn giữ giá trị hydrate từ chủ cũ. Nạp lại THIẾU
 * một kho còn tệ hơn không nạp: màn báo «đã dùng chung», người tin là xong, rồi
 * lần sửa hồ sơ kế tiếp GHI ĐÈ hồ sơ của máy kia bằng giá trị cũ của máy này.
 *
 * Danh sách nằm ở đây, cạnh một phép kiểm đếm nó, để chỗ gọi không còn là một
 * danh sách chép tay dài một phần tử — đúng lỗ mà vòng nghiệm thu đầu tiên tìm
 * ra. Thêm một kho `account` mới mà quên khai ở đây thì bài kiểm đỏ.
 */
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

/** Nạp lại mọi kho phạm vi account. Một kho hỏng KHÔNG che các kho còn lại. */
export async function rehydrateAccountStores(): Promise<void> {
  const results = await Promise.allSettled(
    Object.values(ACCOUNT_SCOPE_STORES).map((store) => store.persist.rehydrate()),
  );
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    throw new Error(
      `rehydrateAccountStores: ${failed.length}/${results.length} kho account không nạp lại được`,
    );
  }
}
