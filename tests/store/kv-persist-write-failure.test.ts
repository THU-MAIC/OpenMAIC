/**
 * Ghi hỏng thì người phải BIẾT, và giá trị chưa tới máy chủ không được đọc ra
 * như thể đã tới.
 *
 * Mất im lặng nguy hơn mất ồn ào: người đổi giọng lúc mạng chập, sản phẩm
 * không nói gì, rồi máy thứ hai mở ra thấy trống — mà người vẫn tin là đã lưu.
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
  getItem(key: string): string | null {
    return this.m.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.m.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  setItem(key: string, value: string): void {
    this.m.set(key, value);
  }
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

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

describe('a write the server never took', () => {
  it('is never reported as saved, and never read back as if it landed', async () => {
    // Đọc lúc nạp: không có gì. Ghi: máy chủ im.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return new Response(
            JSON.stringify({ error: { code: 'KEY_NOT_FOUND', message: 'no kv entry' } }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          );
        }
        throw new Error('network down');
      }),
    );

    const { createKVPersistStorage } = await import('@/lib/store/kv-persist');
    const { subscribeToPersistHealth, resetPersistHealth } =
      await import('@/lib/store/persist-health');
    resetPersistHealth();
    const seen: string[] = [];
    const unsubscribe = subscribeToPersistHealth((event) => seen.push(event.status));

    const storage = createKVPersistStorage('account', {});
    await storage.getItem('settings-storage');
    await flush();
    await storage.setItem('settings-storage', { state: { voice: 'chưa tới máy chủ' }, version: 4 });
    await flush();

    expect(seen, 'a failed write was reported as saved').toContain('unavailable');

    // Và lần đọc kế tiếp không được dựng lại giá trị chưa tới máy chủ.
    const readBack = await storage.getItem('settings-storage');
    await flush();
    expect(
      (readBack as { state?: { voice?: string } } | null)?.state?.voice,
      'a value that never reached the server was read back as stored',
    ).not.toBe('chưa tới máy chủ');

    unsubscribe();
  });
});
