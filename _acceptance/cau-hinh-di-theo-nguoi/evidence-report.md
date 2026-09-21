---
schema_version: 2
feature_slug: cau-hinh-di-theo-nguoi
verdict: PASS
failed_evals: []
verified_by: fresh-context verification subagent
enforcement_mode: strict
bypass_used: false
verified_commit: 7c3852e640a2450bf00d2239c3c286d1c4520ce6
human_signoff: Manh Phan 2026-09-21
---

# Evidence Report: cau-hinh-di-theo-nguoi (round 7)

Vòng 7 chấm lại E13 theo thước đã ký lại ở Cổng 1 (commit 19d7d42d, 77e7a849;
quyết định d-20260921T075657Z-27): Expected của E13 nay nêu đích danh các phản
hồi đúng-thiết-kế khi máy đo không có cơ sở dữ liệu, và bước «tắt tính năng»
đòi tắt CẢ NEXT_PUBLIC_PERSISTENCE lẫn NEXT_PUBLIC_ACCOUNT_SYNC.

**Mã sản phẩm không đổi kể từ vòng 6.** `git diff --stat 73d9a5eb HEAD -- .
':(exclude)_acceptance' ':(exclude)PRODUCT-MAP.md'` rỗng; mọi thay đổi từ
73d9a5eb tới HEAD 77e7a849 nằm trong `_acceptance/`. Vì vậy kết quả vòng 6 của
E1–E12 và E14–E18 được MANG SANG nguyên trạng — chỉ vì mã không đổi, không đo
lại vòng này. Khối bằng chứng của chúng là khối vòng 6 giữ nguyên văn bên dưới.
E13 được chấm lại trên chính các khung SỐNG và nhật ký mạng của vòng 6 (không
chụp lại: khung «tắt» được xác lập đủ điều kiện, xem khối E13 vòng 7).

| Eval | Criterion | Executor | Verdict |
|---|---|---|---|
| E1 | AC-1 | test | PASS (mang sang vòng 6 — mã không đổi) |
| E2 | AC-2 | test | PASS (mang sang vòng 6 — mã không đổi) |
| E3 | AC-3 | test | PASS (mang sang vòng 6 — mã không đổi) |
| E4 | AC-4 | test | PASS (mang sang vòng 6 — mã không đổi) |
| E5 | AC-5 | test | PASS (mang sang vòng 6 — mã không đổi) |
| E6 | AC-6 | test | PASS (mang sang vòng 6 — mã không đổi) |
| E7 | AC-7 | test | PASS (mang sang vòng 6 — mã không đổi) |
| E8 | AC-8 | test | PASS (mang sang vòng 6 — mã không đổi) |
| E9 | AC-9 | test | PASS (mang sang vòng 6 — mã không đổi) |
| E10 | AC-10 | test | PASS (mang sang vòng 6 — mã không đổi) |
| E11 | AC-11 | test | PASS (mang sang vòng 6 — mã không đổi) |
| E12 | AC-12 | judgment | PASS (đề xuất máy, mang sang vòng 6) — T3: chờ human_override |
| E13 | AC-13 | ui-check | PASS — chấm lại vòng 7 theo Expected đã ký lại (xem khối E13 vòng 7) |
| E14 | AC-13 | script | PASS (mang sang vòng 6 — mã không đổi) |
| E15 | AC-14 | test | PASS (mang sang vòng 6 — mã không đổi) |
| E16 | AC-15 | test | PASS (mang sang vòng 6 — mã không đổi) |
| E17 | AC-16 | test | PASS (mang sang vòng 6 — mã không đổi) |
| E18 | AC-17 | judgment | PASS (đề xuất máy, mang sang vòng 6) — T3: chờ human_override |

Phán quyết PENDING-JUDGMENT: mọi eval máy đều qua; E12 và E18 là judgment trên
hợp đồng T3, ô human_override của cả hai còn trống — chỉ người điền.

## Evidence vòng 7

- eval: E13
  run_id: minted-cau-hinh-di-theo-nguoi-E13-r7
  exit_code: 0
  baseline: n-a
  verifier: config:capture.ui
  verified_at: 2026-09-21T07:58:33Z
  screenshot: evidence/E13-ghi-de.png
  network_observed: ok
  observed: |
    Chấm lại trên khung SỐNG vòng 6 (commit 787d10f1) — không chụp mới, vì mã
    sản phẩm không đổi và thước chỉ đổi phần Expected về mạng.
    Khung: đã mở cả tám ảnh để soi. Cả tám do commit 787d10f1 (vòng 6) ghi, đúng
    trạng thái theo tên file: -san-sang (Get a code + ô Enter the code, nút mờ),
    -co-ma (mã thật + Copy + Expires in 600s), -ma-het-han (This code has
    expired. + Get a new code), -nhan-loi (That code cannot be used., ô giữ
    ZZZZZZZZ), -dang-nhan (ô khoá mang YYYYYYYY, vòng quay trên Use them here),
    -ghi-de (lời hỏi có phạm vi + Replace them / Cancel), -may-chu-im (Could not
    reach the server. Your current choices are unchanged. + Try again), -tat
    (Your choices are stored on this machine…, không nút). evidence/E13-xong.png
    là bản DOM-dựng-lại của vòng 5 (commit e4f76df6), KHÔNG thuộc tám khung và
    không eval nào dùng — không tính.
    Khung «tắt» và NEXT_PUBLIC_ACCOUNT_SYNC: nhật ký vòng 6 chỉ ghi máy chủ tạm
    :3012 chạy với NEXT_PUBLIC_PERSISTENCE bỏ trống, KHÔNG đặt tường minh
    NEXT_PUBLIC_ACCOUNT_SYNC — tức cờ đó bỏ trống (mặc định tắt). Xác lập bằng
    ba căn cứ độc lập: (1) không nguồn env nào của repo (.env.local,
    .env.example, dev_server.start) hay shell đo khai cờ này; (2) ở mã sản phẩm
    73d9a5eb = HEAD, trạng thái ST-maycuatoi-tat chỉ dựng được khi
    isAccountSyncEnabled() sai, mà hàm đó trả đúng nếu MỘT TRONG HAI cờ bằng '1'
    — khung -tat hiện ra nghĩa là cả hai đều tắt lúc biên dịch; (3) nhật ký
    mạng phiên TAT không có một yêu cầu /api/persistence/kv/entries/* nào, trong
    khi mọi phiên bật đồng bộ đều có. Khung vòng 6 vì vậy đáp đúng bước đã ký lại.
  output: |
    Khung: 8/8 có mặt, 8/8 sống, 8/8 đúng trạng thái.
    Network truth (evidence/E13-network.txt, same-origin http://localhost:3002
    và :3012), đối chiếu từng dòng 4xx/5xx với Expected đã ký lại:
    - 40 × GET /api/persistence/kv/entries/* 404 — nêu đích danh (lưu trữ máy
      chủ chưa cấu hình).
    - 10 × GET /api/stages 404, 10 × GET /api/folders 404 — nêu đích danh (chỉ
      phục vụ khi agent runtime bật).
    - 2 × POST /api/claim/redeem 401 — cả hai là mã sai: ZZZZZZZZ (khung
      -nhan-loi) và YYYYYYYY (yêu cầu bị giữ 4 giây cho khung -dang-nhan, thấy
      trong ô khoá của ảnh). Nêu đích danh (lời từ chối thiết kế của AC-5).
    - 1 × POST /api/claim FAILED net::ERR_CONNECTION_REFUSED — yêu cầu người đo
      cố ý chặn để dựng khung -may-chu-im; nêu đích danh.
    - Còn lại toàn 2xx (server-providers, comfyui-workflows, access-code/status,
      claim). Không có 5xx. Không có 4xx nào ngoài danh sách.
    network_observed = ok → exit_code 0 → E13 PASS.

# Vòng 6 (giữ nguyên văn — nguồn của các kết quả mang sang)

# Evidence Report: cau-hinh-di-theo-nguoi (round 6)

Vòng 6 xác minh lại ở HEAD `73d9a5eb` (sau ba bản sửa chỉ-prod và phần mang
lựa chọn cũ lên ngăn trống). Bộ kiểm chạy lại toàn bộ qua `with-pinned-node.sh`
(Node 22). Tám khung E13 chụp SỐNG lại từ đầu trên máy chủ phát triển đang chạy.

| Eval | Criterion | Executor | Verdict |
|---|---|---|---|
| E1 | AC-1 | test | PASS |
| E2 | AC-2 | test | PASS |
| E3 | AC-3 | test | PASS |
| E4 | AC-4 | test | PASS |
| E5 | AC-5 | test | PASS |
| E6 | AC-6 | test | PASS |
| E7 | AC-7 | test | PASS |
| E8 | AC-8 | test | PASS |
| E9 | AC-9 | test | PASS |
| E10 | AC-10 | test | PASS |
| E11 | AC-11 | test | PASS |
| E12 | AC-12 | judgment | PASS (đề xuất máy) — T3: chờ human_override |
| E13 | AC-13 | ui-check | FAIL — 8/8 khung sống đúng trạng thái, nhưng network truth = app-fail theo luật kit (xem khối E13) |
| E14 | AC-13 | script | PASS |
| E15 | AC-14 | test | PASS |
| E16 | AC-15 | test | PASS |
| E17 | AC-16 | test | PASS |
| E18 | AC-17 | judgment | PASS (đề xuất máy) — T3: chờ human_override |

## Evidence

- eval: E1
  run_id: minted-cau-hinh-di-theo-nguoi-E1-r6
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-21T07:37:19Z
  attributed_to: tests/store/kv-persist-http.test.ts (thông điệp ghim 'account write did not reach the server store' có mặt)
  output: |
    Test Files  748 passed | 12 skipped (760)
    Tests  8507 passed | 43 skipped (8550)
    Start at  14:37:19 (local; 07:37:19Z)
    Duration  39.41s

- eval: E2
  run_id: minted-cau-hinh-di-theo-nguoi-E2-r6
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-21T07:37:19Z
  attributed_to: tests/persistence/account-scope-wiring.test.ts (ghim 'account key set drifted from the declared scope' có mặt; ghim (a) 'account key stayed device-local' KHÔNG tìm thấy trong bài kiểm nào — xem Ghi chú phép đo)
  output: |
    Test Files  748 passed | 12 skipped (760)
    Tests  8507 passed | 43 skipped (8550)
    Start at  14:37:19 (local; 07:37:19Z)
    Duration  39.41s

- eval: E3
  run_id: minted-cau-hinh-di-theo-nguoi-E3-r6
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-21T07:37:19Z
  attributed_to: tests/persistence/claim-code.test.ts (ghim 'claim TTL exceeds the signed ceiling' có mặt)
  output: |
    Test Files  748 passed | 12 skipped (760)
    Tests  8507 passed | 43 skipped (8550)
    Start at  14:37:19 (local; 07:37:19Z)
    Duration  39.41s

- eval: E4
  run_id: minted-cau-hinh-di-theo-nguoi-E4-r6
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-21T07:37:19Z
  attributed_to: tests/persistence/claim-code.test.ts, tests/api/claim.test.ts (ghim 'claim code was redeemable twice' có mặt)
  output: |
    Test Files  748 passed | 12 skipped (760)
    Tests  8507 passed | 43 skipped (8550)
    Start at  14:37:19 (local; 07:37:19Z)
    Duration  39.41s

- eval: E5
  run_id: minted-cau-hinh-di-theo-nguoi-E5-r6
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-21T07:37:19Z
  attributed_to: tests/api/claim.test.ts (ghim 'claim failure modes are distinguishable' có mặt)
  output: |
    Test Files  748 passed | 12 skipped (760)
    Tests  8507 passed | 43 skipped (8550)
    Start at  14:37:19 (local; 07:37:19Z)
    Duration  39.41s

- eval: E6
  run_id: minted-cau-hinh-di-theo-nguoi-E6-r6
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-21T07:37:19Z
  attributed_to: tests/api/claim.test.ts (ghim 'claim redeem accepted unlimited attempts' có mặt)
  output: |
    Test Files  748 passed | 12 skipped (760)
    Tests  8507 passed | 43 skipped (8550)
    Start at  14:37:19 (local; 07:37:19Z)
    Duration  39.41s

- eval: E7
  run_id: minted-cau-hinh-di-theo-nguoi-E7-r6
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-21T07:37:19Z
  attributed_to: tests/api/claim.test.ts (ghim 'redeem minted a fresh owner instead of adopting' có mặt)
  output: |
    Test Files  748 passed | 12 skipped (760)
    Tests  8507 passed | 43 skipped (8550)
    Start at  14:37:19 (local; 07:37:19Z)
    Duration  39.41s

- eval: E8
  run_id: minted-cau-hinh-di-theo-nguoi-E8-r6
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.storage
  verified_at: 2026-09-21T07:37:59Z
  attributed_to: tests/store/kv-persist-http.test.ts + packages/@openmaic/storage/src/kv/pg.ts (ghim 'device scope crossed the network boundary' có mặt)
  output: |
    Test Files  29 passed | 7 skipped (36)
    Tests  1178 passed | 184 skipped (1362)
    Start at  14:37:59 (local; 07:37:59Z)
    Duration  31.42s

- eval: E9
  run_id: minted-cau-hinh-di-theo-nguoi-E9-r6
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-21T07:37:19Z
  attributed_to: tests/store/kv-persist-http.test.ts (ghim 'local-only deployment reached the network' có mặt)
  output: |
    Test Files  748 passed | 12 skipped (760)
    Tests  8507 passed | 43 skipped (8550)
    Start at  14:37:19 (local; 07:37:19Z)
    Duration  39.41s

- eval: E10
  run_id: minted-cau-hinh-di-theo-nguoi-E10-r6
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.storage
  verified_at: 2026-09-21T07:37:59Z
  attributed_to: tests/store/kv-persist.test.ts describe 'a failed read never persists defaults' (ghim 'a failed read was read as absence' KHÔNG tìm thấy — phát hiện đã ghi ở vòng 5, vẫn còn)
  output: |
    Test Files  29 passed | 7 skipped (36)
    Tests  1178 passed | 184 skipped (1362)
    Start at  14:37:59 (local; 07:37:59Z)
    Duration  31.42s

- eval: E11
  run_id: minted-cau-hinh-di-theo-nguoi-E11-r6
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-21T07:37:19Z
  attributed_to: tests/persistence/route.test.ts (ghim 'account partition leaked across owners' có mặt)
  output: |
    Test Files  748 passed | 12 skipped (760)
    Tests  8507 passed | 43 skipped (8550)
    Start at  14:37:19 (local; 07:37:19Z)
    Duration  39.41s

- eval: E12
  judged_by: fresh-context verification subagent (một lens, đề xuất máy) — hợp đồng T3 nên cần human_override trên mọi mục judgment
  verdict: PASS
  rationale: |
    Chấm trên khung SỐNG vòng này, evidence/E13-ghi-de.png (chụp giữa luồng
    thật: máy C tự đặt một khoá API qua giao diện nên có lựa chọn riêng, rồi
    nhập mã còn hiệu lực do máy A vừa lấy). Lời hỏi hiện nguyên văn: "The
    choices the other machine has will replace the matching ones here.
    Anything it never set is left as it is." kèm hai nút "Replace them" và
    "Cancel". Mâu thuẫn nguồn của vòng 5 (panel trích chuỗi cũ không phạm vi)
    đã hết: ảnh vòng này mang chuỗi MỚI, đọc bằng mắt từ file ảnh và khớp
    innerText lúc chụp.
    Đối chiếu AC-12 như đang viết: (1) hỏi TRƯỚC khi thay — đạt, lời hỏi chặn
    luồng cho tới khi bấm "Replace them"; (2) nói đúng PHẠM VI — đạt, câu nói
    thay "những thứ tương ứng" và hứa rõ thứ máy kia chưa từng đặt được giữ,
    không hứa thay tất cả; (3) cho quay lại — đạt, "Cancel" đưa về trạng thái
    nhập mã.
    Câu hỏi của eval (thứ đang có sẽ MẤT có nói đủ rõ không): "replace" là nói
    thẳng rằng giá trị tương ứng ở máy này bị thay thế; câu không liệt kê tên
    từng mục sẽ mất — AC-12 không đòi liệt kê, nên đây không phải lý do trượt,
    chỉ là chỗ có thể tốt hơn. Không đọc như hộp xác nhận qua loa.
    Known limits đã ký có liên quan nhưng không lật phán quyết: giới hạn 2
    (lựa chọn cũ của máy này có thể ghi đè ngược lên máy kia sau khi nhận) là
    trường hợp lời hứa "Anything it never set is left as it is" có thể không
    đúng TRỌN ở phía máy kia; người ký đã chấp nhận giới hạn này, và AC-12 chấm
    lời hỏi, không chấm hệ quả đó.
  human_override: Đạt — Manh Phan 2026-09-21

E13 vòng 6: đỏ theo thước cũ — lưu nguyên văn ở `evidence/round-6-E13.md`;
đã được thay bằng khối E13 vòng 7 ở mục «Evidence vòng 7».

- eval: E14
  run_id: minted-cau-hinh-di-theo-nguoi-E14-r6
  exit_code: 0
  baseline: n-a
  verifier: config:executors.design.gate
  verified_at: 2026-09-21T07:39:42Z
  output: |
    "base": "aa7a318baa9f03dcf8cc67d72adcf0c50a4023af",
    "scanned": 2,
    "verdict": "PASS",
    "fail_on": ["P0"],
    components/settings/index.tsx                 PASS  p0: []
    components/settings/my-devices-settings.tsx   PASS  p0: []

- eval: E15
  run_id: minted-cau-hinh-di-theo-nguoi-E15-r6
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-21T07:37:19Z
  attributed_to: tests/persistence/adopt-choices.test.ts (ghim 'redeem left stale in-memory choices' có mặt)
  output: |
    Test Files  748 passed | 12 skipped (760)
    Tests  8507 passed | 43 skipped (8550)
    Start at  14:37:19 (local; 07:37:19Z)
    Duration  39.41s

- eval: E16
  run_id: minted-cau-hinh-di-theo-nguoi-E16-r6
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-21T07:37:19Z
  attributed_to: tests/store/kv-persist-write-failure.test.ts (ghim 'a failed write was reported as saved' có mặt)
  output: |
    Test Files  748 passed | 12 skipped (760)
    Tests  8507 passed | 43 skipped (8550)
    Start at  14:37:19 (local; 07:37:19Z)
    Duration  39.41s

- eval: E17
  run_id: minted-cau-hinh-di-theo-nguoi-E17-r6
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-21T07:37:19Z
  attributed_to: tests/store/adoption-proof.test.ts (ghim 'adoption claimed a key the other machine never wrote' có mặt)
  output: |
    Test Files  748 passed | 12 skipped (760)
    Tests  8507 passed | 43 skipped (8550)
    Start at  14:37:19 (local; 07:37:19Z)
    Duration  39.41s

- eval: E18
  judged_by: fresh-context verification subagent (một lens, đề xuất máy) — hợp đồng T3 nên cần human_override trên mọi mục judgment
  verdict: PASS
  rationale: |
    Câu hỏi: hồ sơ có ghi rõ phần «đã dùng chung» và kết quả thật của việc nhận
    do MẮT NGƯỜI KÝ chứng, kèm điều người ấy thấy — hay im lặng để người đọc
    tưởng máy đã chứng?
    Hồ sơ KHÔNG im lặng. Mục "Mắt người ký — AC-17 (E18)" (giữ nguyên văn ở
    cuối báo cáo) ghi: người chứng (Manh Phan), ngày (2026-09-21), nơi (prod
    https://openmaic-zeta-seven.vercel.app, máy thật), lời chứng nguyên văn
    «Tôi đã thử và chạy tốt», và nói thẳng "Phần này do MẮT NGƯỜI KÝ chứng,
    không phải máy đo" cùng lý do máy đo không chứng được. Mục cha cũng tự gắn
    nhãn "(máy chạy, chưa phải mắt người ký)" cho bảng chạy máy trên prod, nên
    hai nguồn — máy chạy và mắt người — tách bạch, không lẫn. Vòng này cũng
    không tuyên máy đã chứng -xong: E13 bỏ khung đó.
    Vế "kèm điều người ấy thấy" đạt nhưng mỏng: lời chứng nguyên văn là một câu
    chung, không tả màn nào; việc nối nó vào bốn bước (giữ lựa chọn cũ · lấy mã
    · máy thứ hai dùng mã và thấy lựa chọn · sửa một bên, bên kia thấy sau khi
    tải lại) là do người ghi hồ sơ viết, và hồ sơ tự nói "Lời chứng không tách
    từng bước". Sự thành thật đó là thứ AC-17 đòi — không giả vờ chi tiết hơn
    lời người ký — nên PASS; người ký có thể muốn thêm một dòng tự tả màn
    «đã dùng chung» mình thấy nếu cần hồ sơ dày hơn.
    Ghi chú nguồn: run-log.jsonl có một dòng kind=judgment E18 "pass" mang
    judged_by Manh Phan (sha 203c0c1f). Vòng này không chép nó vào
    human_override — ô đó chỉ người điền.
  human_override: Đạt — Manh Phan 2026-09-21

### Lệnh suite (hồi quy)

- cmd: ./scripts/with-pinned-node.sh pnpm test
  run_id: suite-cau-hinh-di-theo-nguoi-api-r6
  exit_code: 0
  verified_at: 2026-09-21T07:37:19Z

- cmd: ./scripts/with-pinned-node.sh pnpm --filter @openmaic/storage test
  run_id: suite-cau-hinh-di-theo-nguoi-storage-r6
  exit_code: 0
  verified_at: 2026-09-21T07:37:59Z

- cmd: ./scripts/with-pinned-node.sh node scripts/design-gate-changed.mjs
  run_id: suite-cau-hinh-di-theo-nguoi-design-r6
  exit_code: 0
  verified_at: 2026-09-21T07:39:42Z

## Known limits

Người ký chấp nhận ba giới hạn dưới đây trước khi phát hành. Cả ba chụm vào
MỘT gốc: trạng thái theo-khoá của tầng lưu bền khoá theo tên kho nhưng ngữ
nghĩa là theo chủ sở hữu, và không gì gột nó khi chủ đổi.

1. Nhận xong nhưng màn báo «máy chủ im», và KHÔNG thử lại được vì mã dùng-một-lần
   đã cháy. Xảy ra khi máy này từng gặp sự cố lưu trữ trước lúc nhận: dấu hỏng cũ
   còn treo, nên lần đọc mới thành công vẫn bị đọc thành thất bại. Đây là ngõ cụt
   cho người dùng — không có đường đi tiếp trong sản phẩm.
2. Lựa chọn cũ của máy này có thể GHI ĐÈ cấu hình của máy kia sau khi nhận. Xảy ra
   khi có một lời ghi bị từ chối trước lúc nhận: nó nằm chờ trong bộ đệm rồi được
   phát lại vào ngăn của chủ mới.
3. Việc đổi mã chốt danh tính TRƯỚC khi biết nạp lại có xong không. Nạp hỏng thì
   màn nói «không đổi gì» trong khi máy đã mang danh tính mới.

Phép sửa cho cả ba là một: gột trạng thái theo-khoá ngay tại lúc đổi chủ sở hữu,
trước khi nạp lại. Chưa làm ở vòng này theo quyết định của người ký.

GIỚI HẠN CỦA PHÉP ĐO, không phải của sản phẩm: máy đo không có cơ sở dữ liệu nào
chạy, nên luồng đầu-cuối chưa từng được chạy trọn. Phần giao diện và phần chấm
bằng mắt của vòng này chưa được chứng — người ký tự soi.

## Ngoài hợp đồng

### Chờ người ký định đoạt (tác giả nêu, chưa sửa)

- Ngoài-1 — Khoá API nằm dạng rõ trong bảng lựa chọn trên máy chủ. Khi bật đồng
  bộ, khoá nhà cung cấp người dán vào Cài đặt được ghi nguyên văn vào Supabase.
  Hiện đỡ bằng: cổng mật mã vào app, Data API của Supabase đã tắt lúc tạo dự án
  nên không đọc được bảng qua khoá công khai. Ai có quyền vào database thì đọc được.
- Ngoài-2 — Trang lạ có thể dụ trình duyệt đã vào app gửi một mã nhận (đổi mã
  không kiểm nguồn gọi). Hiện chặn được nhờ cổng mật mã: cookie cổng không đi theo
  yêu cầu từ trang khác. Tắt cổng mật mã là hở.
- Ngoài-3 — Lấy mã không giới hạn tần suất. Sau cổng mật mã chỉ người đã vào app
  gọi được; bảng mã tự dọn mã hết hạn mỗi lần lấy mã mới.
- Ngoài-4 — Mọi lỗi khi đổi mã (kể cả quá tần suất, máy chủ lỗi) đều hiện là
  «mã sai hoặc hết hạn» — người không biết nên thử lại hay đợi.
- Ngoài-5 — Giới hạn đã biết «luồng đầu-cuối chưa chạy trọn lần nào» trong hợp
  đồng đã lỗi thời: nó đã chạy trọn trên prod ngày 2026-09-21 (mục dưới).


### Ghi chú phép đo (vòng 6, không lật phán quyết)

- Hai chiều đỏ trong evals.yaml trỏ vào thông điệp ghim không tìm thấy trong
  bài kiểm nào: E2 vế (a) 'account key stayed device-local' và E10 'a failed
  read was read as absence'. Vế xanh của cả hai chạy và qua; vế đỏ không có
  thông điệp ghim để soi. E10 đã có trong run-log vòng 5 (kind=finding,
  proposal known-limits); E2 vế (a) là dòng mới vòng này.
- evidence/E13-xong.png (bản DOM-dựng-lại của vòng 5) vẫn nằm trong thư mục
  evidence dù không còn thuộc phép đo nào — dễ bị đọc nhầm là ảnh chụp sống.

## Analyst

carried tu round trước — baseline không đo lại round này.

Non-discriminating evals: none — baseline không đo lại round này, nên danh
sách này rỗng vì không đo, không phải vì mọi eval discriminate.

## Variance

none — không có eval nào có runs > 1 round này.

## Iterations

Round 3: BLOCKED — E13 (ui-check) không chạy vì xung đột nguồn chỉ thị; E1-E11,
E14-E16 PASS; E12 panel đề xuất PASS, chờ human_override.
Round 4: REJECT — E13 (ui-check) FAIL: khung ST-maycuatoi-tat thiếu đường dẫn
tài liệu bắt buộc dù 8/9 khung khớp Expected; E1-E11, E14-E16 PASS; E12 panel
đề xuất PASS (3/3), chờ human_override.
Round 5: REJECT — E13 (ui-check) FAIL: network truth app-fail (KV không có máy
chủ lưu trữ) + khung E13-xong.png dựng lại; E12 panel đề xuất FAIL 3/3 trên
lời hứa cũ; E1-E11, E14-E17 PASS.
Round 6 (round này, HEAD 73d9a5eb): REJECT — E13 (ui-check) FAIL chỉ còn một
lý do: network truth app-fail (not-found của ngăn account/stages/folders do
không có cơ sở dữ liệu, unauthorized của mã sai theo thiết kế; Expected không
khai trạng thái nào). Tám khung đều sống và đúng — lý do "khung dựng lại" của
vòng 5 đã hết nhờ AC-13 thu về tám trạng thái. E12 đổi sang đề xuất PASS (khung
sống mang lời hứa có phạm vi). E18 mới: đề xuất PASS. E1-E11, E14-E17 PASS.
Round 7 (HEAD 77e7a849, mã sản phẩm không đổi từ 73d9a5eb): PENDING-JUDGMENT —
E13 chấm lại theo Expected đã ký lại ở Cổng 1: mọi 4xx trong nhật ký mạng đều
thuộc danh sách đúng-thiết-kế → PASS; khung «tắt» xác lập được là cả hai cờ đều
tắt. Các eval khác mang sang vòng 6 vì mã không đổi. E12, E18 chờ human_override.
## Chạy thật trên prod — 2026-09-21 (máy chạy, chưa phải mắt người ký)

Hai trình duyệt không chung cookie trên https://openmaic-zeta-seven.vercel.app
(Supabase Singapore, kết nối mã hoá có xác minh chứng chỉ):

| Bước | Thấy |
|---|---|
| Máy A đặt lời giới thiệu, đọc lại từ máy chủ | có — `Thu nghiem may A 21-9` |
| Máy B lúc đầu | ngăn riêng, trống (404) |
| Máy A lấy mã, máy B dùng mã | màn báo «This machine now shares your choices.» |
| Máy B đọc | thấy lời giới thiệu của A |
| Dùng lại cùng mã | bị từ chối, cùng câu với mã sai |
| Máy B đổi tên thành `Sua tu may B`, máy A đọc | A thấy tên mới |
| Máy B tải lại trang | màn chào «Hi, Sua tu may B» — `evidence/prod-2026-09-21-may-B.jpg` |

Ba lỗi chỉ prod mới lộ, đã sửa trước lần chạy này:
1. Mã nhận giữ trong bộ nhớ một tiến trình — trên Vercel lấy mã và dùng mã chạy ở
   hai tiến trình khác nhau, nên mọi mã đều «sai hoặc hết hạn». Nay giữ trong
   bảng `claim_codes` (chỉ lưu dấu băm, dùng một lần).
2. Ảnh chụp trạng thái mang theo hàm và trường rỗng — kho trên mạng từ chối cả gói,
   nên không lựa chọn nào ghi được. Nay ghi đúng phần JSON giữ.
3. Cờ lưu trữ đầy đủ kéo luôn danh sách lớp học lên máy chủ — cần agent runtime,
   không bật thì trang chủ mất lớp học. Nay cờ riêng `NEXT_PUBLIC_ACCOUNT_SYNC`
   chỉ đồng bộ lựa chọn; lớp học ở yên trên máy.

Thêm sau (người ký duyệt «làm»): trình duyệt có lựa chọn từ trước khi bật đồng
bộ, gặp ngăn máy chủ trống → mang bản cũ lên, một lần mỗi khoá mỗi trình duyệt.
Thử trên prod với «máy C» (danh tính mới, bản cũ `May C tu truoc` trong trình
duyệt): máy chủ nhận đúng bản cũ, màn chào «Hi, May C tu truoc»
(`evidence/prod-2026-09-21-may-C-mang-len.jpg`); ngăn của A/B không đổi.

### Mắt người ký — AC-17 (E18)

- Người chứng: Manh Phan · 2026-09-21 · trên máy thật, prod
  https://openmaic-zeta-seven.vercel.app
- Nguyên văn: «Tôi đã thử và chạy tốt»
- Phần này do MẮT NGƯỜI KÝ chứng, không phải máy đo: máy đo không có cơ sở dữ
  liệu nên không dựng được trạng thái «đã dùng chung» và kết quả thật của việc nhận.
  Lời chứng không tách từng bước; điều nó phủ là bốn bước đã trình (máy đầu giữ
  lựa chọn cũ · lấy mã · máy thứ hai dùng mã và thấy lựa chọn · sửa một bên, bên
  kia thấy sau khi tải lại).

### Re-pin lần 1 — 2026-09-21, do định dạng code sau chữ ký (chỉ đổi khoảng trắng)
run_id: repin-20260921T082048Z-34851
sha: 9d7f88347787af9aa131e453af896df06916ac1c · suites: 2 lệnh exit 0 · evals: 15/15 eval máy đạt kỳ vọng

### Re-pin lần 2 — 2026-09-21, do chép khuôn opportunity cho bản đồ sản phẩm trong CI (không đổi mã sản phẩm)
run_id: repin-20260921T083233Z-49257
sha: 7c3852e640a2450bf00d2239c3c286d1c4520ce6 · suites: 2 lệnh exit 0 · evals: 15/15 eval máy đạt kỳ vọng
