#!/usr/bin/env sh
# Chạy một lệnh dưới ĐÚNG bản Node kho ghim ở .nvmrc.
#
# Vì sao cần: bản Node đổi hành vi thời-gian-chạy, không chỉ cú pháp. Node 24
# có `navigator.locks`, Node 22 thì không — nên nhánh dự phòng «không có Web
# Locks» chạy trên 24 sẽ đi nhầm nhánh rồi treo, và bộ phân tích multipart của
# nền tảng cũng trả thông điệp khác. Máy của người viết code mặc định bản nào
# là chuyện của họ; bộ kiểm của kho thì không được phụ thuộc vào đó.
#
# Trong CI, setup-node đã đặt đúng bản nên lệnh chạy thẳng, không cần fnm.
# Trên máy đang để bản khác, lớp này đổi bằng fnm. Không đổi được thì DỪNG có
# tên, chứ không chạy dưới bản sai rồi báo một màu đỏ không ai giải thích nổi.
set -e

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WANT=$(tr -d '[:space:]' < "$ROOT/.nvmrc" 2>/dev/null || true)
[ -n "$WANT" ] || exec "$@"

CURRENT=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1 || true)
[ "$CURRENT" = "$WANT" ] && exec "$@"

for CANDIDATE in "$(command -v fnm 2>/dev/null || true)" /opt/homebrew/bin/fnm "$HOME/.fnm/fnm"; do
  if [ -n "$CANDIDATE" ] && [ -x "$CANDIDATE" ]; then
    exec "$CANDIDATE" exec --using "$WANT" -- "$@"
  fi
done

echo "with-pinned-node: kho ghim Node $WANT (.nvmrc), shell đang chạy Node ${CURRENT:-?}." >&2
echo "with-pinned-node: không tìm thấy fnm để đổi bản. Chạy lại dưới Node $WANT." >&2
exit 3
