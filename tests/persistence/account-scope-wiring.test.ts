/**
 * Những thứ vòng nghiệm thu đầu tiên bắt được, và bài kiểm của vòng đó đã BỎ SÓT.
 *
 * Cả ba lỗi cùng một lớp: phép đo dựng lấy một nửa đường dây rồi chấm nửa đó.
 * Bài kiểm ngăn KV tự đưa bộ xác thực của mình vào, nên đường dây thật — nơi
 * mọi yêu cầu `/kv` rơi xuống nhánh mặc định và nhận khoá phân vùng dùng chung
 * — chưa bao giờ bị chạm. Các bài dưới đây chấm đúng những mối nối đó.
 */
import { describe, expect, it } from 'vitest';

import { canonicalClaimCode } from '@/lib/persistence/claim-code-format';
import { normalizeClaimCode } from '@/lib/persistence/adopt-choices';
import {
  CLAIM_TTL_MS,
  mintClaimCode,
  redeemClaimCode,
  resetClaimStore,
} from '@/lib/persistence/claim-code';

describe('mã nhận đi trọn đường người dùng thật', () => {
  it('bộ chuẩn hoá của ô nhập cho ra đúng thứ máy chủ nhận', async () => {
    resetClaimStore();
    const { code } = await mintClaimCode('owner-a', 0);
    // ĐÚNG hàm mà màn Cài đặt gọi trước khi gửi lên — nhập qua chính đường của
    // nó, không chuẩn hoá lại trong bài kiểm (làm thế là tự che lỗi).
    const fromTheInput = normalizeClaimCode(` ${code.toUpperCase().slice(0, 4)}-${code.slice(4)} `);
    expect(
      await redeemClaimCode(fromTheInput, 1),
      'no real redemption can ever succeed: the client and the server canonicalize differently',
    ).toEqual({ owner: 'owner-a' });
  });

  it('hai đầu dùng CHUNG một dạng chuẩn, không phải hai bản giống nhau', () => {
    const messy = ' AB-cd 12-34 ';
    expect(normalizeClaimCode(messy), 'the client and the server canonicalize differently').toBe(
      canonicalClaimCode(messy),
    );
  });

  it('gõ hoa hay thường đều đổi được cùng một mã', async () => {
    resetClaimStore();
    const { code } = await mintClaimCode('owner-b', 0);
    expect(await redeemClaimCode(code.toUpperCase(), 1)).toEqual({ owner: 'owner-b' });
  });

  it('vẫn hết hiệu lực sau mốc đã ký, kể cả khi gõ đúng dạng', async () => {
    resetClaimStore();
    const { code } = await mintClaimCode('owner-c', 0);
    expect(await redeemClaimCode(code.toUpperCase(), CLAIM_TTL_MS + 1)).toBeUndefined();
  });
});

describe('mọi kho phạm vi account đều được nạp lại khi nhận', () => {
  it('bản khai không bỏ sót kho nào tự khai phạm vi account', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(process.cwd(), 'lib/store');
    // Rút danh sách từ chính khai báo trong mã nguồn, không chép tay: một kho
    // account mới mà quên khai vào sổ đăng ký thì bài này đỏ.
    const declared = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) =>
        /createKVPersistStorage[^(]*\(\s*'account'/.test(readFileSync(join(dir, f), 'utf8')),
      )
      .map((f) => f.replace(/\.ts$/, ''));
    const registry = readFileSync(join(dir, 'account-stores.ts'), 'utf8');
    const missing = declared.filter((name) => !registry.includes(`/store/${name}'`));
    expect(
      missing,
      `account key set drifted from the declared scope: ${missing.join(', ')}`,
    ).toEqual([]);
    expect(declared.length, 'no account-scope store was found at all').toBeGreaterThan(1);
  });
});
