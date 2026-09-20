/**
 * Máy này đã có lựa chọn RIÊNG của người dùng chưa — thứ họ sẽ mất nếu nhận
 * cấu hình từ máy khác.
 *
 * Bản trước đếm tay ba thứ: giọng gán cho nhân vật, mô hình đang chọn, và giọng
 * tự thêm trong ba bảng nhà cung cấp. Hai hướng sai cùng lúc: nó bỏ sót khoá
 * API và bốn bảng nhà cung cấp khác (ảnh, video, tài liệu, tìm kiếm), nên người
 * chỉ cấu hình khoá ảnh sẽ bị thay KHÔNG HỎI; và nó tính cả `modelId` mà lần
 * chạy đầu tự điền, nên máy trắng tinh lại bị hỏi khi chẳng có gì để mất.
 *
 * Khuôn ở đây đổi câu hỏi: thay vì liệt kê thứ cần đếm, QUÉT chính trạng thái
 * đã lưu tìm dấu vết bàn tay người — mọi bảng tên `*ProvidersConfig`, không cần
 * biết trước có bao nhiêu bảng. Thêm một bảng mới sau này thì nó tự được tính.
 */

/** Những thứ chỉ xuất hiện khi NGƯỜI tự khai, không phải do lần chạy đầu điền. */
const HUMAN_MARKS = ['apiKey', 'baseUrl', 'customModels', 'customVoices'] as const;

function entryCarriesHumanChoice(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const record = entry as Record<string, unknown>;
  return HUMAN_MARKS.some((mark) => {
    const value = record[mark];
    if (typeof value === 'string') return value.trim() !== '';
    if (Array.isArray(value)) return value.length > 0;
    return false;
  });
}

export function hasLocalChoices(state: Record<string, unknown> | undefined): boolean {
  if (!state) return false;

  const overrides = state.agentVoiceOverrides;
  if (typeof overrides === 'object' && overrides !== null && Object.keys(overrides).length > 0) {
    return true;
  }

  // Mọi bảng nhà cung cấp, tìm theo HÌNH DẠNG TÊN chứ không theo danh sách.
  // Không phân biệt hoa thường: bảng mô hình ngôn ngữ tên `providersConfig`,
  // các bảng còn lại mang tiền tố (`ttsProvidersConfig`…). Lọc theo đúng chữ
  // hoa sẽ im lặng bỏ sót đúng cái bảng giữ khoá dùng nhiều nhất.
  return Object.entries(state)
    .filter(([key]) => /providersconfig$/i.test(key))
    .some(([, table]) => {
      if (typeof table !== 'object' || table === null) return false;
      return Object.values(table as Record<string, unknown>).some(entryCarriesHumanChoice);
    });
}
