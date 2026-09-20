/**
 * Bên KIỂM rút ra từ bên LÀM — không dựng song song.
 *
 * Bốn vòng nghiệm thu, ba lần cùng một bệnh: bằng chứng «đã nhận xong» được
 * dựng độc lập với việc nạp lại, và cờ «có gì để mất» được dựng độc lập với
 * danh sách kho mà việc nhận thay. Các bài dưới đây đo đúng chỗ nối đó, và bài
 * ĐẦU TIÊN là ca mà vòng ba để lọt: lời đọc từng khoá hỏng, lời liệt kê ngăn
 * lại được — hai lời gọi khác nhau, nên một phép thử bên cạnh trả lời sai.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage implements Storage {
  private readonly m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
}

const noEntry = () =>
  new Response(JSON.stringify({ error: { code: 'KEY_NOT_FOUND', message: 'no kv entry' } }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('window', {} as Window & typeof globalThis);
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.doMock('@/lib/persistence/enabled', () => ({
    isBrowserPersistenceEnabled: () => true,
    getPersistenceRequestHeaders: async () => ({}),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bằng chứng đã-nhận-xong lấy từ chính việc nạp lại', () => {
  it('đọc từng khoá HỎNG nhưng liệt kê ngăn ĐƯỢC thì vẫn KHÔNG báo xong', async () => {
    // Đúng ca vòng ba để lọt: một phép thử bên cạnh (liệt kê ngăn) trả lời
    // được, nên bản trước kết luận nhầm là đã nhận xong.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/kv/keys')) {
          return new Response('[]', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { reloadAccountStoresAndConfirm } = await import('@/lib/store/account-stores');
    await expect(
      reloadAccountStoresAndConfirm(),
      'account partition was never read: a side probe answered instead of the reload itself',
    ).rejects.toThrow(/account partition was never read/);
  });

  it('ngăn RỖNG vẫn là nhận được — chủ mới chưa lưu gì là chuyện bình thường', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => noEntry()),
    );
    const { reloadAccountStoresAndConfirm } = await import('@/lib/store/account-stores');
    // Ngăn đọc được nhưng trống: nhận được, và KHÔNG kho nào bị kể là đã thay.
    const scope = await reloadAccountStoresAndConfirm();
    expect(scope.replaced, 'adoption claimed a key the other machine never wrote').toEqual([]);
    expect(scope.keptOwn.length).toBeGreaterThan(1);
  });

  it('mạng chết hoàn toàn thì KHÔNG báo xong', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const { reloadAccountStoresAndConfirm } = await import('@/lib/store/account-stores');
    await expect(
      reloadAccountStoresAndConfirm(),
      'account partition was never read',
    ).rejects.toThrow(/account partition was never read/);
  });

  it('nêu ĐÍCH DANH kho nào không nhận được, không nói chung chung', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const { reloadAccountStoresAndConfirm } = await import('@/lib/store/account-stores');
    const error = await reloadAccountStoresAndConfirm().catch((e: Error) => e);
    expect(String(error)).toMatch(/settings-storage/);
    expect(String(error), 'the profile store was left out of the report').toMatch(
      /user-profile-storage/,
    );
  });
});

describe('thứ máy kia chưa từng đặt thì để nguyên, và không bị kể là đã thay', () => {
  it('ngăn có kho này nhưng KHÔNG có kho kia → chỉ kho có mới tính là đã thay', async () => {
    // Máy kia đã khai cấu hình nhưng chưa bao giờ mở màn hồ sơ, nên ngăn của
    // nó chỉ có một trong hai kho.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('settings-storage')) {
          return new Response(
            JSON.stringify({ value: { state: { modelId: 'cua-may-kia' }, version: 4 } }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        return noEntry();
      }),
    );
    const { reloadAccountStoresAndConfirm } = await import('@/lib/store/account-stores');
    const scope = await reloadAccountStoresAndConfirm();
    expect(scope.replaced, 'adoption claimed a key the other machine never wrote').toEqual([
      'settings',
    ]);
    expect(scope.keptOwn, 'adoption claimed a key the other machine never wrote').toEqual([
      'userProfile',
    ]);
  });

  it('ngăn có CẢ HAI kho thì không còn gì phải giữ nguyên', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const body = String(input).includes('settings-storage')
          ? { value: { state: { modelId: 'cua-may-kia' }, version: 4 } }
          : { value: { state: { nickname: 'cua-may-kia' }, version: 0 } };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const { reloadAccountStoresAndConfirm } = await import('@/lib/store/account-stores');
    const scope = await reloadAccountStoresAndConfirm();
    expect(scope.keptOwn).toEqual([]);
    expect(scope.replaced.length, 'no store was reported as replaced at all').toBeGreaterThan(1);
  });
});

describe('có gì để mất trên máy này không — soi MỌI kho việc nhận sẽ thay', () => {
  it('thấy hồ sơ người dùng: biệt danh, tiểu sử, ảnh tự tải lên', async () => {
    const { hasLocalChoices } = await import('@/lib/store/local-choices');
    const { AVATAR_OPTIONS } = await import('@/lib/store/user-profile');
    expect(hasLocalChoices({ nickname: 'Mạnh' }), 'the profile store was not counted').toBe(true);
    expect(hasLocalChoices({ bio: 'dạy vật lý' }), 'the profile store was not counted').toBe(true);
    expect(hasLocalChoices({ avatar: '/uploads/mine.png' })).toBe(true);
    // Ảnh dựng sẵn KHÔNG phải lựa chọn của người.
    expect(hasLocalChoices({ avatar: AVATAR_OPTIONS[0], nickname: '', bio: '' })).toBe(false);
  });

  it('thấy khoá để ở TÊN TRƯỜNG khác, không chỉ apiKey', async () => {
    const { hasLocalChoices } = await import('@/lib/store/local-choices');
    expect(
      hasLocalChoices({ pdfProvidersConfig: { alidocmind: { accessKeySecret: 's3cr3t' } } }),
      'a credential under a different field name was overwritten without the confirmation',
    ).toBe(true);
    expect(hasLocalChoices({ providersConfig: { openai: { apiKey: 'sk-live' } } })).toBe(true);
  });

  it('máy TRẮNG TINH không bị hỏi — địa chỉ mặc định không phải lựa chọn', async () => {
    const { hasLocalChoices } = await import('@/lib/store/local-choices');
    expect(
      hasLocalChoices({
        modelId: 'auto-picked-on-first-run',
        webSearchProvidersConfig: { exa: { baseUrl: 'https://api.exa.ai' } },
        providersConfig: { openai: { apiKey: '', customModels: [] } },
      }),
      'the confirmation fired when there was nothing to lose',
    ).toBe(false);
  });

  it('câu trả lời của màn soi CẢ HAI kho, không chỉ kho cấu hình', async () => {
    const { hasLocalChoicesInAccountScope } = await import('@/lib/store/local-choices');
    // Kho cấu hình trắng, kho hồ sơ có biệt danh → vẫn phải hỏi.
    expect(
      hasLocalChoicesInAccountScope([{ providersConfig: {} }, { nickname: 'Mạnh' }]),
      'the overwrite confirmation ignored a store that adoption replaces',
    ).toBe(true);
  });
});
