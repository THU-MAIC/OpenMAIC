/**
 * Máy này đã có lựa chọn RIÊNG của người dùng chưa — thứ họ sẽ mất nếu nhận
 * cấu hình từ máy khác.
 *
 * Hai lần sai trước đều cùng một kiểu: bản kiểm này tự liệt kê thứ cần đếm,
 * trong khi việc nhận lại duyệt một bản khai khác. Liệt kê ba loại thì bỏ sót
 * khoá API; liệt kê bốn tên trường thì bỏ sót khoá của nhà cung cấp đọc tài
 * liệu (nó để ở `accessKeyId`/`accessKeySecret`); soi một kho thì bỏ sót kho hồ
 * sơ người dùng, mà việc nhận thay CẢ HAI.
 *
 * Nên ở đây không còn danh sách nào cả:
 * - kho nào cần soi → duyệt sổ đăng ký các kho account (nguồn mà việc nhận dùng)
 * - trường nào là dấu tay người → nhận theo HÌNH DẠNG TÊN, không theo tên cụ thể
 * - ảnh đại diện → so với chính danh sách ảnh dựng sẵn mà kho ấy xuất ra
 */
import { AVATAR_OPTIONS } from '@/lib/store/user-profile';

/**
 * Tên trường mang bí mật. Nhận theo hình dạng: mọi thứ có `key`, `secret` hay
 * `token` trong tên. Cố ý KHÔNG tính `baseUrl` — bảng tìm-kiếm-web dựng sẵn đã
 * mang địa chỉ mặc định, nên tính nó là hỏi người dùng trên một máy trắng tinh.
 */
const SECRET_FIELD = /key|secret|token/i;

/** Danh sách do người tự thêm vào, phân biệt với thứ bản dựng seed sẵn. */
const USER_ADDED_LIST = /^custom[A-Z]/;

function entryCarriesHumanChoice(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  return Object.entries(entry as Record<string, unknown>).some(([field, value]) => {
    if (typeof value === 'string' && SECRET_FIELD.test(field)) return value.trim() !== '';
    if (Array.isArray(value) && USER_ADDED_LIST.test(field)) return value.length > 0;
    return false;
  });
}

function stateCarriesHumanChoice(state: Record<string, unknown> | undefined): boolean {
  if (!state) return false;

  // Giọng gán cho từng nhân vật dạy.
  const overrides = state.agentVoiceOverrides;
  if (typeof overrides === 'object' && overrides !== null && Object.keys(overrides).length > 0) {
    return true;
  }

  // Hồ sơ người dùng: biệt danh, tiểu sử, và ảnh KHÁC bộ dựng sẵn.
  if (typeof state.nickname === 'string' && state.nickname.trim() !== '') return true;
  if (typeof state.bio === 'string' && state.bio.trim() !== '') return true;
  if (
    typeof state.avatar === 'string' &&
    state.avatar !== '' &&
    !(AVATAR_OPTIONS as readonly string[]).includes(state.avatar)
  ) {
    return true;
  }

  // Mọi bảng nhà cung cấp, nhận theo hình dạng tên — không phân biệt hoa thường
  // vì bảng mô hình ngôn ngữ tên `providersConfig`, các bảng khác mang tiền tố.
  return Object.entries(state)
    .filter(([key]) => /providersconfig$/i.test(key))
    .some(([, table]) => {
      if (typeof table !== 'object' || table === null) return false;
      return Object.values(table as Record<string, unknown>).some(entryCarriesHumanChoice);
    });
}

/** Dùng cho bài kiểm và cho bên gọi đã có sẵn trạng thái trong tay. */
export function hasLocalChoices(state: Record<string, unknown> | undefined): boolean {
  return stateCarriesHumanChoice(state);
}

/**
 * Câu trả lời thật cho màn Cài đặt: soi MỌI kho mà việc nhận sẽ thay, lấy
 * danh sách từ chính sổ đăng ký mà việc nhận duyệt.
 */
export function hasLocalChoicesInAccountScope(states: Record<string, unknown>[]): boolean {
  return states.some(stateCarriesHumanChoice);
}
