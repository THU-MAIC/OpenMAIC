# E13 vòng 6 — lưu trữ

Khối bằng chứng vòng 6 (commit 787d10f1), chuyển khỏi evidence-report.md khi
vòng 7 chấm lại E13 theo thước đã ký lại ở Cổng 1 (19d7d42d). Giữ nguyên văn.

```yaml
- eval: E13
  run_id: minted-cau-hinh-di-theo-nguoi-E13-r6
  exit_code: 1
  baseline: n-a
  verifier: ui-check:E13
  verified_at: 2026-09-21T07:42:00Z
  screenshot: evidence/E13-ghi-de.png
  network_observed: app-fail
  observed: |
    Tám khung chụp SỐNG vòng này bằng Playwright (Chromium, viewport 1440x900,
    chụp khung hộp thoại Cài đặt), không khung nào dựng lại. Mỗi khung kèm
    data-state đọc từ DOM lúc chụp; đã mở từng ảnh để soi.
    - E13-san-sang.png: [data-state ST-maycuatoi-san-sang ×2] "Get a code" +
      ô "Enter the code" + "Use them here" (mờ khi ô trống).
    - E13-co-ma.png: [ST-maycuatoi-co-ma] mã thật do POST claim của máy chủ
      trả về, nút Copy, "Expires in 600s".
    - E13-ma-het-han.png: [ST-maycuatoi-ma-het-han] "This code has expired." +
      "Get a new code". Cách dựng: mã thật từ máy chủ, đồng hồ TRÌNH DUYỆT tua
      nhanh 10:05 bằng Playwright clock (máy chủ không bị động tới).
    - E13-nhan-loi.png: [ST-maycuatoi-nhan-loi] dải đỏ "That code cannot be
      used." phía trên ô nhập, ô giữ nội dung đã gõ. Mã sai gửi thật tới máy
      chủ, máy chủ từ chối.
    - E13-dang-nhan.png: [ST-maycuatoi-dang-nhan] ô nhập bị khoá, vòng quay
      trên "Use them here". Cách dựng: giữ yêu cầu redeem thật 4 giây ở tầng
      mạng rồi cho đi tiếp tới máy chủ (route.continue) — nội dung không giả.
    - E13-ghi-de.png: [ST-maycuatoi-se-ghi-de] "The choices the other machine
      has will replace the matching ones here. Anything it never set is left as
      it is." + "Replace them" / "Cancel". Máy C đặt khoá API GLM giả qua giao
      diện rồi nhập mã sống của máy A.
    - E13-may-chu-im.png: [ST-maycuatoi-may-chu-im] dải đỏ "Could not reach the
      server. Your current choices are unchanged." + "Try again", không hộp
      thoại. Cách dựng: chặn đường tới máy chủ bằng route.abort
      (connectionrefused) trên POST claim, đúng bước eval "chặn đường tới máy chủ".
    - E13-tat.png: [ST-maycuatoi-tat] "Your choices are stored on this machine.
      Turn on server-backed persistence to carry them to another machine.",
      không nút. Chụp trên một máy chủ phát triển THỨ HAI cùng HEAD (worktree
      tạm, cổng khác, NEXT_PUBLIC_PERSISTENCE bỏ trống) — cờ NEXT_PUBLIC nung
      lúc biên dịch nên không đổi được trên máy chủ đang chạy; worktree đã gỡ.
    Bảy khung đầu có một toast lỗi đè mép trên ("...made while it was
    unavailable could not be saved and have been replaced by the last saved
    version") — đó là phản ứng thật của sản phẩm khi ngăn account trả
    PERSISTENCE_NOT_CONFIGURED (môi trường không có cơ sở dữ liệu), không che
    phần nội dung của mục «Máy của tôi».
    Máy chủ :3002 dùng lại tiến trình đã chạy sẵn (cwd = repo, env khớp đúng
    dev_server.start, kiểm bằng ps eww) — không khởi động lại.
    evidence/E13-xong.png còn nằm trong thư mục là bản DOM-dựng-lại của vòng 5;
    vòng này KHÔNG dùng nó làm bằng chứng — trạng thái đó thuộc AC-17.
  output: |
    Khung: 8/8 có mặt, 8/8 sống, 8/8 khớp đúng trạng thái tên file — phần
    khung ĐẠT.
    Network truth (evidence/E13-network.txt; api_base không khai nên
    FAIL-eligible = fetch/XHR same-origin http://localhost:3002):
    - GET kv/entries/settings-storage và kv/entries/user-profile-storage,
      GET /api/stages, GET /api/folders: not-found trên MỌI lần nạp trang —
      mã lỗi PERSISTENCE_NOT_CONFIGURED / agent runtime chưa cấu hình, vì máy
      đo không có DATABASE_URL.
    - POST claim/redeem với mã sai: unauthorized — đây là hành vi thiết kế
      (AC-5), nhưng Expected của E13 không khai trạng thái này.
    - POST claim bị chặn (connection refused) — do chính bước eval gây ra ở tầng
      trình điều khiển để dựng -may-chu-im; không tính là lỗi app.
    Luật kit (eval-executors.md): trong FAIL-eligible, "4xx fails unless the
    eval's expected declares that exact status". Expected của E13 không khai
    trạng thái nào → network_observed = app-fail → exit_code 1 → E13 FAIL.
    Đây cùng lý do network-truth của vòng 5; lần thu hẹp AC-13 (bỏ -xong) đã
    gỡ lý do thứ hai (khung dựng lại) nhưng KHÔNG đổi Expected về mạng.
    Cách gỡ nằm ở phía người, không ở sản phẩm: Expected của E13 khai rõ các
    trạng thái not-found (PERSISTENCE_NOT_CONFIGURED) và unauthorized (mã bị
    từ chối) là chấp nhận được trong môi trường không cơ sở dữ liệu — một thay
    đổi evals.yaml cần duyệt lại ở Gate 1 — hoặc người ghi human_override cho E13.
```
