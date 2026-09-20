## Trong hợp đồng

- **Adoption reports success when the adopted partition has no entry — the device keeps its old choices and then pushes them to the other machine**
  file: `lib/store/account-stores.ts:66`
  severity: medium
  AC: AC-12
  source: conventions
  `reloadAccountStoresAndConfirm` treats "not unavailable" as "adopted". But a key the adopted owner never wrote answers 404 → `HttpAccountKV` returns `null` → no health fault is raised, so `isPersistUnavailable` is false and the function resolves cleanly.

  What zustand does with that null is the problem (node_modules/zustand/esm/middleware.mjs:388-419): `getItem` → `null` yields `migratedState === undefined`, the default `merge` returns the *current* in-memory state, and `set(stateFromStorage, true)` writes it straight back. The store therefore keeps device B's own values — it is not reset to defaults and not replaced by A's.

  Concrete failure: A configured providers but never touched the profile screen, so only `settings-storage` exists in A's partition. B adopts. `settings-storage` is replaced correctly; `user-profile-storage` 404s, so B keeps its own nickname/avatar, the UI shows `ST-maycuatoi-xong` and the string «This machine now shares your choices», and B's next profile edit writes B's values into the now-shared account — A silently inherits them on next load.

  Two declared properties break: AC-12's promise, rendered as `settings.myDevices.willReplace` («The choices on this machine will be replaced by the ones from the other machine»), is false for that key; and `adopt-choices.ts`'s stated invariant — never report adopted while the product still runs on the old choices — is the very thing that happens. A 404 on the adopted partition is distinguishable from a hydrated value; the confirm step needs to act on that distinction rather than on the health flag alone.

  Finding chỉ ra đúng lời hứa xác nhận của AC-12 (lựa chọn trên máy này SẼ bị thay) là sai cho khoá đó, nên AC-12 thất bại.

- **Hình dạng 1 — đo CHỈ DẪN thay vì ĐẦU RA: bài «ma trận toàn phần» của E2 chỉ grep văn bản sổ đăng ký**
  file: `tests/persistence/account-scope-wiring.test.ts:66`
  severity: high
  AC: AC-2
  source: measurement
  Dòng 61-70: danh sách kho được rút từ mã nguồn (`readdirSync('lib/store')` + regex `createKVPersistStorage(...'account')`) — phần rút là thật — nhưng phép đo kế tiếp lại là `registry.includes("/store/${name}'")`, tức GREP VĂN BẢN của `lib/store/account-stores.ts`. Không có khoá nào được ghi, không có khoá nào được đọc lại. Thứ làm bài đỏ là sự vắng mặt của một CHUỖI trong file khai báo, không phải hành vi của việc nạp lại.

  Ca hỏng cụ thể: xoá mục `userProfile` khỏi `ACCOUNT_SCOPE_STORES` (lib/store/account-stores.ts:34-38) nhưng giữ nguyên dòng `import { useUserProfileStore } from '@/lib/store/user-profile'` ở dòng 15 — `registry.includes("/store/user-profile'")` vẫn đúng → bài vẫn XANH, trong khi `reloadAccountStoresAndConfirm()` và `accountStoreStates()` im lặng bỏ sót kho hồ sơ. Đó đúng là lớp lỗi mà chính phần đầu file (dòng 1-8) tuyên bố nó tồn tại để chặn.

  So với lời hứa E2 («số assert BẰNG số kho khai phạm vi account … phiên thứ hai của cùng chủ sở hữu đọc đúng MỌI khoá phiên một đã ghi»): không có vế phiên-một-ghi/phiên-hai-đọc nào cả, và chiều đỏ (a) của E2 — thông điệp ghim 'account key stayed device-local: <tên kho>' — không xuất hiện ở bất kỳ file kiểm thử nào trong repo (grep toàn `tests/` và `packages/@openmaic/storage/test/` không có kết quả).

  AC-2 tự đòi tập khoá phải rút từ khai báo phạm vi và máy B phải hiện đúng toàn bộ tập đó; finding chứng minh phép đo không kiểm được vế đọc-lại nên lời hứa của AC-2 không được giữ.

- **Hình dạng 5 — tuyên quét LỚP «ba ca hỏng» nhưng vòng lặp chạy CÙNG một ca ba lần**
  file: `tests/persistence/adopt-choices.test.ts:51`
  severity: high
  AC: AC-5
  source: measurement
  Bài tên «ba ca hỏng của máy chủ về cùng một kết quả» (dòng 49) lặp `for (const status of [401, 401, 401])` — mảng ba phần tử nhưng cả ba là CÙNG một giá trị, nên đây là một điểm-case chạy lặp, không phải ma trận. Ba ca thật mà tiêu chí nói tới — mã sai / hết hạn / đã dùng — khác nhau ở phía máy chủ chứ không ở con số 401 mà `adoptChoicesFromCode` nhận; ở tầng này chúng phải được sinh ra từ ba đường khác nhau (hoặc ít nhất ba mã trạng thái/thân phản hồi khác nhau, ví dụ 401/403/429/500) rồi đối chiếu KẾT QUẢ bằng nhau.

  Ca hỏng: sửa `adoptChoicesFromCode` (lib/persistence/adopt-choices.ts:47) thành `if (response.status === 401) return 'rejected'; return 'unreachable';` — một máy chủ trả 403 cho «đã dùng» sẽ ra kết quả khác hẳn, người dùng thấy trạng thái sai, nhưng bài này vẫn XANH vì nó chỉ từng thấy 401.

  AC-5 đòi đúng ba ca sai/hết hạn/đã dùng phải ra cùng một kết quả; finding cho thấy phép đo chỉ thử một ca lặp ba lần nên không giữ được lời hứa của AC-5.

- **Hình dạng 4 — assertion âm-tính-một-mình: phép đọc-lại không thể đỏ vì bộ giả lập luôn trả 404**
  file: `tests/store/kv-persist-write-failure.test.ts:86`
  severity: medium
  AC: AC-15
  source: measurement
  Dòng 84-89: sau lần ghi hỏng, bài gọi `storage.getItem('settings-storage')` rồi assert `.not.toBe('chưa tới máy chủ')`. Bộ giả lập ở dòng 56-64 trả 404 KEY_NOT_FOUND cho MỌI GET, và `getItem` trong lib/store/kv-persist.ts:667-707 luôn đi xuống backend (không có nhánh nào trả lại giá trị đã bị từ chối), nên `readBack` chắc chắn là `null` và `?.state?.voice` chắc chắn là `undefined`. Vế assert này không có cách nào đỏ.

  Thiếu đối chứng dương: trong cả file không có ca nào chứng minh rằng một lần ghi THÀNH CÔNG thì đọc lại RA đúng giá trị. Ca hỏng: làm `getItem` luôn trả `null` (hỏng hoàn toàn đường đọc) — vế dòng 81 vẫn thấy 'unavailable', vế dòng 86 vẫn xanh vì `undefined !== 'chưa tới máy chủ'` → bài XANH trên một seam không đọc được gì.

  AC-15 đòi lần đọc kế tiếp sau ghi lỗi không được trả về giá trị chưa tới máy chủ; finding cho thấy phép đo không thể đỏ trong mọi trường hợp nên không giữ được lời hứa của AC-15.

- **Hình dạng 5 — «nêu ĐÍCH DANH mọi kho» nhưng danh sách kho được chép tay, không rút từ sổ đăng ký**
  file: `tests/store/adoption-proof.test.ts:113`
  severity: medium
  AC: AC-2
  source: measurement
  Dòng 104-117 ghim hai tên bền `settings-storage` và `user-profile-storage` bằng hai regex viết tay, trong khi đầu file (dòng 1-9) tuyên bố nguyên tắc «Bên KIỂM rút ra từ bên LÀM — không dựng song song», và `ACCOUNT_SCOPE_STORES` (lib/store/account-stores.ts:28) đang được export sẵn với đúng trường `persistName` để map ra.

  Ca hỏng: thêm kho account thứ ba vào `ACCOUNT_SCOPE_STORES` — nếu `AccountPartitionUnreadableError` bỏ sót tên kho mới trong báo cáo (hoặc kho mới không bao giờ được lọc vào `broken`), hai regex chép tay vẫn khớp → bài XANH, đúng bản sao thứ hai của sự thật mà chính file này nói là nguyên nhân của ba vòng lỗi trước. Cùng bệnh ở dòng 152-158: `hasLocalChoicesInAccountScope` được gọi với mảng hai trạng thái viết tay chứ không phải `accountStoreStates()`, nên số phần tử của ma trận không đi theo sổ đăng ký.

  AC-2 đòi tập khoá phải rút từ chính khai báo phạm vi của các kho, không chép tay; finding cho thấy phép đo dùng danh sách chép tay nên không giữ được lời hứa đó của AC-2.

## Ngoài hợp đồng — người quyết ở Gate 2

Các lỗi dưới đây nằm ngoài phạm vi đã duyệt ở Cổng Phạm vi và CHƯA qua bác bỏ đối kháng — người quyết, máy không sửa và không chấm thứ máy không được sửa.

- **Provider API keys now leave the browser for the server KV partition — the contract's own out-of-scope line**
    Người dùng thấy gì: Bấm lưu Cài đặt có thể khiến khoá API của nhà cung cấp bị gửi lên máy chủ ở dạng chưa mã hoá, dù việc này chưa từng nằm trong kế hoạch của vòng hiện tại.
    file: `lib/store/kv-persist.ts`
    severity: high
    Đề xuất: new-contract

- **Minting a claim code is unthrottled, and minting is what evicts other people's live codes**
    Người dùng thấy gì: Nếu ai đó xin mã liên kết liên tục nhiều lần, mã đang chờ của người khác có thể bị huỷ sớm, khiến họ thấy báo 'mã không dùng được' dù mã của họ vẫn còn đúng.
    file: `app/api/claim/route.ts`
    severity: medium
    Đề xuất: new-contract

- **`getAccountKv` is exported but called from nowhere, and it swallowed `purgeLegacyPersistKey`'s doc comment**
    Người dùng thấy gì: Không ảnh hưởng đến người dùng — đây chỉ là phần ghi chú kỹ thuật còn sót lại trong mã nguồn, không hiển thị ra sản phẩm.
    file: `lib/store/kv-persist.ts`
    severity: low
    Đề xuất: wont-fix

- **`adopt-choices.ts` is not Prettier-formatted, so the required pre-PR format check fails**
    Người dùng thấy gì: Không ảnh hưởng đến người dùng — đây là một bước kiểm định dạng mã nguồn trước khi phát hành, chưa đạt yêu cầu kỹ thuật nội bộ.
    file: `lib/persistence/adopt-choices.ts`
    severity: low
    Đề xuất: known-limits

- **Settings dialog subscribes to two whole stores to recompute one boolean on every render**
    Người dùng thấy gì: Khi gõ trong ô cấu hình nhà cung cấp, màn Cài đặt có thể phản hồi chậm hơn một chút do vẽ lại nhiều hơn cần thiết.
    file: `components/settings/index.tsx`
    severity: low
    Đề xuất: wont-fix

- **Refused-write replay buffer survives the owner swap and writes device B's settings into the adopted account**
    Người dùng thấy gì: Nếu máy đang gặp trục trặc mạng rồi người dùng nhận mã để chuyển sang tài khoản khác, các lựa chọn cũ trên máy đó — có thể gồm cả khoá API — có thể âm thầm ghi đè lên tài khoản vừa nhận mà không ai được báo.
    file: `lib/store/kv-persist.ts`
    severity: high
    Đề xuất: new-contract

- **Redemption commits the identity swap before the reload; the 'unreachable' path leaves the device on the new owner while telling the user nothing changed**
    Người dùng thấy gì: Nếu màn hình báo 'không đổi gì' sau khi nhập mã, thực ra danh tính máy đã đổi; nếu người dùng tiếp tục chỉnh Cài đặt sau đó, lựa chọn cũ của máy có thể âm thầm ghi đè lên tài khoản vừa nhận.
    file: `lib/persistence/adopt-choices.ts`
    severity: high
    Đề xuất: new-contract

- **Every non-2xx redeem response is reported as a bad code, including 429 and 500**
    Người dùng thấy gì: Khi hệ thống đang bận hoặc gặp sự cố, người nhập đúng mã liên kết vẫn có thể bị báo 'mã không dùng được', khiến họ tưởng mình gõ sai và thử lại vô ích.
    file: `lib/persistence/adopt-choices.ts`
    severity: medium
    Đề xuất: known-limits

- **Copy button shows the success checkmark even when the clipboard write never happened**
    Người dùng thấy gì: Nút sao chép mã có thể báo đã sao chép thành công dù thực ra chưa chép được gì, khiến người dùng dán nhầm nội dung cũ sang máy kia.
    file: `components/settings/my-devices-settings.tsx`
    severity: medium
    Đề xuất: wont-fix

⚠ Cụm ngoài vùng phủ: 4/14 lỗi rơi vào file không bộ đo nào phủ (tests/persistence/account-scope-wiring.test.ts, tests/persistence/adopt-choices.test.ts, tests/store/kv-persist-write-failure.test.ts, tests/store/adoption-proof.test.ts) — dừng và quyết: mở rộng hợp đồng hay rút phạm vi.