## Trong hợp đồng

- **Account KV lands in one shared partition for every owner — AC-11 broken**
  file: `app/api/persistence/[...path]/route.ts:146`
  severity: high
  AC: AC-11
  source: conventions

  The composed handler's `authenticate` has branches for `/documents` (returns `{ learnerKey: ownerId }`) and `/assets`, but the new `/kv` contract has none — it falls through to `authenticatePersistenceRequest(request)`, which returns `{ key: SHARED_ASSET_PRINCIPAL /* 'shared' */, learnerKey: <client-supplied x-learner-key> }` (lib/persistence/server-auth.ts:95). The KV wrapper added in packages/@openmaic/storage/src/server/index.ts:764 resolves the owner as `key ?? learnerKey`, so it picks `'shared'`. Every visitor of the deployment therefore reads and writes the SAME `kv_entries` rows under `owner_id = 'shared'`.

  This breaks three stated invariants at once: contract AC-11 ("hai chủ sở hữu khác nhau... không ai đọc được lựa chọn của người kia"); PgKVStore's own header comment ("Entries are partitioned by owner... one account's values are not reachable from another's"); and lib/persistence/server-provider.ts:26 ("The `account` KV scope — one partition per owner"). It also makes the whole claim-code handshake a no-op for data: `resolveRequestOwnerId`'s adopted owner id never reaches the KV partition key, so AC-7/AC-14 pass only by accident (everyone already shares one partition).

  Nothing catches it: packages/@openmaic/storage/test/kv-http-handler.test.ts drives `createKVHttpHandler` with its own `authenticate`, and tests/persistence/route.test.ts only stubs `@openmaic/storage/kv/pg`, so the route's own `/kv` principal is never exercised.

  Fix shape: add `if (request.url?.startsWith('/kv')) return { learnerKey: ownerId };` before the fallback (and see the separate finding on the `key ?? learnerKey` precedence).

- **KV owner derived from the asset partition key instead of the learner key**
  file: `packages/@openmaic/storage/src/server/index.ts:764`
  severity: medium
  AC: AC-11
  source: conventions

  `const owner = (principal as { key?: string; learnerKey?: string }).key ?? (principal as { learnerKey?: string }).learnerKey;`

  `key` is documented in packages/@openmaic/storage/src/asset/types.ts:40 as the ASSET partition key, and `learnerKey` there is explicitly annotated "Carried so one principal object can serve several layers. Not the partition key." The KV composition picks the asset layer's key first, so any deployment whose authenticator returns a combined principal (which is exactly what this repo's does) silently partitions KV by the asset key rather than by the per-caller identity. The double `as` casts also defeat the type system that would otherwise have flagged the layer mix-up. Preferring `learnerKey`, or better, requiring a dedicated KV principal field, keeps the KV owner from being decided by a field that belongs to another contract.

- **Adoption rehydrates only the settings store, leaving the user-profile store on the old owner**
  file: `components/settings/index.tsx:1122`
  severity: high
  AC: AC-14
  source: conventions

  `onAdopted={() => useSettingsStore.persist.rehydrate()}` rehydrates one store. There are two `account`-scope stores: lib/store/settings.ts:2024 and lib/store/user-profile.ts:54 (`createKVPersistStorage<UserProfileState>('account', ...)`), which the contract names explicitly ("Tập khoá phạm vi `account` = đúng những kho khai 'account'... hôm nay: kho cấu hình và kho hồ sơ người dùng").

  lib/persistence/adopt-choices.ts documents its `rehydrate` dep as "Nạp lại MỌI kho phạm vi account từ ngăn của chủ sở hữu mới" and only returns `adopted` after it resolves — precisely so the screen never says "đã dùng chung" while the product still runs on the old values. The wiring supplies a rehydrate that covers half the account scope, so after a successful redeem the device still shows the previous owner's avatar/nickname/bio (AC-2, AC-14 read "toàn bộ tập khoá", not a subset), and worse: the stale in-memory user-profile state will be written to the ADOPTED owner's partition on the next profile edit, overwriting device A's profile.

  The contract's own note warns against exactly this shape — "Phép đo phải RÚT tập này từ chính khai báo đó; chép tay một danh sách là cách bỏ sót" — and this call site is a hand-written list of one.

- **hasLocalChoices misses custom providers and custom models, so AC-12 can be skipped**
  file: `components/settings/index.tsx:235`
  severity: medium
  AC: AC-12
  source: conventions

  The comment says the flag counts "giọng nhập từ tài khoản, **mô hình tự thêm**, giọng gán cho từng nhân vật dạy, mô hình đã chọn", but the expression counts `agentVoiceOverrides`, `Boolean(selectedModelId)` and `ttsProvidersConfig[*].customVoices` — self-added models live in `providersConfig[id].customModels` (and custom providers), which is never inspected.

  AC-12 requires the product to confirm before replacing a device's own choices. A user who added custom providers/models but has `modelId === ''` (the store's initial value, and what the v0→v1 migration deliberately writes back at lib/store/settings.ts:944 and the migrate branch) gets `hasLocalChoices === false`, so `onSubmit` skips the `confirming` state and overwrites their configuration with no warning — losing exactly the data the contract's Context names as the point of the feature.

- **Claim code is uppercased on the client but minted as lowercase hex — no real redemption can ever succeed**
  file: `lib/persistence/adopt-choices.ts:24`
  severity: high
  AC: AC-7
  source: bugs

  `normalizeClaimCode` does `raw.replace(/[\s-]/g, '').toUpperCase()`, and both `MyDevicesSettings.onSubmit` and `adoptChoicesFromCode` run it before POSTing. But `mintClaimCode` produces `randomBytes(16).toString('hex')` — lowercase — and the UI renders that string verbatim in the `<code>` block. The server hashes the submitted string byte-for-byte (`hashCode(code)` in lib/persistence/claim-code.ts:50), with no case folding anywhere on the route or in `redeemClaimCode`.

  Failure scenario: device A presses "Get a code" and sees e.g. `9f3a...`; the user types or pastes it on device B; the client sends `9F3A...`; SHA-256 does not match any stored digest; `redeemClaimCode` returns undefined; the route answers 401 and the panel shows "That code cannot be used." The feature's only happy path is dead 100% of the time.

  Verified empirically: `redeemClaimCode(normalizeClaimCode(code))` on a freshly minted code returns `undefined`. No test covers this seam — tests/api/claim.test.ts posts the raw code and never calls the normalizer, and tests/persistence/adopt-choices.test.ts mocks fetch so any string "succeeds".

  Fix either by dropping `.toUpperCase()` or by folding case on both mint display and server lookup — one of the two, not both.

- **Every owner's account KV lands in one shared partition: the /kv route never gets the owner id**
  file: `app/api/persistence/[...path]/route.ts:146`
  severity: high
  AC: AC-11
  source: bugs

  `createPersistenceHandler` now passes `kvStore`, but its `authenticate` callback only special-cases `/documents` and `/assets`:

  ```ts
  authenticate: async (request) => {
    if (request.url?.startsWith('/documents')) return { learnerKey: ownerId };
    if (request.url?.startsWith('/assets')) return { key: SHARED_ASSET_PRINCIPAL, learnerKey: ownerId };
    return authenticatePersistenceRequest(request);
  }
  ```

  A `/kv/...` request falls to `authenticatePersistenceRequest`, which returns `{ key: SHARED_ASSET_PRINCIPAL, ...(learnerKey ? { learnerKey } : {}) }` (lib/persistence/server-auth.ts:96). The KV wrapper in packages/@openmaic/storage/src/server/index.ts:764 then resolves the partition as `principal.key ?? principal.learnerKey` — so `owner` is the literal string `'shared'` for every caller.

  Failure scenario: two different browsers (different `anonymous_id` cookies, no claim code exchanged) both PUT `/api/persistence/kv/entries/settings-storage`. Both rows are written to `kv_entries` with `owner_id = 'shared'`, so the second overwrites the first and either device reads the other's API keys, voice overrides and profile. Conversely, redeeming a claim code changes nothing observable, because the partition never depended on the owner in the first place — which makes the whole feature's acceptance claim ("one partition per owner") false while the code path looks like it works.

  The route resolves `ownerId` via `withRequestOwnerId` and already has it in scope; it is simply never handed to the KV branch. Nothing tests this: tests/persistence/route.test.ts stubs `PgKVStore` as an empty class, and packages/@openmaic/storage/test/kv-http-handler.test.ts supplies its own authenticator.

- **Adopting another machine's choices rehydrates only the settings store, leaving the account-scoped user profile stale**
  file: `components/settings/index.tsx:1122`
  severity: medium
  AC: AC-14
  source: bugs

  `<MyDevicesSettings onAdopted={() => useSettingsStore.persist.rehydrate()} />` passes a single-store rehydrate, but two stores are persisted at `'account'` scope: `useSettingsStore` (lib/store/settings.ts:2024) and `useUserProfileStore` (lib/store/user-profile.ts:54). `adopt-choices.ts` documents its contract as "Nạp lại mọi kho phạm vi account" and deliberately blocks on it so `adopted` is only reported once reload is complete.

  Failure scenario: device B redeems a code. The cookie now points at device A's owner. Settings (models, voices, API keys) refresh; avatar, nickname and bio stay device B's, and the panel says "This machine now shares your choices." — the exact half-truth the rehydrate-before-report ordering exists to prevent. The stale profile then gets written back to A's partition on the next profile edit, overwriting A's values.

  The outcome is also reported `adopted` rather than `unreachable` if the profile store would have failed, because the profile store is never touched.

## Ngoài hợp đồng — người quyết ở Gate 2

Các lỗi dưới đây nằm ngoài phạm vi đã duyệt ở Cổng Phạm vi và CHƯA qua bác bỏ đối kháng — người quyết, máy không sửa và không chấm thứ máy không được sửa.

- **@openmaic/storage publishable inputs changed without a version bump**
  Người dùng thấy gì: Gói lưu trữ có thay đổi bên trong nhưng số phiên bản chưa tăng theo, có thể khiến quy trình phát hành tự động từ chối bản cập nhật này.
  file: `packages/@openmaic/storage/package.json`
  severity: high
  Đề xuất: known-limits

- **Claim-code minting has no attempt limiter, so a flood can evict live codes**
  Người dùng thấy gì: Nếu có người gửi liên tục hàng loạt yêu cầu xin mã, mã hợp lệ mà người dùng khác vừa xin có thể bị loại bỏ sớm khiến họ không dùng được mã của chính mình.
  file: `app/api/claim/route.ts`
  severity: medium
  Đề xuất: known-limits

- **Account KV 401s on every request unless NEXT_PUBLIC_PERSISTENCE_TOKEN is set, while documents work without it**
  Người dùng thấy gì: Nếu người quản trị bật lưu trữ phía máy chủ nhưng bỏ sót một bước cấu hình, toàn bộ việc lưu lựa chọn theo tài khoản sẽ âm thầm ngừng hoạt động mà không có cảnh báo rõ ràng cho ai.
  file: `app/api/persistence/[...path]/route.ts`
  severity: medium
  Đề xuất: known-limits

- **Design gate reports PASS when the per-file scan could not run at all**
  Người dùng thấy gì: Công cụ tự kiểm tra giao diện có thể báo 'đạt' ngay cả khi phép kiểm tra không chạy được, khiến người quyết định đọc nhầm một kết quả không có thật.
  file: `scripts/design-gate-changed.mjs`
  severity: medium
  Đề xuất: known-limits

- **Design gate feeds .tsx source to a detector that expects a rendered surface, so its P0 rules can never fire**
  Người dùng thấy gì: Công cụ tự kiểm tra giao diện đang soi nhầm mã nguồn thay vì màn hình đã hiển thị, nên gần như không thể bắt được lỗi hình ảnh thật nào.
  file: `scripts/design-gate-changed.mjs`
  severity: medium
  Đề xuất: known-limits

- **A stored JSON null is indistinguishable from a missing KV entry and comes back as 404**
  Người dùng thấy gì: Nếu một lựa chọn được lưu với giá trị đặc biệt là 'rỗng', hệ thống có thể báo lựa chọn đó không tồn tại dù thực ra đã lưu thành công.
  file: `packages/@openmaic/storage/src/server/kv.ts`
  severity: low
  Đề xuất: known-limits

- **Shape 6 - hardcoded ROOT: run args measure the author's checkout, not the tree under test**
  Người dùng thấy gì: Kết quả đo nghiệm thu đã ghi lại có thể chỉ đúng trên đúng một máy tính, nên việc kiểm tra lại kết quả đó trên máy khác có thể thất bại dù tính năng vẫn hoạt động bình thường.
  file: `_acceptance/cau-hinh-di-theo-nguoi/s4-args.json`
  severity: high
  Đề xuất: known-limits

- **Shape 5 - E2 declares a full write-first matrix (P105) but only point cases exist; both pinned messages appear in zero assertions**
  Người dùng thấy gì: Phép đo tự động cho việc mỗi kho lựa chọn phải đi theo người mới chỉ kiểm vài trường hợp lẻ chứ chưa kiểm hết mọi kho hiện có, nên một kho mới thêm sau này có thể bị lỗi mà không ai biết.
  file: `_acceptance/cau-hinh-di-theo-nguoi/evals.yaml`
  severity: high
  Đề xuất: known-limits

- **Shape 3 - E1 promises a value relation (write then read back) but the assert only checks a request record is present**
  Người dùng thấy gì: Phép đo tự động cho việc ghi rồi đọc lại một lựa chọn mới chỉ kiểm tra có gửi yêu cầu đi, chưa kiểm tra giá trị đọc lại có đúng là giá trị vừa ghi hay không.
  file: `tests/store/kv-persist-http.test.ts`
  severity: high
  Đề xuất: known-limits

- **Shape 2 - hand-written fixture on both sides: the adopt round trip never goes through a writer or a reader**
  Người dùng thấy gì: Phép đo tự động cho việc nhận lựa chọn từ máy khác đang so sánh dữ liệu giả với chính nó, nên chưa thực sự kiểm tra được việc nhận dữ liệu có hoạt động thật hay không.
  file: `tests/persistence/adopt-choices.test.ts`
  severity: high
  Đề xuất: known-limits

- **Shape 5 - a loop of three identical inputs presented as 'three failure cases'**
  Người dùng thấy gì: Phép đo tự động tự nhận đã kiểm ba tình huống lỗi khác nhau của mã nhận nhưng thực ra chỉ lặp lại một tình huống ba lần, nên hai tình huống còn lại có thể lỗi mà không bị phát hiện.
  file: `tests/persistence/adopt-choices.test.ts`
  severity: high
  Đề xuất: known-limits

- **Shape 5 - E13 declares the frame list is derived from the UX state table, but it is hand-copied and already disagrees with the steps**
  Người dùng thấy gì: Danh sách các trạng thái cần có ảnh chụp minh chứng được chép tay và đã lệch tên so với ảnh chụp thực tế, nên một trạng thái thiếu ảnh có thể không bị phát hiện.
  file: `_acceptance/cau-hinh-di-theo-nguoi/evals.yaml`
  severity: medium
  Đề xuất: known-limits

- **Shape 4 - negative-only assertion with no positive control that the store holds anything**
  Người dùng thấy gì: Phép đo 'mã không bị lưu lộ' chỉ kiểm tra không thấy mã gốc, chưa kiểm tra chắc chắn có bản ghi mã đã mã hoá được lưu, nên nếu việc lưu trữ hỏng hoàn toàn phép đo vẫn có thể báo đạt.
  file: `tests/persistence/claim-code.test.ts`
  severity: medium
  Đề xuất: known-limits

- **Shape 4 - E10's red direction names a message no assertion carries, and its command runs a suite with no such case**
  Người dùng thấy gì: Tiêu chí về việc đọc lỗi không bị hiểu nhầm thành 'trống' đang dẫn chứng bằng một bộ kiểm không hề chứa tình huống đó, nên tiêu chí này có thể không thực sự được bảo vệ.
  file: `_acceptance/cau-hinh-di-theo-nguoi/evals.yaml`
  severity: medium
  Đề xuất: known-limits

- **Shape 4 - the read-back check is negative-only and passes on an empty read**
  Người dùng thấy gì: Phép đo bảo vệ dữ liệu chưa lưu kịp chỉ kiểm tra giá trị đọc lại không phải giá trị cũ, chưa kiểm tra giá trị đọc lại có đúng và có thật hay không, nên nếu hệ thống lặng lẽ trả về trống thay vì giá trị thật, phép đo vẫn có thể báo đạt.
  file: `tests/store/kv-persist-write-failure.test.ts`
  severity: medium
  Đề xuất: known-limits

⚠ Cụm ngoài vùng phủ: 12/22 lỗi rơi vào file không bộ đo nào phủ (packages/@openmaic/storage/package.json, scripts/design-gate-changed.mjs, _acceptance/cau-hinh-di-theo-nguoi/s4-args.json, _acceptance/cau-hinh-di-theo-nguoi/evals.yaml, tests/store/kv-persist-http.test.ts, tests/persistence/adopt-choices.test.ts, tests/persistence/claim-code.test.ts, tests/store/kv-persist-write-failure.test.ts) — dừng và quyết: mở rộng hợp đồng hay rút phạm vi.