## Trong hợp đồng

- **Bằng chứng «nhận xong» đọc chốt sức khoẻ cũ, không đọc lần nạp vừa xảy ra**
  file: `lib/store/account-stores.ts:85`
  severity: high
  AC: AC-7
  source: conventions
  `reloadAccountStoresAndConfirm` quyết «ngăn của chủ mới đọc được hay không» bằng `isPersistUnavailable(store.persistName)` — một CHỐT đứng (standing latch) trong lib/store/persist-health.ts, chứ không phải kết quả của chính lần đọc vừa chạy. Chốt đó chỉ được gỡ ở nhánh `status === 'recovered'` (persist-health.ts:94). Nhưng trong kv-persist.ts, khi một lần đọc THÀNH CÔNG kết thúc ở nhánh `changes-lost` (`#settleOutcome`, kv-persist.ts:277-285: `refused !== null`, `!refused.replayable`, `refused.origin === 'unavailable'`), nó báo `changes-lost` và KHÔNG bao giờ báo `recovered` — `reportPersistHealth(name,'changes-lost')` (persist-health.ts:84-89) không đụng tới tập `unavailable`. Nhánh bỏ cuộc trong `#askForRecovery` (kv-persist.ts:415-418) cũng vậy.

  Kịch bản hỏng: máy thứ hai chưa từng có giá trị trên ngăn account (`#storeHoldsRealData === false`), người dùng sửa một cài đặt trong lúc backend KV hỏng → ghi bị từ chối, không replay được, chốt `unavailable` bật. Sau đó họ nhập mã nhận: `/api/claim/redeem` trả 200, cookie ĐÃ đổi sang chủ sở hữu mới, `rehydrate()` đọc THÀNH CÔNG ngăn mới — nhưng lần settle này báo `changes-lost`, chốt `unavailable` vẫn bật, nên dòng 85-88 ném `AccountPartitionUnreadableError`, `adoptChoicesFromCode` trả `unreachable` và màn hiện ST-maycuatoi-may-chu-im. Người dùng thấy «máy chủ im» dù việc nhận đã xong; thử lại thì mã dùng-một-lần đã cháy nên lần sau ra «mã không dùng được» — ngõ cụt.

  Đây đúng là bệnh mà commit f6be99c5 («derive every check from the thing it checks») và chính đầu file này khai là muốn chữa: `didLastReadFindStoredValue` được thêm vì lý do đó, còn phép thử hỏng/không-hỏng thì vẫn đi mượn một chốt toàn cục không nói về lần đọc này.

  AC-7 đòi sau khi đổi mã máy B phải đọc chung ngăn account; ở đây lần đọc sau redeem thành công thật nhưng bị báo lỗi do chốt cũ, nên vế Then của AC-7 không đạt.

- **A write refused before adoption is replayed into the newly adopted owner's partition, overwriting the other device's settings**
  file: `lib/store/kv-persist.ts:656`
  severity: high
  AC: AC-14
  source: bugs
  `KeyState` keeps a refused write (`#refused`) alive indefinitely — `#askForRecovery` gives up after `DEFAULT_RECOVERY_BACKOFF_MS` (3 tries, ~1.25s total), sets `#recoveryExhausted`, reports `changes-lost`, and deliberately does NOT clear `#refused` (kv-persist.ts:406-421). Nothing in the adoption path resets it: `reloadAccountStoresAndConfirm` (lib/store/account-stores.ts:78) only calls `persist.rehydrate()`.

  Concrete sequence on device B:
  1. Boot: `getItem('settings-storage')` returns B's own value → `noteRealData()` latches `#storeHoldsRealData = true`.
  2. Backend hiccup while the user edits a setting: `setItem` is admitted, the PUT fails → `onFailure` (phase `unavailable`) then `noteWriteFailed(value)` stores `#refused = { value: B's settings, replayable: true, origin: 'unavailable' }`.
  3. The backend stays down past three retries → recovery exhausted, `#refused` retained, key stays `unavailable`.
  4. User redeems device A's claim code. Cookie now points at A. `reloadAccountStoresAndConfirm` → `rehydrate()` → `getItem` reads **A's** partition successfully → `concludeRead` (line 641) calls `state.settle()`; `#settleOutcome` sees `refused.replayable === true` and promotes it to `#replay` (line 256-262), reports `recovered`.
  5. `concludeRead` then writes that snapshot back: `kvStorage.setItem(name, replay)` at line 656 — **device B's old settings are written into device A's account partition** — and returns `replay` (line 667) instead of `stored`, so device B's store hydrates with B's own values, not A's.

  The outcome is reported as success: `isPersistUnavailable` is false (step 4 reported `recovered`), so `reloadAccountStoresAndConfirm` does not throw; `lastReadFoundValue` was set from `stored` (A's value was present, line 713), so the store is listed in `replaced`; `adoptChoicesFromCode` returns `'adopted'` and the panel renders `ST-maycuatoi-xong`. This is exactly the failure the JSDoc on `MyDevicesSettingsProps.onAdopted` claims the type prevents (\"báo «đã dùng chung» trong khi sản phẩm vẫn chạy bằng lựa chọn cũ, rồi lần sửa kế tiếp ghi đè cấu hình của máy kia\") — here the overwrite happens immediately, inside the adoption read itself. No test covers it: tests/store/adoption-proof.test.ts never puts a refused write in flight before adopting.

  The replay decision is owner-blind — `replayable` only asks \"did this session ever hold authoritative data\", never \"authoritative data for *which* owner\".

  AC-14 đòi sau khi nhận xong máy B phải đọc ra ĐÚNG giá trị máy A đã ghi; ở đây máy B lại đọc ra giá trị cũ của chính nó (bị replay đè lên ngăn của A), nên Then của AC-14 không đạt.

- **A redeem that succeeds but whose rehydrate fails is reported as "server silent" after the code is already burned and the cookie already swapped**
  file: `lib/persistence/adopt-choices.ts:52`
  severity: medium
  AC: AC-7
  source: bugs
  `adoptChoicesFromCode` awaits `deps.rehydrate()` after a 2xx redeem and returns `'unreachable'` if it throws. By that point the server has already (a) burned the one-time code in `redeemClaimCode` (claim-code.ts:104-105) and (b) sent `Set-Cookie: anonymous_id=<A's uuid>`, which the browser has applied — the device IS the adopted owner.

  The panel renders `ST-maycuatoi-may-chu-im` (`settings.myDevices.serverSilent`) with the code input still live, inviting a retry. The only retry available is the same code, which now returns 401 → `'rejected'` → \"mã không đúng hoặc đã hết hạn\". The user has no path forward except going back to device A for a new code, and nothing tells them the identity switch already happened.

  The throw comes from `AccountPartitionUnreadableError` (lib/store/account-stores.ts:88), raised when any one account store's read failed. Because `Promise.all` rehydrates both stores, the *other* store may have hydrated successfully from the adopted partition — so the app is left half-adopted while the UI reports a network failure.

  AC-7 đòi khi đổi mã thành công máy B phải đọc chung ngăn account; ở đây danh tính đã đổi nhưng việc đọc lại thất bại và được báo như redeem thất bại, nên vế Then của AC-7 không đạt.

## Ngoài hợp đồng — người quyết ở Gate 2

Các lỗi dưới đây nằm ngoài phạm vi đã duyệt ở Cổng Phạm vi và CHƯA qua bác bỏ đối kháng — người quyết, máy không sửa và không chấm thứ máy không được sửa.

- **Đường mint /api/claim không có bộ hãm, cho phép xoá sổ mã đang chờ của người khác**
  Người dùng thấy gì: Một người lạ có thể gửi rất nhiều yêu cầu xin mã liên tục khiến mã đang chờ của người khác bị đẩy khỏi hệ thống, làm người đó nhập đúng mã vẫn bị báo là sai.
  file: `app/api/claim/route.ts`
  severity: medium
  Đề xuất: new-contract

- **Mọi HTTP status khác 2xx bị gộp thành «mã sai», kể cả 429 và 500 cố ý phân biệt**
  Người dùng thấy gì: Khi bị tạm chặn vì thử quá nhanh hoặc khi máy chủ gặp sự cố nội bộ, người dùng vẫn chỉ thấy thông báo 'mã không đúng hoặc đã hết hạn' và không biết nên đợi bao lâu để thử lại.
  file: `lib/persistence/adopt-choices.ts`
  severity: medium
  Đề xuất: known-limits

- **Đăng ký toàn bộ state của hai store rồi `void` — lệch pattern selector của chính file**
  Người dùng thấy gì: Màn Cài đặt có thể vẽ lại chậm hơn cần thiết mỗi khi có bất kỳ lựa chọn nào đổi ở nơi khác trong app, kể cả khi mục Máy của tôi đang đóng.
  file: `components/settings/index.tsx`
  severity: medium
  Đề xuất: known-limits

- **Bump minor cho thay đổi thuần cộng thêm, ngược quy ước semver 0.x của repo**
  Người dùng thấy gì: Các gói phụ thuộc vào thư viện lưu trữ này có thể tưởng nhầm bản cập nhật phá vỡ tương thích và ngần ngại nâng cấp, dù thực ra chỉ có tính năng mới không ảnh hưởng tới họ.
  file: `packages/@openmaic/storage/package.json`
  severity: low
  Đề xuất: known-limits

- **Every non-2xx from /api/claim/redeem is reported to the user as a bad code, including 429 and 500**
  Người dùng thấy gì: Người dùng bị tạm chặn do thử nhanh hoặc gặp lỗi hệ thống vẫn chỉ thấy đúng thông báo 'mã sai', không được biết đó là sự cố tạm thời hay nên chờ bao lâu.
  file: `lib/persistence/adopt-choices.ts`
  severity: medium
  Đề xuất: known-limits

- **The copy button reports success even when nothing reached the clipboard**
  Người dùng thấy gì: Người dùng bấm Sao chép và thấy dấu xác nhận dù mã chưa thực sự vào bộ nhớ tạm, nên khi dán sang máy kia có thể dán nhầm nội dung cũ và bị báo mã sai mà không hiểu vì sao.
  file: `components/settings/my-devices-settings.tsx`
  severity: medium
  Đề xuất: known-limits

- **/api/claim has no attempt limiter, so unauthenticated minting can silently evict a live claim code**
  Người dùng thấy gì: Một người lạ có thể gửi rất nhiều yêu cầu xin mã để đẩy mã đang chờ của người khác biến mất, khiến người đó nhập đúng mã vẫn bị báo là sai.
  file: `app/api/claim/route.ts`
  severity: medium
  Đề xuất: new-contract

- **Tuyên quét LỚP nhưng chỉ có điểm-case — «ba ca hỏng» thật ra là một ca lặp ba lần**
  Người dùng thấy gì: Nếu mã bị từ chối vì lý do khác sai/hết hạn/đã dùng (như bị chặn do thử quá nhanh), hiện chưa có phép thử nào chắc chắn phát hiện nếu sản phẩm xử lý sai trường hợp đó.
  file: `tests/persistence/adopt-choices.test.ts`
  severity: high
  Đề xuất: known-limits

- **Đo CHỈ DẪN thay vì ĐẦU RA — grep văn bản nguồn của sổ đăng ký, trong khi đường nhận đọc giá trị export**
  Người dùng thấy gì: Nếu một loại lựa chọn mới quên được đưa vào danh sách đi theo người, hiện chưa chắc có phép thử nào phát hiện, nên người dùng đổi máy có thể lại thấy thiếu lựa chọn mà không ai biết trước khi phát hành.
  file: `tests/persistence/account-scope-wiring.test.ts`
  severity: high
  Đề xuất: known-limits

- **Fixture VIẾT TAY tự ứng nghiệm — stub `rehydrate` ghi thẳng giá trị mà assert đi tìm**
  Người dùng thấy gì: Phép thử hiện tại không thực sự xác nhận máy thứ hai đọc đúng giá trị máy thứ nhất đã ghi, nên một lỗi khiến giá trị đọc sai có thể lọt qua trước khi phát hành.
  file: `tests/persistence/adopt-choices.test.ts`
  severity: high
  Đề xuất: known-limits

- **Assertion âm-tính-một-mình — không đối chứng dương rằng bản dump có chứa bản ghi**
  Người dùng thấy gì: Không có phép thử nào xác nhận chắc chắn rằng mã nhận thực sự được lưu lại ở dạng mã hoá, nên một lỗi vô tình làm mất bản ghi có thể không bị phát hiện trước khi phát hành.
  file: `tests/persistence/claim-code.test.ts`
  severity: medium
  Đề xuất: known-limits

- **Tuyên quét LỚP nhưng chỉ có điểm-case — E2 hứa ma trận toàn phần, phép đo chỉ chạm một kho**
  Người dùng thấy gì: Phép đo hiện tại chỉ kiểm tra một trong hai loại lựa chọn khi máy thứ hai nạp lại, nên nếu loại lựa chọn còn lại (hồ sơ người dạy) bị lỗi không đi theo người, có thể không ai phát hiện trước khi phát hành.
  file: `_acceptance/cau-hinh-di-theo-nguoi/evals.yaml`
  severity: medium
  Đề xuất: known-limits

- **Tuyên quét LỚP nhưng assert là NGƯỠNG ĐẾM — `toBeGreaterThan(1)` thay cho danh sách kho**
  Người dùng thấy gì: Phép đo chỉ kiểm tra có nhiều hơn một lựa chọn được thay hay giữ, không kiểm tra đúng từng loại, nên nếu thêm một loại lựa chọn mới mà sản phẩm bỏ sót, phép đo vẫn có thể báo đạt.
  file: `tests/store/adoption-proof.test.ts`
  severity: medium
  Đề xuất: known-limits

- **Fixture VIẾT TAY đúng khuôn bên đọc — mảng hai phần tử tự dựng thay cho `accountStoreStates()`**
  Người dùng thấy gì: Phép thử dựng sẵn dữ liệu giả thay vì lấy từ đúng nguồn sản phẩm dùng, nên nếu sản phẩm thật bỏ sót một loại lựa chọn, màn Cài đặt có thể ghi đè mà không hỏi trước, trong khi phép thử vẫn báo đạt.
  file: `tests/store/adoption-proof.test.ts`
  severity: medium
  Đề xuất: known-limits

- **Không ghim thông điệp — chiều đỏ E10 trỏ vào một chuỗi không tồn tại trong phép đo nào**
  Người dùng thấy gì: Có một cảnh báo được hứa cho trường hợp đọc lỗi bị hiểu nhầm thành không có gì, nhưng hiện không có phép thử nào thực sự kiểm tra cảnh báo đó xuất hiện, nên nếu lỗi này xảy ra có thể không ai biết trước khi phát hành.
  file: `_acceptance/cau-hinh-di-theo-nguoi/evals.yaml`
  severity: low
  Đề xuất: known-limits

⚠ Cụm ngoài vùng phủ: 9/18 lỗi rơi vào file không bộ đo nào phủ (packages/@openmaic/storage/package.json, tests/persistence/adopt-choices.test.ts, tests/persistence/account-scope-wiring.test.ts, tests/persistence/claim-code.test.ts, _acceptance/cau-hinh-di-theo-nguoi/evals.yaml, tests/store/adoption-proof.test.ts) — dừng và quyết: mở rộng hợp đồng hay rút phạm vi.