/**
 * Khuôn mới: lời báo «đã dùng chung» nối vào BẰNG CHỨNG ngăn mới đọc được,
 * không nối vào việc đã gọi `rehydrate()`.
 *
 * Hai vòng nghiệm thu liên tiếp cùng vấp một lớp: `rehydrate()` luôn trả về êm
 * vì máy trạng thái của seam cố ý biến một lần đọc hỏng thành `null` — để một
 * sự cố mạng không xoá cấu hình người dùng. Đúng cho việc hydrate, nhưng nó có
 * nghĩa là không ai hỏi seam được «vừa rồi đọc có tới nơi không». Các bài dưới
 * đây đo đúng câu đó.
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

describe('nhận lựa chọn chỉ được báo xong khi CHỨNG được', () => {
  it('ngăn không đọc được thì KHÔNG báo xong, dù mọi kho đã gọi nạp lại êm', async () => {
    // Mạng chết: mọi lời gọi ném. Seam sẽ nuốt lỗi khi hydrate (đúng thiết kế),
    // nên rehydrate() vẫn resolve — đúng cái bẫy của hai vòng trước.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const { reloadAccountStoresAndConfirm } = await import('@/lib/store/account-stores');
    await expect(
      reloadAccountStoresAndConfirm(),
      'account partition was never read: adoption reported success without proof',
    ).rejects.toThrow(/account partition was never read/);
  });

  it('ngăn RỖNG vẫn là đọc được — chủ mới chưa lưu gì là chuyện bình thường', async () => {
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
          JSON.stringify({ error: { code: 'KEY_NOT_FOUND', message: 'no kv entry' } }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { reloadAccountStoresAndConfirm } = await import('@/lib/store/account-stores');
    await expect(reloadAccountStoresAndConfirm()).resolves.toBeUndefined();
  });

  it('không báo xong khi chỉ một phần đường đi qua được', async () => {
    // Đọc từng khoá thì được, nhưng liệt kê ngăn thì hỏng: chưa đủ để nói
    // ngăn của chủ mới đã tới nơi.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/kv/keys')) throw new Error('partition unreachable');
        return new Response(
          JSON.stringify({ error: { code: 'KEY_NOT_FOUND', message: 'no kv entry' } }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { reloadAccountStoresAndConfirm } = await import('@/lib/store/account-stores');
    await expect(
      reloadAccountStoresAndConfirm(),
      'account partition was never read: adoption reported success without proof',
    ).rejects.toThrow(/account partition was never read/);
  });
});

describe('có gì để mất trên máy này không', () => {
  it('thấy khoá API ở BẤT KỲ bảng nhà cung cấp nào, không chỉ ba bảng quen', async () => {
    const { hasLocalChoices } = await import('@/lib/store/local-choices');
    for (const table of [
      'providersConfig',
      'ttsProvidersConfig',
      'asrProvidersConfig',
      'imageProvidersConfig',
      'videoProvidersConfig',
      'pdfProvidersConfig',
      'webSearchProvidersConfig',
    ]) {
      expect(
        hasLocalChoices({ [table]: { some: { apiKey: 'sk-live-xxx' } } }),
        `a device can be overwritten without the confirmation: ${table} was not counted`,
      ).toBe(true);
    }
  });

  it('máy trắng tinh KHÔNG bị hỏi, kể cả khi lần chạy đầu tự chọn một mô hình', async () => {
    const { hasLocalChoices } = await import('@/lib/store/local-choices');
    expect(
      hasLocalChoices({
        modelId: 'gpt-auto-picked',
        providersConfig: { openai: { apiKey: '', baseUrl: '', customModels: [] } },
        agentVoiceOverrides: {},
      }),
      'the confirmation fired when there was nothing to lose',
    ).toBe(false);
  });

  it('thấy giọng đã nhập và giọng gán cho từng nhân vật dạy', async () => {
    const { hasLocalChoices } = await import('@/lib/store/local-choices');
    expect(
      hasLocalChoices({ ttsProvidersConfig: { eleven: { customVoices: [{ id: 'v1' }] } } }),
    ).toBe(true);
    expect(hasLocalChoices({ agentVoiceOverrides: { teacher: { voiceId: 'v1' } } })).toBe(true);
  });
});
