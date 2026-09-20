/**
 * Dạng chuẩn của mã nhận — MỘT bản, dùng ở cả hai phía.
 *
 * Tách riêng khỏi `claim-code.ts` vì file đó dùng `node:crypto` và chỉ chạy
 * phía máy chủ, còn ô nhập mã chạy trên trình duyệt. Hai bản chuẩn hoá khác
 * nhau ở hai đầu là cách làm cho KHÔNG mã nào đổi được — và vì ba ca hỏng cố ý
 * trả cùng một câu, lỗi đó lộ ra dưới dạng «mã không dùng được», thứ trông y
 * hệt một lỗi gõ nhầm.
 *
 * Người đọc mã từ màn hình kia rồi gõ lại: hoa hay thường là chuyện của bàn
 * phím, không phải của giao thức, và họ hay dán kèm khoảng trắng hoặc gạch nối.
 */
export function canonicalClaimCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toLowerCase();
}
