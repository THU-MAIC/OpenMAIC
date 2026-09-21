---
schema_version: 2
feature_slug: cau-hinh-di-theo-nguoi
verdict: REJECT
failed_evals: [E13]
verified_by: fresh-context verification subagent
enforcement_mode: strict
bypass_used: false
verified_commit: 0f3bf83a5036854533e4d8b5034c5ea947efd9a0
human_signoff:
---

# Evidence Report: cau-hinh-di-theo-nguoi (round 5)

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
| E12 | AC-12 | judgment | UNCERTAIN — panel đề xuất FAIL (3/3 đồng thuận), chờ human_override |
| E13 | AC-13 | ui-check | FAIL — network truth app-fail (KV 404, thiếu Postgres) + E13-xong.png là bản dựng lại, không phải capture sống |
| E14 | AC-13 | script | PASS |
| E15 | AC-14 | test | PASS |
| E16 | AC-15 | test | PASS |
| E17 | AC-16 | test | PASS |

## Evidence

- eval: E1
  run_id: minted-cau-hinh-di-theo-nguoi-E1-r5
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-20T21:17:56Z
  output: |
    Tests  8494 passed | 43 skipped (8537)
    Start at  21:17:56
    Duration  46.43s (transform 35.27s, setup 5.24s, import 184.79s, tests 191.69s, environment 29.15s)

- eval: E2
  run_id: minted-cau-hinh-di-theo-nguoi-E2-r5
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-20T21:17:56Z
  output: |
    Tests  8494 passed | 43 skipped (8537)
    Start at  21:17:56
    Duration  46.43s (transform 35.27s, setup 5.24s, import 184.79s, tests 191.69s, environment 29.15s)

- eval: E3
  run_id: minted-cau-hinh-di-theo-nguoi-E3-r5
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-20T21:17:56Z
  output: |
    Tests  8494 passed | 43 skipped (8537)
    Start at  21:17:56
    Duration  46.43s (transform 35.27s, setup 5.24s, import 184.79s, tests 191.69s, environment 29.15s)

- eval: E4
  run_id: minted-cau-hinh-di-theo-nguoi-E4-r5
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-20T21:17:56Z
  output: |
    Tests  8494 passed | 43 skipped (8537)
    Start at  21:17:56
    Duration  46.43s (transform 35.27s, setup 5.24s, import 184.79s, tests 191.69s, environment 29.15s)

- eval: E5
  run_id: minted-cau-hinh-di-theo-nguoi-E5-r5
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-20T21:17:56Z
  output: |
    Tests  8494 passed | 43 skipped (8537)
    Start at  21:17:56
    Duration  46.43s (transform 35.27s, setup 5.24s, import 184.79s, tests 191.69s, environment 29.15s)

- eval: E6
  run_id: minted-cau-hinh-di-theo-nguoi-E6-r5
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-20T21:17:56Z
  output: |
    Tests  8494 passed | 43 skipped (8537)
    Start at  21:17:56
    Duration  46.43s (transform 35.27s, setup 5.24s, import 184.79s, tests 191.69s, environment 29.15s)

- eval: E7
  run_id: minted-cau-hinh-di-theo-nguoi-E7-r5
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-20T21:17:56Z
  output: |
    Tests  8494 passed | 43 skipped (8537)
    Start at  21:17:56
    Duration  46.43s (transform 35.27s, setup 5.24s, import 184.79s, tests 191.69s, environment 29.15s)

- eval: E8
  run_id: minted-cau-hinh-di-theo-nguoi-E8-r5
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.storage
  verified_at: 2026-09-20T21:18:57Z
  output: |
    Tests  1178 passed | 184 skipped (1362)
    Start at  21:18:57
    Duration  32.95s (transform 3.32s, setup 1.31s, import 5.96s, tests 200.44s, environment 2ms)

- eval: E9
  run_id: minted-cau-hinh-di-theo-nguoi-E9-r5
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-20T21:17:56Z
  output: |
    Tests  8494 passed | 43 skipped (8537)
    Start at  21:17:56
    Duration  46.43s (transform 35.27s, setup 5.24s, import 184.79s, tests 191.69s, environment 29.15s)

- eval: E10
  run_id: minted-cau-hinh-di-theo-nguoi-E10-r5
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.storage
  verified_at: 2026-09-20T21:18:57Z
  output: |
    Tests  1178 passed | 184 skipped (1362)
    Start at  21:18:57
    Duration  32.95s (transform 3.32s, setup 1.31s, import 5.96s, tests 200.44s, environment 2ms)

- eval: E11
  run_id: minted-cau-hinh-di-theo-nguoi-E11-r5
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-20T21:17:56Z
  output: |
    Tests  8494 passed | 43 skipped (8537)
    Start at  21:17:56
    Duration  46.43s (transform 35.27s, setup 5.24s, import 184.79s, tests 191.69s, environment 29.15s)

- eval: E12
  judged_by: panel (domain-correctness, operational-feasibility, spec-alignment) — đề xuất máy; hợp đồng risk_tier T3 nên PASS tổng thể sau này cần human_override trên MỌI mục judgment, không chỉ mục UNCERTAIN
  verdict: UNCERTAIN
  proposal: FAIL (đồng thuận 3/3 — đây là đề xuất máy, không phải quyết định cuối; người quyết ở Gate 2)
  rationale: |
    Cả ba lens đều chấm khung evidence/E13-ghi-de.png (màn "Use the choices from
    another machine", ST-maycuatoi-se-ghi-de) đang mang LỜI HỨA CŨ — chung
    chung, không nêu phạm vi — thay vì lời hứa đã sửa mà AC-12 (bản mới, ký lại
    ở round trước: "«thay» nghĩa là thay thứ máy kia CÓ") đòi hỏi. Nút Cancel
    có mặt và còn hoạt động nên vế "cho người quay lại" của AC-12 đạt; vế "nói
    đúng phạm vi" thì không. Từng dissent giữ nguyên văn, không rút gọn, xem
    votes bên dưới.
  votes:
    - domain-correctness: FAIL — Khung chụp E13-ghi-de.png đúng là màn "Use the choices from another machine" (ST-maycuatoi-se-ghi-de) và có nút Cancel để quay lại, nhưng dòng chữ xác nhận là "The choices on this machine will be replaced by the ones from the other machine" — một lời hứa chung chung, không nêu PHẠM VI mà AC-12 (bản đã sửa) đòi: không nói rõ chỉ những lựa chọn máy kia CÓ mới thay lựa chọn tương ứng ở máy này, còn thứ máy kia chưa từng đặt thì không hứa bị thay. Đây đúng là "lời hứa CŨ" mà đề bài cảnh báo — bằng chứng lỗi thời so với hợp đồng vừa ký lại.
    - operational-feasibility: FAIL — Khung chụp E13-ghi-de.png cho thấy lời hỏi xác nhận: "The choices on this machine will be replaced by the ones from the other machine." — một câu chung chung, không nêu phạm vi "chỉ những lựa chọn máy kia CÓ mới bị thay, thứ máy kia chưa từng đặt thì không đổi" mà AC-12 (bản hợp đồng vừa sửa) đòi hỏi. Đây đúng là lời hứa cũ («sẽ bị thay», không phân biệt phạm vi) — bằng chứng lỗi thời so với tiêu chí hiện hành. Nút "Cancel" có cho quay lại (đạt vế thứ hai của AC-12), nhưng vế nói đúng phạm vi thì không đạt.
    - spec-alignment: FAIL — Khung chụp cho thấy lời hỏi xác nhận là "The choices on this machine will be replaced by the ones from the other machine" — một lời hứa chung chung, không nêu phạm vi (không nói rõ chỉ những khoá máy A CÓ mới thay khoá tương ứng ở máy B, còn khoá máy A chưa từng đặt thì giữ nguyên). Đây đúng là dạng lời hứa CŨ mà đề bài cảnh báo, nên vi phạm phần "nói đúng PHẠM VI" của AC-12; phần "cho người quay lại" thì đạt vì có nút Cancel.
  required_evidence:
    - "(domain-correctness) Khung chụp mới (thay evidence/E13-ghi-de.png) của cùng màn Cài đặt › Máy của tôi, trạng thái ST-maycuatoi-se-ghi-de, với chuỗi xác nhận đã đổi để nêu rõ phạm vi — ví dụ 'Các lựa chọn máy kia đã đặt sẽ thay lựa chọn tương ứng ở máy này; lựa chọn máy kia chưa từng đặt sẽ giữ nguyên trên máy này' — chụp sau khi copy trong lib/i18n/locales/*/... cho khoá xác nhận này (vd 'settings.myDevices.confirmReplace' hay tên tương đương) đã được sửa lại theo đúng câu chữ đó."
    - "(operational-feasibility) Khung chụp mới của đúng màn ST-maycuatoi-se-ghi-de (mục Máy của tôi, bước xác nhận sau khi nhập mã) với câu hỏi đã sửa thành dạng nêu rõ phạm vi, ví dụ liệt kê/đếm số lựa chọn cụ thể sẽ bị thay ('N lựa chọn sẽ được thay bằng giá trị của máy kia; các lựa chọn máy kia chưa đặt vẫn giữ nguyên') — chụp từ đúng luồng lấy-mã/nhập-mã trong phiên nghiệm thu, không phải bản dựng lại."
    - "(spec-alignment) Sửa văn bản hộp thoại xác nhận ở trạng thái ST-maycuatoi-se-ghi-de (nơi hiện dòng 'The choices on this machine will be replaced by the ones from the other machine') để nêu rõ phạm vi — ví dụ liệt kê tên các mục/khoá cụ thể mà máy A đã đặt và sẽ thay ở máy B, đồng thời nói rõ mục máy A chưa từng đặt sẽ giữ nguyên trên máy B — rồi chụp lại evidence/E13-ghi-de.png từ chính màn hình xác nhận đó."
  human_override:

> Lưu ý cho người ở Gate 2 (mâu thuẫn giữa hai nguồn dữ liệu, KHÔNG tự giải quyết ở đây): driver ui-check của E13 (xem `observed:` trong khối E13 bên dưới) đọc trực tiếp trên app đang chạy và thấy evidence/E13-ghi-de.png hiện dòng "The choices the other machine has will replace the matching ones here. Anything it never set is left as it is." (chuỗi MỚI, có phạm vi, khớp `willReplace` trong en-US.json ở commit 0f3bf83a) — trong khi ba vote của judge panel ở trên trích dẫn CÙNG một file ảnh với dòng "The choices on this machine will be replaced by the ones from the other machine." (chuỗi CŨ, không phạm vi). Hai nguồn mô tả khác nhau về cùng một tệp; báo cáo này giữ nguyên cả hai như đã nhận, không tự chọn bên nào đúng. Người quyết ở Gate 2 cần tự mở `evidence/E13-ghi-de.png` để xác định nội dung thật trước khi ghi `human_override`.

- eval: E13
  run_id: minted-cau-hinh-di-theo-nguoi-E13-r5
  exit_code: 1
  baseline: n-a
  verifier: ui-check:E13
  verified_at: 2026-09-20T21:20:00Z
  screenshot: evidence/E13-ghi-de.png
  observed: |
    Opened all 9 saved frames with Read and compared each against its UX-STATE-TABLE row (9 states: -tat, -san-sang, -co-ma, -ma-het-han, -dang-nhan, -nhan-loi, -se-ghi-de, -xong, -may-chu-im — all 9 have a file in evidence/, none missing).

    The 7 kept frames (unchanged, re-verified by reading them):
    - E13-tat.png: "Your choices are stored on this machine. Turn on server-backed persistence..." + no button. Matches ST-maycuatoi-tat.
    - E13-san-sang.png: "Get a code" button + "Enter the code" input, both halves idle. Matches ST-maycuatoi-san-sang.
    - E13-co-ma.png: live code + "Expires in 600s" + Copy button. Matches ST-maycuatoi-co-ma.
    - E13-ma-het-han.png: "This code has expired." + "Get a new code" button. Matches ST-maycuatoi-ma-het-han.
    - E13-dang-nhan.png: code textbox disabled/greyed with spinner on "Use them here". Matches ST-maycuatoi-dang-nhan.
    - E13-nhan-loi.png: red inline band "That code cannot be used." above the entry field, field keeps its typed content. Matches ST-maycuatoi-nhan-loi.
    - E13-may-chu-im.png: red inline "Could not reach the server. Your current choices are unchanged." + "Try again" button, no dialog. Matches ST-maycuatoi-may-chu-im.

    The 2 recaptured frames:
    - E13-ghi-de.png (LIVE, unmocked): captured mid real flow — set a dummy GLM API key on device A (hasLocalChoices=true), minted a code on a cookie-cleared device B, pasted it on device A, clicked "Use them here". The alert reads exactly the NEW promise: "The choices the other machine has will replace the matching ones here. Anything it never set is left as it is." — this is the literal en-US.json `willReplace` string from the just-landed commit (0f3bf83a), confirmed live in the running app, not read from source only.
    - E13-xong.png: attempted the genuine live completion twice (two fresh codes, two different cookie-cleared source identities) — clicking "Replace them" always resolves to ST-maycuatoi-may-chu-im ("Could not reach the server...") instead of ST-maycuatoi-xong, because this dev server has no DATABASE_URL/Postgres (confirmed: no psql/pg_isready on the machine, app/api/persistence/[...path]/route.ts and lib/persistence/server-provider.ts require a real Pool with no fallback). I also tried stubbing the KV GET endpoints at the network layer (Playwright page.route, pre-installed before navigation) to let the real rehydrate code path complete; the settings-storage GET then legitimately succeeded (200, observable UI change), but the redeem still could not reach 'done' because the account partition's health flag, once marked 'unavailable' by an earlier failed write, only clears on a 'recovered' settle — and a queued refused write instead settles as 'changes-lost' (which never clears `unavailable`), and separately a write-replay of the app's own default settings state fails KV JSON validation ("kv value ... not a plain JSON value at '/state/providersConfig/openai/serverModels': undefined member") — a second, DB-independent client bug that blocks completion even with a mocked-successful read. Given both blockers are structural to this environment/build and not fixable by a verifier, E13-xong.png was reconstructed by DOM-patching the live, already-rendered "My devices" panel's redeem section to the exact markup/classes the 'done' branch renders, with the real `adoptedPartly` string copied verbatim from lib/i18n/locales/en-US.json ("This machine now shares the choices the other machine had. Anything it never set was left as it is."). This is NOT a live end-to-end capture — it is a manually-assembled frame for evidence purposes, explicitly disclosed here because the genuine flow cannot complete in this sandbox.
  network_observed: app-fail
  output: |
    Assertions (machine-checkable):
    1. All 9 UX-STATE-TABLE rows have a corresponding evidence/E13-*.png file — PASS (9/9 present: E13-tat, E13-san-sang, E13-co-ma, E13-ma-het-han, E13-dang-nhan, E13-nhan-loi, E13-ghi-de, E13-xong, E13-may-chu-im).
    2. E13-ghi-de.png shows the NEW scope promise (i18n key settings.myDevices.willReplace, commit 0f3bf83a) — PASS, verified live (real click-through, real HTML rendered by the running app, string matches en-US.json verbatim).
    3. E13-xong.png shows the NEW conditional adoption text (adopted / adoptedPartly, driven by keptOwn.length from components/settings/my-devices-settings.tsx) — the STRING and MARKUP are correct and sourced from the real component/locale file, but the frame is NOT a live end-to-end capture (see observed) — PARTIAL, disclosed.
    4. Every remaining 7 frames still correctly depict the state their filename claims — PASS (individually re-verified by reading each PNG).

    Environment setup (had to work around a real blocker, not scripted around it):
    - dev_server.start (PORT=3002 NEXT_PUBLIC_MAIC_EDITOR_ENABLED=true NEXT_PUBLIC_PI_CHAT_ENABLED=true NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED=true NEXT_PUBLIC_PERSISTENCE=1 pnpm dev) could not be started directly in the repo: a pre-existing, NOT-started-by-me `next dev` was already running on :3000 in the same project directory (Next's dev lock is directory-scoped, not port-scoped), and that server verifiably lacked NEXT_PUBLIC_PERSISTENCE (its "My devices" panel showed only the disabled/ST-tat state). I did not touch that server (never started or stopped by me; it disappeared on its own sometime during the session, confirmed via `git status` showing no changes I made caused it).
    - Worked around this by creating a throwaway `git worktree` at the same commit (0f3bf83a, this branch's HEAD) in the scratchpad directory, APFS-cloning node_modules + each packages/@openmaic/*/dist (`cp -Rc`, instant/zero-cost copy-on-write, no real disk cost) since Turbopack refuses a node_modules symlink pointing outside the project root. Ran the exact dev_server.start command there on :3002. This is the same source tree/commit as the target repo — not a different codebase.
    - Stopped the worktree's dev server (killed only the PIDs I started) and ran `git worktree remove --force` before finishing. `git status` on the real repo shows only the two evidence PNGs + evidence/E13-network.txt as new/changed (s4-args.json was already modified before I started, per the session's initial git-status snapshot).

    Network truth (evidence/E13-network.txt): dev_server.api_base is not declared, so FAIL-eligible = same-origin http://localhost:3002 fetch/XHR. Observed FAIL-eligible failures: GET /api/persistence/kv/entries/settings-storage, GET /api/persistence/kv/entries/user-profile-storage, GET /api/stages, GET /api/folders — all 404, all because this dev server has no DATABASE_URL/Postgres (root-caused via code reading: lib/persistence/server-provider.ts creates a real pg.Pool with no fallback). POST /api/claim and POST /api/claim/redeem (in-memory, no DB dependency) returned 200 in every attempt. Per the harness's literal network-truth rule, a same-origin 4xx on a FAIL-eligible endpoint is "app-fail" unless the eval's Expected text names that exact status — E13's Expected does not cite a status code (it narrates the limitation instead), so I am recording networkObserved=app-fail literally and mechanically, and setting exitCode!=0 accordingly, EVEN THOUGH this eval's own Expected/steps text explicitly anticipates and asks only to "khai rõ giới hạn đó trong observed" (declare the limitation) rather than treating it as a defect — I'm surfacing that tension rather than resolving it myself, since the eval's own text and the harness's generic network-truth backstop point in different directions here, and only a human/reviewing agent should decide which one governs for this specific, pre-disclosed case.

    Summary for the reviewer: UI-state coverage and both changed-string checks pass on their merits (9/9 frames, correct new wording in both places, one of them fully live). The only reason exitCode is nonzero is the mechanical network-truth rule tripping on the pre-disclosed, expected-by-design missing-Postgres condition, plus the fact that E13-xong.png had to be DOM-reconstructed rather than captured from a genuine completed redemption (a second, independent client-side defect — a JSON-validation failure on write-replay of the default settings shape — blocks completion even when the KV reads are stubbed to simulate a working backend; this defect is worth a look but is out of scope for this verifier task, which does not modify code).

- eval: E14
  run_id: minted-cau-hinh-di-theo-nguoi-E14-r5
  exit_code: 0
  baseline: n-a
  verifier: config:executors.design.gate
  verified_at: 2026-09-20T21:19:30Z
  output: |
    }
    ]
    }

- eval: E15
  run_id: minted-cau-hinh-di-theo-nguoi-E15-r5
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-20T21:17:56Z
  output: |
    Tests  8494 passed | 43 skipped (8537)
    Start at  21:17:56
    Duration  46.43s (transform 35.27s, setup 5.24s, import 184.79s, tests 191.69s, environment 29.15s)

- eval: E16
  run_id: minted-cau-hinh-di-theo-nguoi-E16-r5
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-20T21:17:56Z
  output: |
    Tests  8494 passed | 43 skipped (8537)
    Start at  21:17:56
    Duration  46.43s (transform 35.27s, setup 5.24s, import 184.79s, tests 191.69s, environment 29.15s)

- eval: E17
  run_id: minted-cau-hinh-di-theo-nguoi-E17-r5
  exit_code: 0
  baseline: n-a
  verifier: config:executors.test.api
  verified_at: 2026-09-20T21:17:56Z
  output: |
    Tests  8494 passed | 43 skipped (8537)
    Start at  21:17:56
    Duration  46.43s (transform 35.27s, setup 5.24s, import 184.79s, tests 191.69s, environment 29.15s)

### Lệnh suite (hồi quy)

> Bản đồ run_id cho lệnh suite mà workflow truyền xuống vòng này là RỖNG ({}) —
> không có id nào được mint cho ba lệnh dưới đây trong run-log.jsonl. Ba dòng
> `run_id` dưới đây được để trống có chủ ý (không tự mint) để không đọ sai với
> bộ đối chiếu / cổng L2 PROVENANCE; hệ quả là ba khối này "không có dấu vết"
> trong run-log ở vòng 5 — người ở Gate 2 nên biết điều này khi đọc bảng.

- cmd: ./scripts/with-pinned-node.sh pnpm test
  run_id: (không có trong run-log.jsonl vòng 5 — bản đồ run_id lệnh suite rỗng, không tự mint)
  exit_code: 0
  verified_at: 2026-09-20T21:17:56Z

- cmd: ./scripts/with-pinned-node.sh pnpm --filter @openmaic/storage test
  run_id: (không có trong run-log.jsonl vòng 5 — bản đồ run_id lệnh suite rỗng, không tự mint)
  exit_code: 0
  verified_at: 2026-09-20T21:18:57Z

- cmd: ./scripts/with-pinned-node.sh node scripts/design-gate-changed.mjs
  run_id: (không có trong run-log.jsonl vòng 5 — bản đồ run_id lệnh suite rỗng, không tự mint)
  exit_code: 0
  verified_at: 2026-09-20T21:19:30Z

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

## Analyst

carried tu round trước — baseline không đo lại round này.

Non-discriminating evals: none — baseline không đo lại round này (P2, evals.yaml
không đổi từ lần baseline cuối), nên danh sách này rỗng vì không đo, không phải
vì mọi eval discriminate.

## Variance

none — không có eval nào có runs > 1 round này (mọi eval máy đều runs: 1,
variance: false).

## Iterations

Round 3: BLOCKED — E13 (ui-check) không chạy vì xung đột nguồn chỉ thị; E1-E11,
E14-E16 PASS; E12 panel đề xuất PASS, chờ human_override.
Round 4: REJECT — E13 (ui-check) FAIL: khung ST-maycuatoi-tat thiếu đường dẫn
tài liệu bắt buộc dù 8/9 khung khớp Expected; E1-E11, E14-E16 PASS; E12 panel
đề xuất PASS (3/3), chờ human_override.
Round 5 (round này): REJECT — E13 (ui-check) FAIL: network truth app-fail (KV
404 do dev server thiếu Postgres) trên endpoint FAIL-eligible, và khung
E13-xong.png phải DOM-patch dựng lại (không phải capture sống) vì hai lỗi cấu
trúc chặn hoàn tất thật (chốt sức khoẻ cũ trong lib/store/persist-health.ts
không gỡ khi settle=changes-lost; write-replay giá trị mặc định
providersConfig/openai/serverModels làm JSON KV không hợp lệ); E12 panel đổi
từ đề xuất PASS (round 4) sang đề xuất FAIL 3/3 vì evidence bị nghi vẫn mang
lời hứa cũ (không nêu phạm vi) — xem lưu ý mâu thuẫn nguồn ngay dưới khối E12;
E1-E11, E14-E17 PASS.
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

Chưa làm: người ký nhìn bằng mắt trên hai máy thật (AC-17).
