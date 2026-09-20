## Trong hợp đồng

- **Adoption reports success even when no account store was actually reloaded**
  file: `lib/store/account-stores.ts:29`
  severity: high
  AC: AC-14
  source: bugs

  `rehydrateAccountStores` relies on `store.persist.rehydrate()` rejecting when the reload fails, and `adoptChoicesFromCode` (lib/persistence/adopt-choices.ts:52) only returns 'adopted' after it resolves — the whole point being 'never say đã dùng chung while the product still runs on the old values'. But the KV persist seam never rejects on a backend failure: `Outcome.run` captures the throw (lib/store/kv-persist.ts:78-84) and `getItem` returns `null` at lib/store/kv-persist.ts:688. Verified empirically: `createKVPersistStorage('account', { kv })` with a `kv.get` that throws resolves `getItem(...)` to `null`, it does not reject. Zustand's `hydrate` with a null value merges `undefined` over the current state, so `rehydrate()` resolves and the store keeps device B's old in-memory values.

  Failure scenario: device B redeems a valid code while the KV backend is down (or /api/persistence returns 500). `/api/claim/redeem` succeeds and sets the cookie to owner A. `rehydrate()` resolves without reading anything; `Promise.allSettled` sees two fulfilled results; `adoptChoicesFromCode` returns 'adopted'; the panel renders ST-maycuatoi-xong. The settings and user-profile stores still hold device B's values, and the next settings edit writes them into owner A's partition, overwriting A's configuration — exactly the overwrite hazard the module header of account-stores.ts says it exists to prevent. The `throw` at lines 32-36 can only fire for a rehydrate that rejects, which this seam is built never to do.

- **hasLocalChoices never looks at API keys, so a device can be overwritten without the AC-12 confirmation**
  file: `components/settings/index.tsx:236`
  severity: medium
  AC: AC-12
  source: bugs

  `hasLocalChoices` counts `agentVoiceOverrides`, `Boolean(selectedModelId)`, and `customVoices`/`customModels` across `providersConfig`, `ttsProvidersConfig`, `asrProvidersConfig`. It never inspects `apiKey`/`baseUrl` on any table, and it ignores `imageProvidersConfig`, `videoProvidersConfig`, `pdfProvidersConfig` and `webSearchProvidersConfig` entirely — all of which carry `customModels` (lib/store/settings.ts:195, 212, 380, 394) and credentials.

  Failure scenario: a user configures only media providers — e.g. an image-generation API key and a TTS key — and never selects an LLM. `resolveLLMSelection` only fills `modelId` when an *LLM* provider is usable (lib/store/settings.ts:459-462), so `modelId` stays `''` (the initial value at line 944, and what the migration writes back at line 2041). `hasLocalChoices` is false, `onSubmit` skips the `confirming` state, and redeeming a code replaces those keys with no warning at all. The reverse also holds: on any deployment with a usable LLM provider, auto-config sets `modelId` without the user choosing anything, so `Boolean(selectedModelId)` is true on a brand-new device — contradicting the comment's "Mặc định của lần chạy đầu không tính là lựa chọn" and making the confirmation fire when there is nothing to lose.

## Ngoài hợp đồng — người quyết ở Gate 2

Các lỗi dưới đây nằm ngoài phạm vi đã duyệt ở Cổng Phạm vi và CHƯA qua bác bỏ đối kháng — người quyết, máy không sửa và không chấm thứ máy không được sửa.

- **Account scope now ships user API keys to the server KV table in plaintext**
  Người dùng thấy gì: Việc đồng bộ cấu hình giữa các máy hiện có thể gửi luôn khoá API bí mật của người dùng lên máy chủ dùng chung thay vì chỉ giữ trên máy của họ — nếu máy chủ bị lộ, các khoá đó có thể bị rò rỉ theo.
  file: `lib/store/kv-persist.ts`
  severity: high
  Đề xuất: new-contract

- **@openmaic/storage source changed without the CI-required version bump**
  Người dùng thấy gì: Người dùng gói phần mềm nội bộ này ở nơi khác có thể không biết đã có thay đổi mới vì số phiên bản không được cập nhật, dễ gây nhầm lẫn khi nâng cấp.
  file: `packages/@openmaic/storage/package.json`
  severity: high
  Đề xuất: known-limits

- **Rehydrate dependency is mandatory in the module, optional at the call boundary**
  Người dùng thấy gì: Nếu một phần khác của sản phẩm sau này quên nối đúng bước làm mới dữ liệu, người dùng có thể thấy thông báo đã xong trong khi máy vẫn dùng cấu hình cũ, và lần sửa tiếp theo sẽ ghi đè lên cấu hình đúng của người kia.
  file: `components/settings/my-devices-settings.tsx`
  severity: medium
  Đề xuất: known-limits

- **A stored JSON null is reported as KEY_NOT_FOUND while /kv/keys still lists it**
  Người dùng thấy gì: Nếu một lựa chọn từng được lưu là giá trị rỗng có chủ đích, sản phẩm có thể báo nhầm là chưa từng có lựa chọn đó, dù danh sách các lựa chọn vẫn liệt kê nó.
  file: `packages/@openmaic/storage/src/server/kv.ts`
  severity: low
  Đề xuất: known-limits

- **Dead imports left in bootstrap.ts after the move to enabled.ts**
  Người dùng thấy gì: Không có ảnh hưởng nhận thấy được tới người dùng; đây thuần tuý là mã thừa chưa dọn.
  file: `lib/persistence/bootstrap.ts`
  severity: low
  Đề xuất: known-limits

- **Account-store registry guard only scans the top level of lib/store**
  Người dùng thấy gì: Nếu sau này có thêm một nơi lưu lựa chọn cá nhân được đặt ở một thư mục khác, sản phẩm có nguy cơ quên đồng bộ nó sang máy mới mà không có cảnh báo nào.
  file: `tests/persistence/account-scope-wiring.test.ts`
  severity: low
  Đề xuất: known-limits

- **/api/claim/redeem is cross-site forgeable, so a third party can pin a victim onto an attacker's owner partition**
  Người dùng thấy gì: Một trang web độc hại có thể lừa trình duyệt của người dùng tự gửi mã của kẻ tấn công, khiến các lựa chọn và khoá API của người dùng bị chuyển sang ngăn của kẻ tấn công mà họ không hề chủ động nhận mã.
  file: `app/api/claim/redeem/route.ts`
  severity: high
  Đề xuất: new-contract

- **A rate-limited or failing redeem is reported to the user as a bad claim code**
  Người dùng thấy gì: Khi bị tạm khoá do thử sai nhiều lần, người dùng có thể thấy thông báo mã sai dù mã họ gõ đúng, khiến họ tưởng nhầm là cần xin mã mới.
  file: `lib/persistence/adopt-choices.ts`
  severity: medium
  Đề xuất: known-limits

- **A browser clock ahead of the server renders every freshly minted code as already expired**
  Người dùng thấy gì: Nếu đồng hồ trên máy chạy nhanh hơn máy chủ, màn hình lấy mã có thể báo mã đã hết hạn ngay khi vừa lấy, dù mã đó thực ra vẫn dùng được trong mười phút.
  file: `components/settings/my-devices-settings.tsx`
  severity: medium
  Đề xuất: known-limits

- **Deleting or renaming a UI file makes the design gate hard-block instead of scoring the round**
  Người dùng thấy gì: Khi một người xoá hoặc đổi tên một màn hình giao diện trong lúc làm việc khác, hệ thống kiểm tra tự động có thể báo lỗi giả và làm chậm việc phát hành dù không có gì thật sự hỏng.
  file: `scripts/design-gate-changed.mjs`
  severity: medium
  Đề xuất: known-limits

- **Hình dạng 3 + 1: assert CHUỖI CÓ MẶT trong mã nguồn, trong khi lời hứa là quan hệ "mọi kho account đều được nạp lại"**
  Người dùng thấy gì: Nếu sau này ai đó thêm một nơi lưu lựa chọn mới mà quên khai đúng, bài kiểm bảo vệ tính năng này có thể vẫn báo an toàn trong khi máy thứ hai không nhận đủ lựa chọn.
  file: `tests/persistence/account-scope-wiring.test.ts`
  severity: high
  Đề xuất: known-limits

- **Hình dạng 5: tuyên quét LỚP "ba ca hỏng" nhưng ma trận chỉ có một phần tử lặp ba lần**
  Người dùng thấy gì: Nếu sau này sản phẩm vô tình để lộ sự khác nhau giữa mã sai, mã hết hạn và mã đã dùng, bài kiểm hiện tại sẽ không phát hiện ra.
  file: `tests/persistence/adopt-choices.test.ts`
  severity: high
  Đề xuất: known-limits

- **Hình dạng 4: assertion âm-tính-một-mình cho "không lưu mã dạng rõ" — không đối chứng dương**
  Người dùng thấy gì: Nếu tính năng lưu mã bị hỏng hoàn toàn và không ghi lại gì cả, bài kiểm bảo vệ việc không lưu mã dạng đọc được vẫn có thể báo an toàn một cách nhầm lẫn.
  file: `tests/persistence/claim-code.test.ts`
  severity: medium
  Đề xuất: known-limits

- **Hình dạng 2: kỳ vọng lấy từ CHÍNH hàm đang đo — không round-trip hai đầu**
  Người dùng thấy gì: Nếu sau này ô nhập mã và phía máy chủ vô tình chuẩn hoá mã khác nhau, bài kiểm hiện tại sẽ không phát hiện ra sự lệch đó.
  file: `tests/persistence/account-scope-wiring.test.ts`
  severity: medium
  Đề xuất: known-limits

- **Hình dạng 4: so ba hình dạng phản hồi với nhau nhưng không ghim thông điệp/mã trạng thái**
  Người dùng thấy gì: Nếu máy chủ vô tình trả một lỗi chung chung cho mọi trường hợp thay vì thông điệp từ chối đúng, bài kiểm hiện tại vẫn có thể báo an toàn.
  file: `tests/api/claim.test.ts`
  severity: medium
  Đề xuất: known-limits

- **Hình dạng 4: assert âm tính trên giá trị đọc lại, không ghim giá trị đúng phải đọc ra**
  Người dùng thấy gì: Nếu đường đọc lựa chọn sau khi ghi thất bại bị hỏng hoàn toàn, bài kiểm hiện tại vẫn có thể báo mọi thứ bình thường.
  file: `tests/store/kv-persist-write-failure.test.ts`
  severity: low
  Đề xuất: known-limits

⚠ Cụm ngoài vùng phủ: 10/18 lỗi rơi vào file không bộ đo nào phủ (packages/@openmaic/storage/package.json, lib/persistence/bootstrap.ts, tests/persistence/account-scope-wiring.test.ts, scripts/design-gate-changed.mjs, tests/persistence/adopt-choices.test.ts, tests/persistence/claim-code.test.ts, tests/api/claim.test.ts, tests/store/kv-persist-write-failure.test.ts) — dừng và quyết: mở rộng hợp đồng hay rút phạm vi.
