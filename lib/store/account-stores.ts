/**
 * Mọi kho thuộc phạm vi `account` — MỘT bản khai, và mọi bên kiểm rút ra từ nó.
 *
 * Bốn vòng nghiệm thu, ba lần cùng một bệnh: bên KIỂM được dựng độc lập với
 * bên LÀM thay vì rút ra từ chính bên làm. Việc nhận lựa chọn duyệt danh sách
 * kho ở đây, nhưng cờ «có gì để mất» lại tự viết một bản quét của riêng nó và
 * chỉ soi một kho; việc nạp lại PHÁT ra tín hiệu hỏng mang tên kho, nhưng bằng
 * chứng «đã nhận xong» lại tự chế một phép thử bên cạnh. Mỗi lần như vậy là một
 * bản mô tả thứ hai của cùng một sự thật, và hai bản thì lệch.
 *
 * Nên file này giữ bản khai DUY NHẤT, và cả hai bên kiểm đều đọc từ đây.
 */
import { isPersistUnavailable } from '@/lib/store/persist-health';
import { useSettingsStore } from '@/lib/store/settings';
import { useUserProfileStore } from '@/lib/store/user-profile';

interface AccountStore {
  /** Tên lưu bền — CHÍNH tên mà tín hiệu sức khoẻ nêu khi lần đọc hỏng. */
  persistName: string;
  persist: { rehydrate: () => void | Promise<void> };
  getState: () => Record<string, unknown>;
}

/**
 * Bản khai. Thêm một kho phạm vi `account` mà quên khai ở đây thì bài kiểm đỏ
 * (nó rút danh sách từ chính mã nguồn của thư mục kho, không chép tay).
 */
export const ACCOUNT_SCOPE_STORES: Readonly<Record<string, AccountStore>> = {
  settings: {
    persistName: 'settings-storage',
    persist: useSettingsStore.persist,
    getState: () => useSettingsStore.getState() as unknown as Record<string, unknown>,
  },
  userProfile: {
    persistName: 'user-profile-storage',
    persist: useUserProfileStore.persist,
    getState: () => useUserProfileStore.getState() as unknown as Record<string, unknown>,
  },
};

/** Trạng thái hiện tại của MỌI kho account — nguồn cho mọi bên kiểm. */
export function accountStoreStates(): Record<string, unknown>[] {
  return Object.values(ACCOUNT_SCOPE_STORES).map((store) => store.getState());
}

export class AccountPartitionUnreadableError extends Error {
  constructor(readonly stores: readonly string[]) {
    super(
      `account partition was never read: ${stores.join(', ')} — the adopted owner’s values ` +
        'did not arrive, so nothing may report success',
    );
    this.name = 'AccountPartitionUnreadableError';
  }
}

/**
 * Nạp lại mọi kho account, và CHỨNG bằng chính tín hiệu mà việc nạp phát ra.
 *
 * `rehydrate()` luôn trả về êm — tầng lưu bền cố ý biến một lần đọc hỏng thành
 * «chưa ngã ngũ» để một sự cố mạng không thay dữ liệu người dùng bằng mặc định.
 * Nhưng cùng lúc đó nó PHÁT một tín hiệu mang tên kho. Ta nghe đúng tín hiệu
 * ấy: không thêm một phép thử nào bên cạnh, vì phép thử bên cạnh là một lời
 * gọi KHÁC và trả lời cho một câu hỏi KHÁC.
 */
export async function reloadAccountStoresAndConfirm(): Promise<void> {
  await Promise.all(Object.values(ACCOUNT_SCOPE_STORES).map((store) => store.persist.rehydrate()));

  // Đọc thẳng thứ việc nạp vừa GHI, không nghe kênh phát: kênh cố ý phát chậm
  // một nhịp để lời cảnh báo khỏi chớp tắt, còn quyết định thì không được phép
  // phụ thuộc vào nhịp đó.
  const broken = Object.values(ACCOUNT_SCOPE_STORES)
    .filter((store) => isPersistUnavailable(store.persistName))
    .map((store) => store.persistName);

  if (broken.length > 0) throw new AccountPartitionUnreadableError(broken);
}
