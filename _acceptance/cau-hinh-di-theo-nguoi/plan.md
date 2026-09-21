# Lựa chọn của người đi theo người — kế hoạch thi công

> **For agentic workers:** REQUIRED SUB-SKILL: dùng `superpowers:subagent-driven-development` (khuyến nghị) hoặc `superpowers:executing-plans` để thi công từng task. Các bước dùng checkbox (`- [ ]`).

**Goal:** Đưa lựa chọn phạm vi `account` lên một ngăn phía máy chủ chia theo chủ sở hữu, và thêm mã nhận một lần để máy thứ hai rơi vào đúng ngăn của máy thứ nhất.

**Architecture:** Gói lưu trữ đã có hợp đồng KV hai phạm vi và một bản chạy qua mạng (`HttpKVStore`) chưa ai dựng; thiếu bản lưu phía máy chủ và bộ xử lý HTTP. Thêm `PgKVStore` + `createKVHttpHandler` theo đúng khuôn các miền đã có (document/asset/runtime), nối vào bộ điều phối `/kv`, rồi cho app dựng `HttpKVStore` khi lưu trữ phía máy chủ bật. Danh tính lấy từ cookie chủ sở hữu đã có; mã nhận ghi vào tham số `authenticatedOwnerId` đã có sẵn.

**Tech Stack:** TypeScript · Next.js 16 (App Router, `runtime = 'nodejs'`) · PostgreSQL qua lớp `Queryable` đã trừu tượng · Vitest (+ PGlite cho bài kiểm chạm SQL) · zustand `persist` · React 19.

**Spec:** `_acceptance/cau-hinh-di-theo-nguoi/design.md` · hợp đồng `_acceptance/cau-hinh-di-theo-nguoi/contract.md` · bộ đo `_acceptance/cau-hinh-di-theo-nguoi/evals.yaml`

## Global Constraints

- Ngăn phía máy chủ CHỈ phục vụ phạm vi `account`. Yêu cầu mang `device` phải bị TỪ CHỐI tại cổng vào (400), không im lặng bỏ qua — AC-8.
- Hạn mã nhận: **10 phút**. Cấu hình khai dài hơn 10 phút phải làm chính bài kiểm đỏ — AC-3.
- Ba ca hỏng khi đổi mã (sai / hết hạn / đã dùng) trả về **cùng một thân phản hồi và cùng mã trạng thái** — AC-5.
- Mã sinh bằng `node:crypto` và lưu ở dạng **băm**, không lưu bản rõ.
- Lưu trữ phía máy chủ TẮT ⇒ đường ghi/đọc lựa chọn giữ nguyên hành vi cũ, không chạm mạng — AC-9.
- Đọc lỗi KHÔNG bao giờ được hiểu thành trống; ghi lỗi KHÔNG bao giờ được báo là đã lưu — AC-10, AC-15.
- Mọi chuỗi mới phải có mục trong cả 12 tệp `lib/i18n/locales/*.json`.
- **Mỗi phép đo mới phải sinh kèm cặp hai chiều trên cùng dữ liệu dựng sẵn**: vật lành → xanh; phá vật thật trong bản sao → đỏ với thông điệp ghim đúng chuỗi ghi trong `expected` của eval tương ứng. Thiếu cặp = task CHƯA XONG.
- Không đặt tệp nào dưới `docs/` — kho bỏ qua cả thư mục đó (`.gitignore:80`).

## Cấu trúc tệp

| Tệp | Trách nhiệm |
|---|---|
| `packages/@openmaic/storage/src/kv/pg.ts` | Bản lưu KV trên PostgreSQL, chia ngăn theo chủ sở hữu, chỉ nhận `account` |
| `packages/@openmaic/storage/src/server/kv.ts` | Bộ xử lý HTTP cho `/kv/entries/*` và `/kv/keys` |
| `packages/@openmaic/storage/src/server/index.ts` | Thêm nhánh `/kv` vào bộ điều phối (sửa) |
| `packages/@openmaic/storage/src/index.ts` | Xuất `PgKVStore`, `ensureKVSchema` (sửa) |
| `lib/store/kv-persist.ts` | Dựng `HttpKVStore` khi lưu trữ máy chủ bật (sửa) |
| `lib/persistence/claim-code.ts` | Sinh, băm, hết hạn, đánh dấu đã dùng cho mã nhận |
| `app/api/claim/route.ts` | POST — máy A xin mã |
| `app/api/claim/redeem/route.ts` | POST — máy B đổi mã, cấp lại cookie chủ sở hữu |
| `components/settings/my-devices-settings.tsx` | Mục «Máy của tôi» |

---

### Task 1: Bản lưu KV trên PostgreSQL

**independent: true** (không phụ thuộc task nào)

**Files:**
- Create: `packages/@openmaic/storage/src/kv/pg.ts`
- Modify: `packages/@openmaic/storage/src/index.ts`
- Test: `packages/@openmaic/storage/test/pg-kv-store.test.ts`

**Interfaces:**
- Consumes: `Queryable`, `QueryResult` từ `../runtime/pg.js`; `KVScope`, `assertKVScope`, `KVScopeViolationError` từ `./types.js`
- Produces:
  ```ts
  export interface PgKVStoreOptions { withTransaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T>; }
  export declare function ensureKVSchema(tx: Queryable): Promise<void>;
  export declare class PgKVStore {
    constructor(options: PgKVStoreOptions);
    get<T>(owner: string, key: string, scope?: KVScope): Promise<T | null>;
    set<T>(owner: string, key: string, value: T, scope?: KVScope): Promise<void>;
    remove(owner: string, key: string, scope?: KVScope): Promise<void>;
    keys(owner: string, prefix?: string, scope?: KVScope): Promise<string[]>;
  }
  ```
  Mọi phương thức ném `KVScopeViolationError` khi `scope !== 'account'`.

**Phục vụ:** E8 (phạm vi device bị chặn), E11 (chia ngăn theo chủ sở hữu)

- [ ] **Step 1: Viết bài kiểm đỏ — phạm vi device bị từ chối**

```ts
// packages/@openmaic/storage/test/pg-kv-store.test.ts
import { beforeEach, describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PgKVStore, ensureKVSchema, type PgKVStoreOptions } from '../src/kv/pg.js';
import { KVScopeViolationError } from '../src/kv/types.js';
import type { Queryable } from '../src/runtime/pg.js';

function options(db: PGlite): PgKVStoreOptions {
  return { withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)) };
}

describe('PgKVStore', () => {
  let db: PGlite;
  let store: PgKVStore;
  beforeEach(async () => {
    db = new PGlite();
    await db.transaction((tx: Queryable) => ensureKVSchema(tx));
    store = new PgKVStore(options(db));
  });

  test('device scope never crosses the network boundary', async () => {
    await expect(store.set('owner-1', 'k', 1, 'device')).rejects.toBeInstanceOf(
      KVScopeViolationError,
    );
    await expect(store.get('owner-1', 'k', 'device')).rejects.toBeInstanceOf(
      KVScopeViolationError,
    );
  });

  test('account partition never leaks across owners', async () => {
    await store.set('owner-1', 'settings', { voice: 'a' });
    await store.set('owner-2', 'settings', { voice: 'b' });
    expect(await store.get('owner-1', 'settings')).toEqual({ voice: 'a' });
    expect(await store.get('owner-2', 'settings')).toEqual({ voice: 'b' });
    expect(await store.keys('owner-1')).toEqual(['settings']);
  });
});
```

- [ ] **Step 2: Chạy để xác nhận nó ĐỎ**

Run: `pnpm --filter @openmaic/storage test -- pg-kv-store`
Expected: FAIL — `Cannot find module '../src/kv/pg.js'`

- [ ] **Step 3: Viết bản cài đặt tối thiểu**

```ts
// packages/@openmaic/storage/src/kv/pg.ts
import type { Queryable } from '../runtime/pg.js';
import { assertKVScope, KVScopeViolationError, type KVScope } from './types.js';

export interface PgKVStoreOptions {
  withTransaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T>;
}

export async function ensureKVSchema(tx: Queryable): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS kv_entries (
    owner_id text NOT NULL,
    key      text NOT NULL,
    value    jsonb NOT NULL,
    PRIMARY KEY (owner_id, key)
  )`);
}

/** Ngăn phía máy chủ phục vụ DUY NHẤT phạm vi account. */
function assertAccountOnly(scope: KVScope): void {
  if (assertKVScope(scope) !== 'account') {
    throw new KVScopeViolationError(
      `device scope crossed the network boundary: the server KV store serves 'account' only`,
    );
  }
}

export class PgKVStore {
  readonly #withTransaction: PgKVStoreOptions['withTransaction'];
  constructor(options: PgKVStoreOptions) {
    this.#withTransaction = options.withTransaction;
  }
  async get<T>(owner: string, key: string, scope: KVScope = 'account'): Promise<T | null> {
    assertAccountOnly(scope);
    return this.#withTransaction(async (tx) => {
      const r = await tx.query('SELECT value FROM kv_entries WHERE owner_id = $1 AND key = $2', [owner, key]);
      return r.rows.length ? (r.rows[0] as { value: T }).value : null;
    });
  }
  async set<T>(owner: string, key: string, value: T, scope: KVScope = 'account'): Promise<void> {
    assertAccountOnly(scope);
    await this.#withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO kv_entries (owner_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [owner, key, JSON.stringify(value)],
      );
    });
  }
  async remove(owner: string, key: string, scope: KVScope = 'account'): Promise<void> {
    assertAccountOnly(scope);
    await this.#withTransaction(async (tx) => {
      await tx.query('DELETE FROM kv_entries WHERE owner_id = $1 AND key = $2', [owner, key]);
    });
  }
  async keys(owner: string, prefix = '', scope: KVScope = 'account'): Promise<string[]> {
    assertAccountOnly(scope);
    return this.#withTransaction(async (tx) => {
      const r = await tx.query(
        'SELECT key FROM kv_entries WHERE owner_id = $1 AND key LIKE $2 ORDER BY key',
        [owner, `${prefix}%`],
      );
      return r.rows.map((row) => (row as { key: string }).key);
    });
  }
}
```

- [ ] **Step 4: Chạy để xác nhận XANH**

Run: `pnpm --filter @openmaic/storage test -- pg-kv-store`
Expected: PASS, 2 bài.

- [ ] **Step 5: Lượt phá-thử (bắt buộc — cặp hai chiều)**

Trong một BẢN SAO của cây, bỏ dòng `assertAccountOnly(scope)` trong `set`, chạy lại bài kiểm.
Expected: ĐỎ, và thông điệp chứa đúng chuỗi `device scope crossed the network boundary`.
Rồi bỏ bản sao đi — KHÔNG commit bản đã phá.

- [ ] **Step 6: Xuất khỏi gói**

Thêm vào `packages/@openmaic/storage/src/index.ts`, cạnh các dòng xuất KV đã có:
```ts
export { PgKVStore, ensureKVSchema, type PgKVStoreOptions } from './kv/pg.js';
```

- [ ] **Step 7: Commit**

```bash
git add packages/@openmaic/storage/src/kv/pg.ts packages/@openmaic/storage/src/index.ts packages/@openmaic/storage/test/pg-kv-store.test.ts
git commit -m "feat(storage): serve the account KV scope from PostgreSQL"
```

---

### Task 2: Bộ xử lý HTTP cho ngăn KV

**independent: false** — cần `PgKVStore` từ Task 1.

**Files:**
- Create: `packages/@openmaic/storage/src/server/kv.ts`
- Modify: `packages/@openmaic/storage/src/server/index.ts:769-789` (bộ điều phối đường dẫn)
- Test: `packages/@openmaic/storage/test/kv-http-handler.test.ts`

**Interfaces:**
- Consumes: `PgKVStore` (Task 1); `StorageHttpHandlerOptions.authenticate` đã có trong `src/server/index.ts`
- Produces:
  ```ts
  export interface KVHttpHandlerOptions {
    authenticate(req: IncomingMessage): Promise<{ owner: string } | undefined>;
    maxBodyBytes?: number;
  }
  export declare function createKVHttpHandler(store: PgKVStore, options: KVHttpHandlerOptions): RequestListener;
  ```
  Đường phục vụ: `GET|PUT|DELETE /kv/entries/<key>` · `GET /kv/keys?prefix=` — đúng đường mà `HttpKVStore` gọi (`src/kv/http.ts:306,351,357,364`).

**Phục vụ:** E8, E11

- [ ] **Step 1: Viết bài kiểm đỏ**

```ts
// packages/@openmaic/storage/test/kv-http-handler.test.ts
import { describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createKVHttpHandler } from '../src/server/kv.js';
import { PgKVStore, ensureKVSchema } from '../src/kv/pg.js';
import type { Queryable } from '../src/runtime/pg.js';
import { callHandler } from './http-harness.js'; // khuôn đã có, dùng như các bài kiểm handler khác

async function harness(owner: string) {
  const db = new PGlite();
  await db.transaction((tx: Queryable) => ensureKVSchema(tx));
  const store = new PgKVStore({ withTransaction: (b) => db.transaction((tx: Queryable) => b(tx)) });
  return createKVHttpHandler(store, { authenticate: async () => ({ owner }) });
}

describe('kv http handler', () => {
  test('round-trips one account entry', async () => {
    const h = await harness('owner-1');
    expect((await callHandler(h, 'PUT', '/kv/entries/settings', { value: { voice: 'a' } })).status).toBe(204);
    const got = await callHandler(h, 'GET', '/kv/entries/settings');
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ value: { voice: 'a' } });
  });

  test('a device-scope request is refused at the ingress', async () => {
    const h = await harness('owner-1');
    const res = await callHandler(h, 'PUT', '/kv/entries/settings?scope=device', { value: 1 });
    expect(res.status).toBe(400);
  });

  test('account partition never leaks across owners', async () => {
    const a = await harness('owner-1');
    await callHandler(a, 'PUT', '/kv/entries/settings', { value: { voice: 'a' } });
    const b = await harness('owner-2');
    expect((await callHandler(b, 'GET', '/kv/entries/settings')).status).toBe(404);
  });

  test('an unauthenticated request never reaches the store', async () => {
    const db = new PGlite();
    await db.transaction((tx: Queryable) => ensureKVSchema(tx));
    const store = new PgKVStore({ withTransaction: (b) => db.transaction((tx: Queryable) => b(tx)) });
    const h = createKVHttpHandler(store, { authenticate: async () => undefined });
    expect((await callHandler(h, 'GET', '/kv/entries/settings')).status).toBe(401);
  });
});
```

Nếu `test/http-harness.js` chưa tồn tại trong gói: đọc bài kiểm handler đã có gần nhất (`test/runtime-reference-server.test.ts`) và dùng đúng khuôn gọi handler của nó thay cho `callHandler`, không tự dựng khuôn mới.

- [ ] **Step 2: Chạy để xác nhận ĐỎ**

Run: `pnpm --filter @openmaic/storage test -- kv-http-handler`
Expected: FAIL — không tìm thấy `../src/server/kv.js`

- [ ] **Step 3: Viết bộ xử lý**

Theo đúng khuôn `src/server/document.ts`: ném khi thiếu `authenticate`, đọc thân có trần byte, trả 401 khi `authenticate` trả `undefined`, 400 khi `scope` khác `account`, 404 khi đọc khoá không có, 204 cho ghi và xoá. Giải mã đoạn khoá bằng cùng phép giải của `src/kv/http.ts` (xem `encodeKeyPathSegment` ở đó) để `.` và `..` không thành đường đi lên.

- [ ] **Step 4: Chạy để xác nhận XANH**

Run: `pnpm --filter @openmaic/storage test -- kv-http-handler`
Expected: PASS, 4 bài.

- [ ] **Step 5: Nối vào bộ điều phối**

Trong `src/server/index.ts`, thêm một nhánh TRƯỚC nhánh `runtime` mặc định, cùng khuôn với `/documents` và `/assets`:
```ts
} else if (kv !== undefined && (pathname === '/kv' || pathname.startsWith('/kv/'))) {
  kv(req, res);
}
```
và dựng `kv` ở đầu hàm khi `options.kvStore !== undefined`.

- [ ] **Step 6: Lượt phá-thử**

Bản sao: bỏ vế `scope` kiểm ở cổng vào → bài kiểm «device-scope refused» phải ĐỎ với chuỗi ghim của nó. Bỏ bản sao.

- [ ] **Step 7: Commit**

```bash
git add packages/@openmaic/storage/src/server/kv.ts packages/@openmaic/storage/src/server/index.ts packages/@openmaic/storage/test/kv-http-handler.test.ts
git commit -m "feat(storage): expose the account KV scope over HTTP"
```

---

### Task 3: App dựng kho chạy qua mạng khi lưu trữ máy chủ bật

**independent: false** — cần đường `/kv` từ Task 2.

**Files:**
- Modify: `lib/store/kv-persist.ts` (chỗ `defaultKv` được dựng)
- Modify: `app/api/persistence/[...path]/route.ts` (truyền `kvStore` vào `createStorageHttpHandler`)
- Test: `tests/store/kv-persist-http.test.ts`

**Interfaces:**
- Consumes: `HttpKVStore`, `BrowserKVStore` từ `@openmaic/storage`; `isBrowserPersistenceEnabled()`, `getPersistenceRequestHeaders()` từ `lib/persistence/bootstrap`
- Produces: `createKVPersistStorage(scope, options)` giữ NGUYÊN chữ ký hiện tại — mọi chỗ gọi không phải sửa.

**Phục vụ:** E1, E2, E9, E10

- [ ] **Step 1: Viết bài kiểm đỏ — ba mệnh đề**

```ts
// tests/store/kv-persist-http.test.ts
import { describe, expect, test, vi } from 'vitest';

describe('kv persist wiring', () => {
  test('a local-only deployment never reaches the network', async () => {
    vi.doMock('@/lib/persistence/bootstrap', () => ({
      isBrowserPersistenceEnabled: () => false,
      getPersistenceRequestHeaders: async () => ({}),
    }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { createKVPersistStorage } = await import('@/lib/store/kv-persist');
    const storage = createKVPersistStorage('account', {});
    await storage.setItem('settings-storage', { state: { a: 1 }, version: 4 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('account writes reach the server store when persistence is on', async () => {
    vi.doMock('@/lib/persistence/bootstrap', () => ({
      isBrowserPersistenceEnabled: () => true,
      getPersistenceRequestHeaders: async () => ({ 'x-learner-key': 'k' }),
    }));
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      return new Response(null, { status: 204 });
    });
    const { createKVPersistStorage } = await import('@/lib/store/kv-persist');
    const storage = createKVPersistStorage('account', {});
    await storage.setItem('settings-storage', { state: { a: 1 }, version: 4 });
    expect(calls).toContainEqual({
      url: '/api/persistence/kv/entries/settings-storage',
      method: 'PUT',
    });
  });

  test('a failed read is never read as absence', async () => {
    vi.doMock('@/lib/persistence/bootstrap', () => ({
      isBrowserPersistenceEnabled: () => true,
      getPersistenceRequestHeaders: async () => ({}),
    }));
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down');
    });
    const { createKVPersistStorage } = await import('@/lib/store/kv-persist');
    const storage = createKVPersistStorage('account', {});
    const got = await storage.getItem('settings-storage');
    // a failed read was read as absence
    expect(got).not.toBeNull();
  });
});
```

- [ ] **Step 2: Chạy để xác nhận ĐỎ** — Run: `pnpm test -- kv-persist-http`
- [ ] **Step 3: Dựng `HttpKVStore` khi bật**

Trong `lib/store/kv-persist.ts`, chỗ `defaultKv ??= new BrowserKVStore()`: khi `isBrowserPersistenceEnabled()` thì dựng
```ts
new HttpKVStore({
  baseUrl: '/api/persistence',
  deviceStore: new BrowserKVStore(),
  headers: () => getPersistenceRequestHeaders(),
  credentials: 'include',
})
```
Máy trạng thái sẵn có của file GIỮ NGUYÊN — không nới một dòng nào; nó chính là thứ bảo đảm AC-10.

- [ ] **Step 4: Chạy để xác nhận XANH** — Run: `pnpm test -- kv-persist-http`
- [ ] **Step 5: Lượt phá-thử** — bản sao: cho `defaultKv` luôn dựng `HttpKVStore` bất kể cờ → bài «local-only» phải ĐỎ với chuỗi `local-only deployment reached the network`.
- [ ] **Step 6: Commit**

```bash
git add lib/store/kv-persist.ts app/api/persistence tests/store/kv-persist-http.test.ts
git commit -m "feat(settings): keep account-scoped choices on the server store"
```

---

### Task 4: Mã nhận — sinh và đổi

**independent: true** (không phụ thuộc Task 1-3; chạy song song được)

**Files:**
- Create: `lib/persistence/claim-code.ts`
- Create: `app/api/claim/route.ts`, `app/api/claim/redeem/route.ts`
- Test: `tests/persistence/claim-code.test.ts`, `tests/api/claim.test.ts`

**Interfaces:**
- Consumes: `resolveRequestOwnerId(req, responseHeaders, authenticatedOwnerId?)` từ `lib/server/agent-runtime/owner` — lối mã nhận truyền chủ sở hữu đã nhận vào tham số thứ ba.
- Produces:
  ```ts
  export const CLAIM_TTL_MS = 10 * 60 * 1000; // AC-3: trần đã ký
  export declare function mintClaimCode(owner: string, now?: number): Promise<{ code: string; expiresAt: number }>;
  export declare function redeemClaimCode(code: string, now?: number): Promise<{ owner: string } | undefined>;
  /** Chỉ cho bài kiểm soi bản lưu; KHÔNG xuất ra đường HTTP nào. */
  export declare function dumpClaimStore(): ReadonlyArray<{ hash: string; owner: string; expiresAt: number; used: boolean }>;
  ```
  `redeemClaimCode` trả `undefined` cho CẢ BA ca hỏng — bên gọi không phân biệt được, đúng AC-5.

**Phục vụ:** E3, E4, E5, E6, E7

- [ ] **Step 1: Viết bài kiểm đỏ — năm mệnh đề**

```ts
// tests/persistence/claim-code.test.ts
import { describe, expect, test } from 'vitest';
import { CLAIM_TTL_MS, mintClaimCode, redeemClaimCode } from '@/lib/persistence/claim-code';

describe('claim code', () => {
  test('TTL ceiling is the signed 10 minutes', () => {
    expect(CLAIM_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000); // claim TTL exceeds the signed ceiling of 10 minutes
  });

  test('is valid before the mark', async () => {
    const { code } = await mintClaimCode('owner-1', 0);
    expect(await redeemClaimCode(code, CLAIM_TTL_MS - 1)).toEqual({ owner: 'owner-1' });
  });

  test('is dead after the mark', async () => {
    const { code } = await mintClaimCode('owner-1', 0);
    expect(await redeemClaimCode(code, CLAIM_TTL_MS + 1)).toBeUndefined();
  });

  test('is redeemable exactly once', async () => {
    const { code } = await mintClaimCode('owner-1', 0);
    expect(await redeemClaimCode(code, 1)).toEqual({ owner: 'owner-1' });
    expect(await redeemClaimCode(code, 2)).toBeUndefined(); // claim code was redeemable twice
  });

  test('never stores the code in the clear', async () => {
    const { code } = await mintClaimCode('owner-1', 0);
    const { dumpClaimStore } = await import('@/lib/persistence/claim-code');
    expect(JSON.stringify(dumpClaimStore())).not.toContain(code);
  });
});
```

- [ ] **Step 2: Chạy để xác nhận ĐỎ** — Run: `pnpm test -- claim-code`
- [ ] **Step 3: Viết `claim-code.ts`** — `randomBytes` cho mã, `createHash('sha256')` cho bản băm, bản đồ trong tiến trình khoá theo băm với `expiresAt` và cờ đã-dùng; `dumpClaimStore()` chỉ để bài kiểm soi, không xuất ra đường HTTP nào.
- [ ] **Step 4: Chạy để xác nhận XANH**
- [ ] **Step 5: Hai đường API + chặn nhịp**

`POST /api/claim` đọc chủ sở hữu hiện tại rồi trả `{ code, expiresAt }`. `POST /api/claim/redeem` gọi `redeemClaimCode`; thành công thì gọi `resolveRequestOwnerId(req, headers, owner)` để cấp lại cookie; hỏng thì trả **một** thân phản hồi duy nhất. Nhịp chặn chép nếp từ `app/api/access-code/verify` — đọc file đó trước, không tự chế nếp mới.

- [ ] **Step 6: Bài kiểm đường API** — ba ca hỏng trả cùng thân và cùng mã trạng thái; vượt nhịp thì bị chặn; đổi thành công thì `Set-Cookie` mang đúng chủ sở hữu của máy A.
- [ ] **Step 7: Lượt phá-thử** — bản sao: cho ca hết hạn trả thông điệp riêng → bài kiểm phải ĐỎ với chuỗi `claim failure modes are distinguishable`.
- [ ] **Step 8: Commit**

```bash
git add lib/persistence/claim-code.ts app/api/claim tests/persistence/claim-code.test.ts tests/api/claim.test.ts
git commit -m "feat(persistence): one-time claim codes for adopting an owner identity"
```

---

### Task 5: Mục «Máy của tôi» trên màn Cài đặt

**independent: false** — cần đường API của Task 4 và lớp lưu của Task 3.

**Files:**
- Create: `components/settings/my-devices-settings.tsx`
- Modify: `components/settings/index.tsx` (danh sách mục ở dòng ~560 và bộ chọn tiêu đề ở ~567)
- Modify: 12 tệp `lib/i18n/locales/*.json` và `lib/i18n/workbench-locales/*.json` nếu chuỗi dùng ở workbench

**Interfaces:**
- Consumes: `POST /api/claim`, `POST /api/claim/redeem` (Task 4); `isBrowserPersistenceEnabled()` để chọn giữa trạng thái tắt và sẵn sàng
- Produces: mục nav mới có khoá `'my-devices'`

**Phục vụ:** E13 (chín khung trạng thái), E14 (sàn thẩm mỹ), E12 (chấm lời hỏi ghi đè)

- [ ] **Step 1: Đọc mục Cài đặt gần nhất về hình dạng** — `components/settings/general-settings.tsx`, chép khuôn bố cục và cách gọi `t()`; KHÔNG dựng lối trình bày mới.
- [ ] **Step 2: Dựng chín trạng thái của bảng trong đặc tả UX** — `ST-maycuatoi-tat`, `-san-sang`, `-co-ma`, `-ma-het-han`, `-dang-nhan`, `-nhan-loi`, `-se-ghi-de`, `-xong`, `-may-chu-im`. Mỗi trạng thái phải tới được bằng thao tác thật để phép đo chụp được.
- [ ] **Step 3: Thêm khoá ngôn ngữ vào cả 12 tệp** — thiếu tệp nào là hỏng một thị trường, không phải một cảnh báo.
- [ ] **Step 4: Chạy sàn thẩm mỹ** — Run: `node scripts/design-gate.mjs` — Expected: exit 0.
- [ ] **Step 5: Commit**

```bash
git add components/settings lib/i18n
git commit -m "feat(settings): add the My devices panel for carrying choices across machines"
```

---

### Task 6: Nạp lại sau khi nhận, và ghi hỏng không được báo là đã lưu

**independent: false** — cần Task 3, 4, 5.

**Files:**
- Modify: `lib/store/kv-persist.ts` (đường báo ghi hỏng ra mặt người)
- Modify: `components/settings/my-devices-settings.tsx` (gọi nạp lại sau khi đổi mã xong)
- Test: `tests/store/kv-persist-write-failure.test.ts`, `tests/store/redeem-rehydrate.test.ts`

**Interfaces:**
- Consumes: `reportPersistHealth` từ `lib/store/persist-health` (đã có); `recovery.rehydrate` mà `lib/store/settings.ts:2024` đã nối sẵn
- Produces: không có API mới — chỉ hành vi.

**Phục vụ:** E15, E16 — hai lỗ do phản biện context sạch tìm ra

- [ ] **Step 1: Viết hai bài kiểm đỏ**

Bài một: đổi mã xong mà không nạp lại → giá trị trong bộ nhớ vẫn là của máy B cũ. Kỳ vọng ĐỎ với chuỗi `redeem left stale in-memory choices`.
Bài hai: lời ghi hỏng → khoá KHÔNG được đánh dấu đã lưu, trạng thái lỗi nổi lên, lần đọc kế tiếp không trả giá trị chưa tới máy chủ. Kỳ vọng ĐỎ với chuỗi `a failed write was reported as saved`.

- [ ] **Step 2: Chạy để xác nhận ĐỎ** — Run: `pnpm test -- redeem-rehydrate kv-persist-write-failure`
- [ ] **Step 3: Nối nạp lại sau khi đổi mã** — sau khi `POST /api/claim/redeem` trả thành công, gọi `rehydrate()` của kho cấu hình TRƯỚC khi hiện trạng thái `-xong`; trạng thái `-xong` không được hiện khi nạp lại chưa xong.
- [ ] **Step 4: Nối đường báo ghi hỏng ra mặt người** — dùng tín hiệu sức khoẻ sẵn có, không thêm cơ chế thứ hai.
- [ ] **Step 5: Chạy để xác nhận XANH**
- [ ] **Step 6: Lượt phá-thử** — bản sao: bỏ lời gọi nạp lại → bài một phải ĐỎ đúng chuỗi ghim.
- [ ] **Step 7: Commit**

```bash
git add lib/store components/settings tests/store
git commit -m "fix(settings): reload choices after a redeem and never report a failed write as saved"
```

---

## Sau khi xong mọi task

Đặt `status: implemented` vào frontmatter `_acceptance/cau-hinh-di-theo-nguoi/contract.md` — đó là hành vi cuối của bên thi công, rồi vòng vào bước nghiệm thu máy.
