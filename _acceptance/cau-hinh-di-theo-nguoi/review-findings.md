## Trong hợp đồng

- **The "adopted" proof is decoupled from the reads it claims to prove**
  file: `lib/store/account-stores.ts:46`
  severity: high
  AC: AC-14
  source: conventions
  `reloadAccountStoresAndConfirm` awaits every store's `persist.rehydrate()`, then issues a SEPARATE probe (`getAccountKv().keys('', 'account')`) and treats its success as proof that the adopted owner's partition was read. The two are different HTTP requests, so the probe proves nothing about the rehydrate reads.

  The seam makes this concrete: in `lib/store/kv-persist.ts` `getItem`'s `load()`, a failed backend read is fed to the state machine and the key is deliberately left unsettled — "the store keeps whatever it holds" — and `rehydrate()` still resolves cleanly. So if the `GET /api/persistence/kv/entries/settings-storage` issued by rehydrate fails (500, transient network blip, backend restart) and the `GET /api/persistence/kv/keys` issued a moment later succeeds, `reloadAccountStoresAndConfirm` returns normally, `adoptChoicesFromCode` returns `'adopted'`, and `my-devices-settings.tsx` renders `ST-maycuatoi-xong` — while the store still holds the OLD device's values. The next settings edit then writes those old values into the adopted owner's partition, which is exactly the data-loss the module header says this shape exists to prevent ("vòng thứ hai tìm ra «nhận xong báo thành công trong khi có thể không nạp lại được gì cả»").

  `tests/store/adoption-proof.test.ts` only covers the case where the network is down for BOTH calls, so the mixed outcome is unguarded. The honest signal is already available inside the seam (the `KeyState` phase / `reportPersistHealth` channel): the proof needs to come from the same read the rehydrate performed, not from a later independent one.

  Chứng minh bằng vitest cho thấy sau khi adoptChoicesFromCode báo 'adopted', máy B vẫn giữ giá trị cũ thay vì giá trị máy A đã ghi — đúng điều AC-14 cấm.

- **The overwrite confirmation ignores the user-profile store, which adoption also replaces**
  file: `lib/store/local-choices.ts:30`
  severity: high
  AC: AC-12
  source: conventions
  `ACCOUNT_SCOPE_STORES` (lib/store/account-stores.ts:26) declares two account-scoped stores — `settings` and `userProfile` — and both are rehydrated from the adopted owner's partition. But `hasLocalChoices` only inspects the settings store's state: `agentVoiceOverrides` plus anything matching `/providersconfig$/i`. `components/settings/index.tsx:233` feeds it only `useSettingsStore` state as well.

  `lib/store/user-profile.ts` persists `avatar`, `nickname` and `bio` under `createKVPersistStorage('account', …)` — unambiguously human-authored data that adoption overwrites. A user who has set a nickname, bio or a custom uploaded avatar but has not entered any provider API key or voice override gets `hasLocalChoices === false`, so `onSubmit` in `my-devices-settings.tsx:124` skips `ST-maycuatoi-se-ghi-de` entirely and silently replaces their profile with the other machine's.

  The file's own header frames the fix for round one as "quét chính trạng thái đã lưu" instead of hand-counting — but the scan is still scoped to one of the two stores that adoption touches, so the same class of omission survives in the other store.

  Người có nickname/avatar/bio tự đặt nhưng chưa cấu hình provider sẽ không được hỏi xác nhận trước khi bị ghi đè, trái với yêu cầu bắt buộc hỏi trước của AC-12.

- **hasLocalChoices misses AliDocMind credentials, so they are overwritten without confirmation**
  file: `lib/store/local-choices.ts:17`
  severity: high
  AC: AC-12
  source: bugs
  HUMAN_MARKS is ['apiKey', 'baseUrl', 'customModels', 'customVoices']. The AliDocMind PDF provider does not use any of them: its default entry is `alidocmind: { apiKey: '', baseUrl: '', enabled: false, accessKeyId: '', accessKeySecret: '' }` (lib/store/settings.ts:573) and the settings UI writes only `accessKeyId` / `accessKeySecret` (components/settings/pdf-settings.tsx:180-183), leaving apiKey and baseUrl empty.

  Verified under vitest: with `pdfProvidersConfig.alidocmind.accessKeyId = 'AKID'` and `.accessKeySecret = 'SECRET'` set (and the default web-search baseUrls cleared so they do not mask the result), `hasLocalChoices` returns `false`.

  So a device whose only configured credential is AliDocMind is classified as having nothing to lose: `MyDevicesSettings.onSubmit` skips the `ST-maycuatoi-se-ghi-de` confirmation and calls `submitCode` directly, and the adoption replaces those keys silently. This is the same failure the module docstring says it set out to close ('nó bỏ sót khoá API ... nên người chỉ cấu hình khoá ảnh sẽ bị thay KHÔNG HỎI'); the shape-based scan closed it for tables but not for credential field names.

  Chứng minh bằng vitest cho thấy khi chỉ có khoá AliDocMind, hasLocalChoices trả về false nên xác nhận bị bỏ qua, trái với yêu cầu bắt buộc hỏi trước của AC-12.

- **Adoption reports success when the stores' reads failed: the proof is a separate request from the hydration**
  file: `lib/store/account-stores.ts:47`
  severity: high
  AC: AC-14
  source: bugs
  `reloadAccountStoresAndConfirm` awaits `store.persist.rehydrate()` for both account stores and then proves reachability with a separate `kv.keys('', 'account')` call. But `persist.rehydrate()` cannot fail: the seam deliberately turns a failed read into `null` (lib/store/kv-persist.ts:694-702, 'A failed read has already been recorded ... Leave the key unsettled — the store keeps whatever it holds'), and zustand's hydrate with a null value merges nothing and resolves. So the `Promise.all` result carries no information about whether the adopted owner's partition was actually read. The follow-up `keys()` is a different HTTP request against a different route and can succeed while every entry read failed.

  Verified under vitest with a fetch stub where `GET /kv/entries/*` returns 500 INTERNAL_ERROR and `GET /kv/keys` returns 200 `[]`: `reloadAccountStoresAndConfirm()` resolves without throwing, while `useSettingsStore.getState().modelId` still holds the value set before the call. `adoptChoicesFromCode` then returns 'adopted' and MyDevicesSettings renders `ST-maycuatoi-xong` / 'đã dùng chung' while the product is still running on the previous owner's choices — the same class of bug the file's docstring and commit message claim to have closed.

  tests/store/adoption-proof.test.ts covers only all-fetch-fails and keys-fails; the entry-read-fails-while-keys-succeeds case is the hole. A proof has to come from the hydration itself (e.g. have the seam report whether each key's read reached the backend), not from a later independent probe.

  Cùng lớp lỗi với t1: chứng minh bằng vitest cho thấy reloadAccountStoresAndConfirm() báo thành công dù lời đọc account thất bại, nên giá trị đọc lại không đúng giá trị máy A đã ghi — trái AC-14.

## Ngoài hợp đồng — người quyết ở Gate 2

Các lỗi dưới đây nằm ngoài phạm vi đã duyệt ở Cổng Phạm vi và CHƯA qua bác bỏ đối kháng — người quyết, máy không sửa và không chấm thứ máy không được sửa.

- **Claim redemption installs an identity cookie with no cross-site request check**
    Người dùng thấy gì: Một trang web độc hại có thể âm thầm khiến trình duyệt của bạn tự "nhận" mã của kẻ xấu, khiến cài đặt và khoá API riêng tư của bạn bị chuyển sang tài khoản của kẻ đó mà bạn không hề hay biết.
    file: `app/api/claim/redeem/route.ts`
    severity: high
    Đề xuất: new-contract

- **Claim codes live in per-process memory, so they are unredeemable on any multi-instance deployment**
    Người dùng thấy gì: Nếu sản phẩm được chạy trên nhiều máy chủ cùng lúc, việc nhận mã ở máy thứ hai có thể luôn báo 'mã không dùng được' dù mã hoàn toàn đúng, mà người dùng không có cách nào biết tại sao.
    file: `lib/persistence/claim-code.ts`
    severity: medium
    Đề xuất: known-limits

- **Minting is unauthenticated and unthrottled while redeeming is throttled**
    Người dùng thấy gì: Ai đó bấm liên tục nút lấy mã có thể đẩy mã hợp lệ của người khác ra khỏi hàng đợi, khiến mã đó bỗng dưng không dùng được nữa ngay trước khi họ kịp nhập.
    file: `app/api/claim/route.ts`
    severity: medium
    Đề xuất: new-contract

- **adopt-choices.ts is not Prettier-formatted, so `pnpm format` / CI will flag it**
    Người dùng thấy gì: Không ảnh hưởng đến người dùng cuối — đây chỉ là quy ước trình bày mã nguồn giữa các lập trình viên.
    file: `lib/persistence/adopt-choices.ts`
    severity: medium
    Đề xuất: known-limits

- **New export splits a JSDoc block from the function it documents**
    Người dùng thấy gì: Không ảnh hưởng đến người dùng cuối — đây chỉ gây khó cho lập trình viên khi đọc tài liệu nội bộ về sau.
    file: `lib/store/kv-persist.ts`
    severity: low
    Đề xuất: known-limits

- **hasLocalChoices fires on a pristine machine: default web-search baseUrl counts as a human choice**
    Người dùng thấy gì: Máy hoàn toàn mới, chưa ai chỉnh gì, vẫn bị hỏi 'lựa chọn trên máy này sẽ bị ghi đè' mỗi lần nhập mã nhận — gây khó chịu vì thực ra chẳng có gì để mất.
    file: `lib/store/local-choices.ts`
    severity: high
    Đề xuất: known-limits

- **adopt-choices collapses rate-limit and server-error responses into 'invalid code'**
    Người dùng thấy gì: Khi máy chủ đang quá tải hay gặp sự cố tạm thời, người dùng thấy đúng thông báo 'mã sai' như khi họ gõ nhầm, nên họ cứ thử lại vô ích thay vì biết cần đợi hoặc thử lại sau.
    file: `lib/persistence/adopt-choices.ts`
    severity: medium
    Đề xuất: known-limits

- **Đo CHỈ DẪN thay vì ĐẦU RA — lời hứa "mọi kho account đều được nạp lại" chấm bằng grep mã nguồn**
    Người dùng thấy gì: Nếu sau này có người thêm một mục cài đặt mới mà quên nối nó vào luồng đồng bộ theo người, hệ thống kiểm tra tự động hiện tại có thể không phát hiện ra, và người dùng sẽ lại thấy mục đó bị bỏ trống trên máy thứ hai.
    file: `tests/persistence/account-scope-wiring.test.ts`
    severity: high
    Đề xuất: known-limits

- **Tuyên quét LỚP nhưng chỉ có MỘT điểm-case lặp ba lần**
    Người dùng thấy gì: Bài kiểm tra tự nhận đã thử đủ các kiểu sự cố máy chủ nhưng thực chất chỉ thử một kiểu lặp lại ba lần, nên nếu sản phẩm phản hồi sai với một lỗi mạng hay quá tải thật, sẽ không ai phát hiện trước khi người dùng gặp phải.
    file: `tests/persistence/adopt-choices.test.ts`
    severity: medium
    Đề xuất: known-limits

- **Tuyên quét LỚP ("BẤT KỲ bảng nhà cung cấp nào") bằng danh sách 7 tên chép tay**
    Người dùng thấy gì: Bài kiểm tra tự nhận đã quét mọi bảng nhà cung cấp nhưng thực chất chỉ liệt kê tay bảy cái tên có sẵn, nên nếu thêm một nhà cung cấp mới mà việc bảo vệ dữ liệu người dùng bị hỏng, sẽ không ai phát hiện.
    file: `tests/store/adoption-proof.test.ts`
    severity: medium
    Đề xuất: known-limits

- **Assertion âm-tính-một-mình, rỗng theo xây dựng — không có đối chứng dương cho đường đọc-lại**
    Người dùng thấy gì: Bài kiểm tra chỉ đúng một cách hiển nhiên trong đúng kịch bản mọi yêu cầu đều thất bại, nên nếu tính năng đọc-lại-giá-trị-đã-lưu bị hỏng thật, bài vẫn báo xanh và không ai biết dữ liệu người dùng có được đọc đúng hay không.
    file: `tests/store/kv-persist-write-failure.test.ts`
    severity: medium
    Đề xuất: known-limits

- **Assertion âm-tính-một-mình: not.toContain trên một kho chưa được chứng là có dữ liệu**
    Người dùng thấy gì: Bài kiểm tra 'không lưu mã ở dạng rõ' không thực sự chứng minh có gì được lưu, nên nếu tính năng vô tình không lưu gì cả, bài vẫn báo xanh trong khi đúng ra không lộ mã chỉ vì không hoạt động.
    file: `tests/persistence/claim-code.test.ts`
    severity: low
    Đề xuất: known-limits

- **Assertion âm-tính-một-mình: kênh rò rỉ không có đối chứng dương, trạng thái không ghim**
    Người dùng thấy gì: Bài kiểm tra 'không rò rỉ danh tính' không xác nhận đây đúng là tình huống bị từ chối, nên nếu máy chủ trả lỗi theo cách khác trong tương lai, bài vẫn báo xanh dù danh tính người dùng có thể đã bị lộ ra ngoài.
    file: `tests/api/claim.test.ts`
    severity: low
    Đề xuất: known-limits

⚠ Cụm ngoài vùng phủ: 9/17 lỗi rơi vào file không bộ đo nào phủ (lib/store/local-choices.ts, tests/persistence/account-scope-wiring.test.ts, tests/persistence/adopt-choices.test.ts, tests/store/adoption-proof.test.ts, tests/store/kv-persist-write-failure.test.ts, tests/persistence/claim-code.test.ts, tests/api/claim.test.ts) — dừng và quyết: mở rộng hợp đồng hay rút phạm vi.
