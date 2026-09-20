/**
 * Nhận lựa chọn của một máy khác về máy này.
 *
 * Thứ tự ở đây là ràng buộc, không phải tiện tay: đổi mã xong thì cookie đã trỏ
 * sang chủ sở hữu mới, nhưng các kho trong bộ nhớ VẪN giữ giá trị hydrate từ
 * chủ sở hữu cũ. Báo "xong" trước khi nạp lại là nói một điều chưa đúng tại lúc
 * nói nó: màn hiện "đã dùng chung" trong khi sản phẩm vẫn chạy bằng lựa chọn
 * cũ. Nên hàm này chỉ trả `adopted` SAU khi việc nạp lại đã xong.
 *
 * Ba ca hỏng — mã sai, hết hạn, đã dùng — máy chủ cố ý trả về không phân biệt
 * được, và hàm này cũng không đoán hộ: tất cả là `rejected`.
 */

export type AdoptOutcome = 'adopted' | 'rejected' | 'unreachable';

export interface AdoptChoicesDeps {
  fetchImpl?: typeof globalThis.fetch;
  /** Nạp lại mọi kho phạm vi account từ ngăn của chủ sở hữu mới. */
  rehydrate: () => void | Promise<void>;
}

/** Người dán mã thường mang theo khoảng trắng và gạch nối. */
export function normalizeClaimCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

export async function adoptChoicesFromCode(
  rawCode: string,
  deps: AdoptChoicesDeps,
): Promise<AdoptOutcome> {
  const code = normalizeClaimCode(rawCode);
  if (code === '') return 'rejected';
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl('/api/claim/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch {
    return 'unreachable';
  }
  if (!response.ok) return 'rejected';

  // Nạp lại TRƯỚC khi trả `adopted`. Một lần nạp lỗi vẫn là chưa nhận xong —
  // trả `unreachable` để người thấy trạng thái lỗi thay vì một lời báo sai.
  try {
    await deps.rehydrate();
  } catch {
    return 'unreachable';
  }
  return 'adopted';
}
