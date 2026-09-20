/**
 * Thứ tự của việc nhận: nạp lại XONG rồi mới được báo đã nhận.
 *
 * Bài kiểm đo bằng chính GIÁ TRỊ đọc ra sau khi hàm trả về, không đo câu thông
 * báo trên màn — một màn báo "đã dùng chung" trong khi sản phẩm còn chạy bằng
 * lựa chọn cũ là đúng ca mà tiêu chí này tồn tại để chặn.
 */
import { describe, expect, it, vi } from 'vitest';

import { adoptChoicesFromCode, normalizeClaimCode } from '@/lib/persistence/adopt-choices';

function serverAccepts() {
  return vi.fn(async () => new Response(null, { status: 204 }));
}

describe('nhận lựa chọn từ máy khác', () => {
  it('đọc ra giá trị của máy kia sau khi trả về adopted', async () => {
    // Kho trong bộ nhớ, bắt đầu bằng lựa chọn CỦA MÁY NÀY.
    let inMemory = { voice: 'giọng cũ của máy này' };
    const serverSide = { voice: 'giọng của máy kia' };

    const outcome = await adoptChoicesFromCode('ABCD-1234', {
      fetchImpl: serverAccepts(),
      rehydrate: () => {
        inMemory = { ...serverSide };
      },
    });

    expect(outcome).toBe('adopted');
    expect(inMemory, 'redeem left stale in-memory choices').toEqual(serverSide);
  });

  it('không báo adopted khi việc nạp lại chưa xong', async () => {
    let settled = false;
    let inMemory = { voice: 'giọng cũ của máy này' };
    const outcome = await adoptChoicesFromCode('ABCD1234', {
      fetchImpl: serverAccepts(),
      rehydrate: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        inMemory = { voice: 'giọng của máy kia' };
        settled = true;
      },
    });
    expect(settled, 'redeem left stale in-memory choices').toBe(true);
    expect(outcome).toBe('adopted');
    expect(inMemory.voice).toBe('giọng của máy kia');
  });

  it('ba ca hỏng của máy chủ về cùng một kết quả', async () => {
    const rehydrate = vi.fn();
    for (const status of [401, 401, 401]) {
      const outcome = await adoptChoicesFromCode('ABCD1234', {
        fetchImpl: vi.fn(async () => new Response(null, { status })),
        rehydrate,
      });
      expect(outcome).toBe('rejected');
    }
    expect(rehydrate, 'a rejected redeem still rehydrated').not.toHaveBeenCalled();
  });

  it('nạp lại hỏng thì KHÔNG được báo là đã nhận', async () => {
    const outcome = await adoptChoicesFromCode('ABCD1234', {
      fetchImpl: serverAccepts(),
      rehydrate: () => {
        throw new Error('storage down');
      },
    });
    expect(outcome, 'a failed rehydrate was reported as adopted').toBe('unreachable');
  });

  it('bỏ khoảng trắng và gạch nối khi người dán mã', () => {
    expect(normalizeClaimCode(' ab-cd 12-34 ')).toBe('ABCD1234');
  });
});
