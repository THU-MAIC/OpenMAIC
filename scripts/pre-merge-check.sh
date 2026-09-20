#!/usr/bin/env bash
# pre-merge-check.sh — CI gate for the Acceptance-Gate Kit.
#
# Usage: pre-merge-check.sh [repo_root] [--slug <slug>]... [--base <ref>] [--no-t1-escape]
#        pre-merge-check.sh ... [--recheck-all]
#
# --recheck-all: re-check the committed evidence of EVERY slug, including those
# outside the PR diff. Without it the re-check rule is scoped to slugs the PR
# touches (see RECHECK-DIFF-SCOPE-GUARD below). Use it after raising the bar in
# lib/evidence-core.cjs, to re-measure the whole archive against the new bar.
#
# --no-t1-escape: turn off ONLY the T1-escape backstop for push-event runs
# (commits landing directly on the main branch have no PR premise); every other
# rule still runs, and the run prints a NOT ENFORCED marker plus a declared-off
# ledger line so the off state is visible, never silent.
#
# --base <ref> (or env PRE_MERGE_BASE): the PR base for the T1-escape
# backstop — changed files matching risk_tiers.t3_paths, or falling outside
# t1_skip_globs, require the PR to carry _acceptance/<slug>/ artifacts.
# Without a base the backstop is skipped with a NOTE (wire it in CI, e.g.
# GitHub Actions: --base "origin/$GITHUB_BASE_REF").
#
# For every feature in _acceptance/ whose contract has status
# implemented|verified|signed-off and risk_tier T2|T3:
#   (machine-cleared — ô kết làn V — cũng đã arm, xem case bên dưới)
#   - Gate 1 was recorded: approved_by non-empty, or gate1_skipped: true
#     (the audited escape hatch — NOTEd, not blocked)
#   - evidence-report.md must exist
#   - overall verdict must be PASS
#   - the PASS was actually gated: bypass_used not true (unless a human
#     recorded bypass_ack) and enforcement_mode not off (warn only warns)
#   - human_signoff must be non-empty
#   - the evidence is not STALE: when the report carries verified_commit
#     (the tree the verifier actually ran on), no non-gate file — outside
#     _acceptance/ and not matching risk_tiers.t1_skip_globs — may have
#     changed since that commit (committed or in the working tree). A report
#     without verified_commit (older template) only gets a NOTE.
#   - (recheck: strict) the committed evidence still passes the gate's own
#     L1/L2/L3 bar, re-checked via scripts/recheck-evidence.cjs + lib/evidence-core.cjs
#     (the same core the hook runs) — catches a report hand-edited after the
#     write-time hook, or written under ACCEPTANCE_GATE_BYPASS. Default `warn`
#     only advises (so legacy reports from older templates don't block adopters);
#     `off` skips it. Set `recheck: strict` in _acceptance/config.yaml to enforce.
# Exits 1 listing violations; 0 when clean. T1 and draft/approved
# (pre-implementation) features are out of scope.
set -u

# Đếm vi phạm — khởi tạo NGAY ĐẦU, trước mọi khối có thể tăng nó. Bản trước khởi
# tạo mãi ở giữa file trong khi khối kiểm config phía trên đã `violations+1`:
# dưới `set -u` đó là lỗi shell CHÍ MẠNG, script chết giữa chừng và thoát 0 —
# một typo trong config.yaml giết TOÀN BỘ cổng (signoff, verdict, staleness,
# bypass, T1-escape) mà CI vẫn xanh. Đúng thứ false-green kit sinh ra để chặn.
violations=0
# Bật khi lưới giữ-chỗ nổ ít nhất một lần; dùng để in ĐÚNG MỘT dòng cảnh báo
# về phạm vi hẹp của chính lưới đó ở cuối lần chạy.
NARROW_NET_SEEN=""
# Lưới giữ-chỗ KHÔNG chạy được (thiếu node / thiếu lib/evidence-core.cjs / lib lỗi).
# Nói ra ở cuối lượt: một luật im lặng không chạy là luật không còn.
NARROW_NET_BLIND=""
# Bật khi răng cross-layer phải chấm bằng khuôn awk nội bộ vì thiếu node hoặc
# lib/ac-line.cjs. Răng VẪN chạy (awk rộng hơn nên không rụng dòng nào), nhưng đó
# là một định nghĩa "dòng criterion" khác với ba consumer JS — in đúng một dòng ở
# cuối lần chạy để chỗ lệch có tiếng, thay vì âm thầm như trước.
AC_LINE_FALLBACK_SEEN=""

# CI evidence re-checker shipped alongside this script (needs ../lib/evidence-core.cjs).
HERE="$(cd "$(dirname "$0")" && pwd)"
RECHECK="$HERE/recheck-evidence.cjs"

ROOT="."
SLUGS=()
# PRE_MERGE_BASE set-nhưng-RỖNG khác với không-set: không-set là bỏ-qua-có-tín-
# hiệu hợp lệ (NOTE + declared-off), còn set-rỗng nghĩa là CI ĐÃ nối dây phạm
# vi mà dây đứt (biến chưa có giá trị, command substitution chết im). Rơi về
# nhánh skip là khai-rồi-mà-như-không-khai — cùng lớp với --base thiếu giá trị.
# CHỈ ghi CỜ ở đây, phán SAU vòng parse: cờ --base tường minh override env theo
# convention chung, nên env-rỗng chỉ đáng nổ khi giá trị rỗng đó THẬT SỰ được
# dùng (không có --base) — bản đầu nổ trước vòng parse làm
# `PRE_MERGE_BASE="" ... --base <ref thật>` đỏ oan kèm gợi ý sửa trỏ sai chỗ
# (S4 round 8 của gap-probe bắt được, kèm repro).
PMB_SET_EMPTY=0
[ "${PRE_MERGE_BASE+x}" = "x" ] && [ -z "$PRE_MERGE_BASE" ] && PMB_SET_EMPTY=1
BASE="${PRE_MERGE_BASE:-}"
# Răng T1-escape bật mặc định. Opt-OUT chứ không phải opt-in `--pr`: acceptance-init
# đang dạy consumer truyền đúng `--base`, nên opt-in sẽ làm răng tắt IM LẶNG trên
# mọi repo tiêu thụ đang chạy — biến một sửa lỗi thành lỗ fail-open hàng loạt.
T1_ESCAPE=1
RECHECK_ALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --slug)
      [ $# -ge 2 ] || { echo "pre-merge-check: --slug requires a value" >&2; exit 2; }
      case "$2" in -*) echo "pre-merge-check: --slug requires a value (got option $2)" >&2; exit 2 ;; esac
      # Giá trị RỖNG cùng lớp với thiếu giá trị: lọc theo slug rỗng thì không
      # thư mục nào khớp, mọi slug bị bỏ qua mà vẫn `clean` — khai-lọc-rỗng
      # phải nổ to (nợ chip 33ca1add, cùng doctrine với --base rỗng bên dưới).
      [ -n "$2" ] || { echo "pre-merge-check: --slug requires a value (got empty string — a CI variable is unset or a command substitution failed)" >&2; exit 2; }
      SLUGS+=("$2"); shift 2 ;;
    --base)
      [ $# -ge 2 ] || { echo "pre-merge-check: --base requires a value" >&2; exit 2; }
      # Quên giá trị thì `--base --no-t1-escape` nuốt cờ kế làm ref: base không
      # bao giờ resolve, răng T1-escape lẫn gap-probe cùng bỏ qua, script in
      # `clean` và thoát 0. Chốt `-*` ở trên chỉ phủ positional, không phủ GIÁ TRỊ.
      case "$2" in -*) echo "pre-merge-check: --base requires a value (got option $2)" >&2; exit 2 ;; esac
      # Giá trị RỖNG — kiểu CI `--base "$VAR"` với VAR unset, hoặc
      # `--base "$(git rev-parse ...)"` mà lệnh con chết im dưới bash -e của
      # GithubActions. Bản cũ rơi về nhánh "no PR base given": gap-probe lẫn
      # T1-escape cùng declared-off và repo sạch thoát 0 — operator ĐÃ khai
      # phạm vi mà cổng chạy như không khai. Doctrine ADR 0004/0006: đã khai
      # thì không xác định được phạm vi là exit 2, không phải skip.
      [ -n "$2" ] || { echo "pre-merge-check: --base requires a value (got empty string — a CI variable is unset or a command substitution failed; drop --base entirely to run without a diff scope)" >&2; exit 2; }
      BASE="$2"; shift 2 ;;
    --no-t1-escape)
      # Không nhận tham số — `reason` là hằng, giữ ranh giới "không thêm cờ nào khác".
      T1_ESCAPE=0; shift ;;
    --recheck-all)
      # Ép re-check TOÀN BỘ hồ sơ, kể cả ngoài phạm vi diff. Đây là đường CỨU
      # cho cái mà việc thu phạm vi làm mất: thước thôi hồi tố. Siết bar trong
      # `lib/evidence-core.cjs` xong thì chạy một lượt có cờ này để đo lại cả
      # kho theo thước mới — không có nó, "hồ sơ cũ không bao giờ bị đo lại"
      # là mất vĩnh viễn, không phải mất tạm.
      RECHECK_ALL=1; shift ;;
    -*)
      # `-*` chứ không phải `--*`: một gạch cũng là lỗi gõ, và bản chỉ bắt hai
      # gạch để lọt `-no-t1-escape` y nguyên. Nuốt cờ lạ vào ROOT là fail-open
      # chí tử — ROOT sai → không thấy _acceptance/ → thoát 0 mà KHÔNG chạy
      # luật nào. Từ khi kit dạy consumer chép tay cờ vào CI, một lỗi gõ là đủ.
      echo "pre-merge-check: unknown option $1" >&2; exit 2 ;;
    *)
      # Positional thứ hai cũng là lỗi gõ (vd `pre-merge-check.sh . extra` âm
      # thầm đổi ROOT sang `extra`), và ROOT không tồn tại thì phải nổ chứ
      # không được đi tiếp để rơi vào nhánh "nothing to check".
      [ -n "${ROOT_SET:-}" ] && { echo "pre-merge-check: unexpected argument $1" >&2; exit 2; }
      [ -d "$1" ] || { echo "pre-merge-check: root not a directory: $1" >&2; exit 2; }
      ROOT="$1"; ROOT_SET=1; shift ;;
  esac
done

# Phán quyết env-rỗng (cờ ghi ở đầu file): tới đây BASE còn rỗng nghĩa là không
# có --base nào override — giá trị đứt dây của CI sắp được DÙNG thật, nổ to.
if [ "$PMB_SET_EMPTY" -eq 1 ] && [ -z "$BASE" ]; then
  echo "pre-merge-check: PRE_MERGE_BASE is set but empty — a CI variable expansion failed (unset it to run without a diff scope, or give a real ref via PRE_MERGE_BASE or --base)" >&2
  exit 2
fi

# ─── Sổ luật-đã-chạy (rules ledger) ─────────────────────────────────────────
# `clean` phải được CHỨNG MINH, không phải mặc định: mọi khối luật ghi sổ qua
# ledger_mark; điểm nghẽn trước kết luận so EXPECTED với sổ HAI CHIỀU. Lệch =
# lỗi NỘI TẠI của cổng -> exit 2, không phải violation của feature. EXPECTED
# là danh sách ĐÓNG, CỐ ĐỊNH, không phụ thuộc config — thêm khối luật mới
# PHẢI thêm tên vào đây (suite P48 + RL7a canh hai chiều bằng máy).
LEDGER_EXPECTED="per-slug gap-probe t1-escape veto-trace"
# set -- xoá positional params — hợp lệ vì đứng SAU vòng parse args ở trên.
set -- $LEDGER_EXPECTED
LEDGER_K=$#
LEDGER_ENABLED=1
LEDGER_RAN=""; LEDGER_OFF=""; LEDGER_RAN_N=0; LEDGER_OFF_N=0
ledger_mark() { # <ran|declared-off> <tên>
  [ "$LEDGER_ENABLED" -eq 1 ] || return 0
  case "$1" in
    ran)          LEDGER_RAN="${LEDGER_RAN}${2} "; LEDGER_RAN_N=$((LEDGER_RAN_N+1)) ;;
    declared-off) LEDGER_OFF="${LEDGER_OFF}${2} "; LEDGER_OFF_N=$((LEDGER_OFF_N+1)) ;;
  esac
  echo "$1 $2"
}
ledger_count() { # <tên> — số lần tên xuất hiện trong sổ. Thuần bash có chủ
  # đích: chokepoint không được phụ thuộc binary ngoài, vì trạng thái
  # node-vắng (AC-12) phải đi qua nó mà không tự phá sổ.
  local c=0 w
  for w in $LEDGER_RAN $LEDGER_OFF; do [ "$w" = "$1" ] && c=$((c+1)); done
  echo "$c"
}

# lib dùng chung — CÙNG file mà scripts/gate-card.js require. pre-merge chỉ còn
# đọc config, xác định phạm vi diff, in ấn và đếm; LUẬT nằm trong lib. Bản awk
# cũ đã lệch thật: một dòng JSON hỏng mở được van thoát ở bash trong khi thẻ
# Cổng 1 loại nó (AC-13). Parity giữ bằng comment là parity không có răng.
GP_LIB="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/lib/gap-probe.cjs"

ACC="$ROOT/_acceptance"
if [ ! -d "$ACC" ]; then
  # Có --slug nghĩa là operator KHAI một bộ lọc — không có gì để lọc thì phải
  # nổ, không phải "nothing to check" xanh (cùng lớp bộ-lọc-khai-mà-rỗng dưới).
  if [ ${#SLUGS[@]} -gt 0 ]; then
    echo "pre-merge-check: --slug given but no _acceptance/ under $ROOT — a declared filter with nothing to filter must not green the gate" >&2
    exit 2
  fi
  echo "pre-merge-check: no _acceptance/ — nothing to check"; exit 0
fi
# Bộ lọc --slug khai một tên KHÔNG khớp thư mục nào = cùng hình dạng với giá
# trị rỗng (chip 33ca1add) mà round 9 chỉ ra tôi quét sót: vòng per-slug bỏ qua
# mọi thư mục, không luật nào soi feature nào, sổ vẫn ghi `ran per-slug` (đếm
# thư mục TRƯỚC bộ lọc) và script in `clean` — một slug gõ sai trong CI làm
# cổng xanh vĩnh viễn. Lọc theo tên thư mục nên kiểm tra tương đương là -d.
if [ ${#SLUGS[@]} -gt 0 ]; then
  for _s in "${SLUGS[@]}"; do
    # Vòng lặp per-slug so BẰNG với `basename` của thư mục, nên giá trị chứa
    # `/` hay là `.`/`..` KHÔNG BAO GIỜ khớp basename nào — nhưng lại qua được
    # phép thử -d bên dưới (`feat-x/`, `.`, `..` đều là "thư mục có thật").
    # Round 7 bắt đúng lỗ này trong guard vừa thêm: kiểm phải cùng ngữ nghĩa
    # với bộ lọc thật, không phải một phép thử gần giống.
    case "$_s" in
      */*|.|..)
        echo "pre-merge-check: --slug $_s is not a plain slug name (slashes, . and .. can never match a slug directory basename — a declared filter that matches nothing must not green the gate)" >&2
        exit 2 ;;
    esac
    [ -d "$ACC/$_s" ] || { echo "pre-merge-check: --slug $_s matches no directory under _acceptance/ (typo? a declared filter that matches nothing must not green the gate)" >&2; exit 2; }
  done
fi

# Which tiers need a signed report before merge — from consumer config when
# present (signoff.required_for), defaulting to T2+T3.
REQUIRED_FOR="T2 T3"
# Mode luật gap-probe. Mặc định `advisory`: bỏ qua phản biện phải THẤY ĐƯỢC,
# nhưng bật kit lên không được chặn merge của repo chưa kịp làm quen. `off` là
# im hoàn toàn; `required` là chặn.
GAP_PROBE_MODE="advisory"
# Committed-evidence re-check mode: strict (block) | warn (advise, default) | off.
# Default warn so adopting the re-check never blocks merges over reports written by
# an OLDER evidence template — a repo opts into strict once its reports meet the bar.
RECHECK_MODE="warn"
# t1_skip_globs (newline-separated): file changes matching these — or living
# under _acceptance/ — do not stale the evidence (docs and gate artifacts).
# t3_paths: critical paths — the T1-escape backstop flags them hardest.
T1_GLOBS=""
T3_PATHS=""
# Human-signoff provenance knobs (signoff.*): require_human_commit demands the
# signature land in its own human-fields-only commit; agent_authors is an
# email-glob blocklist for the signoff commit's author.
REQ_HUMAN_COMMIT=""
AGENT_AUTHORS=""
LEGACY_SIGN_KNOB=0
if [ -f "$ACC/config.yaml" ]; then
  cfg_req="$(sed -n 's/^[[:space:]]*required_for:[[:space:]]*//p' "$ACC/config.yaml" | head -1 | sed 's/[[:space:]]*#.*$//')"
  [ -n "$cfg_req" ] && REQUIRED_FOR="$cfg_req"
  # `enforcement` là khoá DUY NHẤT mà hook (write-time) và pre-merge (merge
  # boundary) CÙNG đọc, nên nó là chỗ duy nhất hai parser có thể bất đồng — và
  # mọi bất đồng đều cùng một hình dạng fail-open: hook giữ `strict` (enforce
  # đầy đủ, không ai nghi ngờ) trong khi sổ ở pre-merge tắt IM LẶNG.
  #
  # Vì thế grep dưới đây nhân bản TRỌN VẸN regex của hook
  # (`/^enforcement\s*:\s*(strict|warn|off)\s*(?:#.*)?$/m`) theo TỪNG chiều,
  # thay vì chuẩn hoá giá trị rồi so — hai round vá kiểu chuẩn-hoá đều để hở
  # một chiều (round 1: hoa/thường; round 2: nháy; round 3 review vẫn bắt được
  # chiều space-trước-dấu-hai-chấm và dòng-trùng-khoá). Các chiều:
  #   - `[[:space:]]*` quanh dấu `:` = `\s*` của hook (cả tab);
  #   - token đúng chữ thường, không nháy — `OFF`/`"off"` trượt Ở CẢ HAI BÊN;
  #   - đuôi chỉ được khoảng trắng + chú thích `#` — khớp `\s*(?:#.*)?$`;
  #   - NHIỀU dòng cùng khoá: hook match dòng ĐẦU TIÊN thoả trọn pattern (dòng
  #     giá-trị-rác không thoả nên bị nhảy qua) — grep + head -1 cho đúng thế.
  # Bảng parity RL11c đo cả hai bên trên CÙNG chuỗi; regex hook đọc từ nguồn.
  # Các khoá còn lại (`gap_probe`, `recheck`, ...) chỉ pre-merge đọc, độ rộng
  # khác nhau ở đó KHÔNG tạo bất đồng hai lớp.
  cfg_enf="$(grep -E '^enforcement[[:space:]]*:[[:space:]]*(strict|warn|off)[[:space:]]*(#.*)?$' "$ACC/config.yaml" \
    | head -1 | sed -e 's/^enforcement[[:space:]]*:[[:space:]]*//' -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//')"
  # off là off toàn cục (tiền lệ hook) — sổ luật tắt theo, không dòng nào
  # (AC-11); warn/strict/không-khớp đều GIỮ sổ bật.
  case "$cfg_enf" in off) LEDGER_ENABLED=0 ;; esac
  cfg_gp="$(sed -n 's/^[[:space:]]*gap_probe:[[:space:]]*//p' "$ACC/config.yaml" | head -1 \
    | sed -e 's/[[:space:]]*#.*$//' -e 's/^["'"'"']//' -e 's/["'"'"']$//' -e 's/[[:space:]]*$//' \
    | tr '[:upper:]' '[:lower:]')"
  if [ -n "$cfg_gp" ]; then
    case "$cfg_gp" in
      required|advisory|off) GAP_PROBE_MODE="$cfg_gp" ;;
      *)
        # KHÔNG âm thầm rơi về mặc định: một cổng tự tắt vì sai chính tả đúng là
        # false-green mà luật này sinh ra để chặn.
        echo "VIOLATION [config]: gap_probe: \"$cfg_gp\" không phải mode hợp lệ — dùng required | advisory | off (khoá vắng = advisory)"
        violations=$((violations+1))
        # KHÔNG rơi về advisory: cổng đã chặn bằng VIOLATION trên, nên chạy luật
        # gap-probe theo một mode ĐOÁN chỉ tạo tín hiệu sai. "Cảnh báo rồi vẫn
        # advisory" là fail-open có tiếng động — vẫn là fail-open (AC-11 v3-r2).
        GAP_PROBE_MODE="off" ;;
    esac
  fi
  cfg_rc="$(sed -n 's/^[[:space:]]*recheck:[[:space:]]*//p' "$ACC/config.yaml" | head -1 | sed 's/[[:space:]]*#.*$//')"
  case "$cfg_rc" in strict|warn|off) RECHECK_MODE="$cfg_rc" ;; esac
  # Đọc danh sách config qua MỘT nguồn luật (lib/workspace-record.cjs
  # configList) khi có node — bản sed chỉ còn là fallback cho máy thiếu node.
  # Hai bản đọc từng lệch ở hình dạng key-line-comment (bug round 16
  # product-map-uat-session): bản sed đọc được, bản JS trả rỗng — giữ hai bản
  # ngang hàng là giữ chỗ cho lần lệch kế tiếp (AC-1 workspace-reader-unification;
  # quan hệ hai-bản-đồng-kết-luận vẫn do case P130 ghim).
  WSREC_LIB="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/lib/workspace-record.cjs"
  config_list() {
    if [ -f "$WSREC_LIB" ] && command -v node >/dev/null 2>&1; then
      _cl_out="$(node -e 'const l=require(process.argv[1]);const fs=require("fs");process.stdout.write(l.configList(fs.readFileSync(process.argv[2],"utf8"),process.argv[3]).join("\n"))' "$WSREC_LIB" "$ACC/config.yaml" "$1" 2>/dev/null)" && { printf '%s\n' "$_cl_out"; return; }
    fi
    sed -n "/^  $1:/,/^  [a-zA-Z0-9_-]*:/p" "$ACC/config.yaml" \
      | sed -n 's/^[[:space:]]*-[[:space:]]*//p' \
      | sed -e 's/[[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" -e 's/[[:space:]]*$//'
  }
  T1_GLOBS="$(config_list t1_skip_globs)"
  T3_PATHS="$(config_list t3_paths)"
  REQ_HUMAN_COMMIT="$(sed -n 's/^[[:space:]]*require_human_commit:[[:space:]]*//p' "$ACC/config.yaml" | head -1 | sed 's/[[:space:]]*#.*$//' | tr '[:upper:]' '[:lower:]')"
  AGENT_AUTHORS="$(sed -n '/^  agent_authors:/,/^  [a-zA-Z0-9_-]*:/p' "$ACC/config.yaml" \
    | sed -n 's/^[[:space:]]*-[[:space:]]*//p' \
    | sed -e 's/[[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" -e 's/[[:space:]]*$//')"
fi
if [ "$RECHECK_MODE" = "warn" ]; then
  # A disabled backstop must be impossible to miss: in warn mode a report
  # hand-edited AFTER the write-time hook only produces a NOTE — it does not
  # block the merge.
  echo "WARNING: committed-evidence re-check is ADVISORY ONLY (recheck: warn) — a hand-edited PASS report will NOT block merge. Set 'recheck: strict' in _acceptance/config.yaml to enforce the backstop."
fi

fm_field() { # <file> <key> — first frontmatter-style "key: value" line, normalized:
  # trailing #-comments, surrounding quotes, and trailing whitespace stripped
  # (mirrors the hook's tolerance for quotes/comments on these lines).
  sed -n "s/^${2}:[[:space:]]*//p" "$1" | head -1 \
    | sed -e 's/[[:space:]]*#.*$//' -e 's/^["'"'"']//' -e 's/["'"'"']$//' -e 's/[[:space:]]*$//'
}

# Vết giờ của làn V phải PARSE ĐƯỢC, không chỉ khác rỗng (cùng luật với hook
# `vetoGateState`): một chuỗi rác lọt qua thì NOTE đếm cửa-veto mất khả năng
# đọc «cửa này mở bao lâu rồi».
date_parseable() { # <chuỗi>
  [ -n "$1" ] || return 1
  if command -v node >/dev/null 2>&1; then
    node -e 'process.exit(Number.isNaN(Date.parse(process.argv[1]))?1:0)' "$1" 2>/dev/null && return 0
    return 1
  fi
  printf '%s' "$1" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$'
}

# ── Bộ kiểm SÁU ĐIỀU KIỆN xanh-sạch (đợt 2) — MỘT bản, hai chỗ gọi ─────────
# Trước hồ sơ cong-chan-nham-cho khối này nằm inline trong luật chữ-ký-rỗng.
# Luật Gate-1 (làn V) cần ĐÚNG bộ kiểm ấy, nên nó được rút thành hàm thay vì
# chép: hai bản «sáu điều kiện» trôi khỏi nhau là lớp lỗi bên-viết-bên-đọc.
# Đặt CLEAN_WHY khi không sạch; trả 0 = sạch, 1 = không.
xanh_sach_check() { # <report path>
  local report="$1" clean_ok=1 clean_why="" _cdir _tier _sec _body _v _bp _ack
  CLEAN_WHY=""
  [ -f "$report" ] || { CLEAN_WHY="không có evidence-report.md"; return 1; }
  # SÁU điều kiện, khai đủ ở ĐÂY (không dựa vào chốt nào chạy trước): hai chỗ
  # gọi hàm này đứng ở hai vị trí khác nhau trong luồng, nên hàm phải tự đủ.
  _v="$(front_field "$report" verdict)"
  [ "$_v" = "PASS" ] || { clean_ok=0; clean_why="verdict=$_v (chỉ PASS mới xanh-sạch)"; }
  if [ "$clean_ok" -eq 1 ]; then
    _bp="$(front_field "$report" bypass_used | tr '[:upper:]' '[:lower:]')"
    _ack="$(front_field "$report" bypass_ack)"
    case "$_bp" in true|1|yes) clean_ok=0; clean_why="bypass_used=$_bp${_ack:+ (có bypass_ack)}" ;; esac
  fi
  # enforcement_mode: off — dieu kien thu BA cua khoi EVIDENCE-XANH-SACH-BLOCK. Ban mjs
  # (xanhSach) da kiem tu dau; ban bash truoc day KHONG, nen hai be mat tra loi khac nhau
  # ve cung mot ho so, va rang cua machine-cleared / lan V coi mot bao cao ghi luc cong
  # KHONG LAM GI la xanh-sach (finding S4-r1). Them o day, giu dung thu tu cua khoi.
  if [ "$clean_ok" -eq 1 ]; then
    local _enf
    _enf="$(front_field "$report" enforcement_mode | tr '[:upper:]' '[:lower:]')"
    case "$_enf" in off) clean_ok=0; clean_why="enforcement_mode=off (cong khong lam gi luc ghi)" ;; esac
  fi
  _cdir="$(dirname "$report")"
  _tier="$(front_field "$_cdir/contract.md" risk_tier | tr '[:lower:]' '[:upper:]')"
  if [ "$clean_ok" -eq 1 ] && [ "$_tier" != "T2" ]; then
    clean_ok=0; clean_why="hạng $_tier (chỉ T2 được đi tiếp không ký)"
  fi
  if [ "$clean_ok" -eq 1 ] && grep -qiE '(^|[^a-z])UNCERTAIN([^a-z]|$)' "$report"; then
    clean_ok=0; clean_why="có mục UNCERTAIN"
  fi
  if [ "$clean_ok" -eq 1 ]; then
    for _sec in "Known limits" "Ngoài hợp đồng"; do
    # section() trả MẢNG RỖNG cho cả «tiêu đề vắng» lẫn «tiêu đề có mà
    # thân rỗng» — hai ca này phải khác nhau (vắng ≠ rỗng), nên sự hiện
    # diện của tiêu đề phải hỏi RIÊNG. Chân đỏ (4) bắt đúng chỗ này.
    _body="$(node -e '
      const {section}=require(process.argv[1]);
      const fs=require("fs");
      const t=fs.readFileSync(process.argv[2],"utf8");
      const h=process.argv[3];
      const has=t.split("\n").some(l=>/^#{2,6}\s+/.test(l)
      && l.replace(/^#{2,6}\s+/,"").trim().toLowerCase()===h.toLowerCase());
      if(!has){process.stdout.write("__VANG__");process.exit(0);}
      process.stdout.write(section(t,h).join("\n").trim()?"__CO__":"");
    ' "$ROOT/lib/md-section.cjs" "$report" "$_sec" 2>/dev/null || printf '__LOI__')"
    case "$_body" in
      __VANG__) clean_ok=0; clean_why="mục «$_sec» VẮNG khỏi báo cáo (vắng ≠ rỗng)"; break ;;
      __CO__)   clean_ok=0; clean_why="mục «$_sec» có nội dung"; break ;;
      __LOI__)  clean_ok=0; clean_why="không đọc được mục «$_sec» (fail-closed)"; break ;;
    esac
    done
  fi
  CLEAN_WHY="$clean_why"
  [ "$clean_ok" -eq 1 ]
}

front_field() { # <file> <key> — read <key> from the LEADING --- frontmatter block only
  # (tolerates leading blank lines; a body excerpt cannot poison the read, and a
  # report with NO leading frontmatter yields empty for every field — so verdict
  # reads empty and the feature is rejected rather than trusted).
  awk '!f && NF==0 {next} !f && /^---[[:space:]]*$/ {f=1; next} !f {exit} /^---[[:space:]]*$/ {exit} {print}' "$1" \
    | sed -n "s/^${2}:[[:space:]]*//p" | head -1 \
    | sed -e 's/[[:space:]]*#.*$//' -e 's/^["'"'"']//' -e 's/["'"'"']$//' -e 's/[[:space:]]*$//'
}

claims_released() { # <dir> — 0 iff thư mục TỰ NHẬN đã qua cổng.
  # Đọc bằng fm_field (BẤT KỲ dòng nào) chứ không front_field (chỉ frontmatter
  # dẫn đầu) là CỐ Ý: đây là bộ DÒ, doctrine là rộng-khi-dò/chặt-khi-nhận. Một
  # fence hỏng hoặc lệch không được phép mua lấy sự vô hình — đó đúng là thứ
  # đang cần bắt. Mọi chốt CHẤP NHẬN bên dưới vẫn dùng front_field như cũ.
  if [ -f "$1/evidence-report.md" ] \
     && [ "$(fm_field "$1/evidence-report.md" verdict)" = "PASS" ]; then
    return 0
  fi
  # Nhánh contract là thứ bản vá cục bộ của repo tiêu thụ KHÔNG có, nên nó bỏ
  # sót ca "khai signed-off mà không có evidence nào".
  if [ -f "$1/contract.md" ]; then
    case "$(fm_field "$1/contract.md" status)" in
      implemented|verified|signed-off) return 0 ;;
      machine-cleared) return 0 ;;
    esac
  fi
  return 1
}

# MỘT NGUỒN của vị từ «chữ ký thật» (đổi khuôn S4-r2). Đường dẫn suy từ vị trí
# script như các lib khác của lưới (AC_LINE_LIB, LNT_LIB, WSREC_LIB).
CHU_KY_LIB="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/lib/evidence-core.cjs"

placeholder_signoff() { # <chuỗi> — 0 iff chữ ký khớp một mẫu giữ-chỗ đã biết.
  # ĐÂY LÀ LUẬT CHỮ KÝ DUY NHẤT còn lại (ngoài chốt rỗng). Không có lớp dự
  # phòng nào phía sau: `signoff.approvers` KHÔNG được cổng đọc kể từ 1.24.0 —
  # bốn bản vá cố khớp chữ ký với allowlist đều hỏng theo một hình dạng YAML
  # hợp lệ mới, nên cả lớp bị gỡ (xem contract của premerge-unjudged-pass).
  #
  # PHẠM VI THẬT, đo được, đừng mô tả rộng hơn: khớp TIỀN TỐ với đúng 8 từ khoá
  # + 4 ký hiệu dưới đây. Mọi thứ khác ĐỀU QUA — kể cả giữ-chỗ tiếng Anh không
  # nằm trong bảng (`FIXME`, `placeholder`, `LGTM`), lời cộc lốc (`ok`, `yes`,
  # `x`, `.`), và mọi giữ-chỗ viết bằng ngôn ngữ khác (`chờ Manh gật`).
  # Khớp theo TIỀN TỐ vì chữ ký thật dẫn đầu bằng tên. LC_ALL=C để `tr` không
  # chết trên UTF-8.
  # ĐỔI KHUÔN S4-r2 (owner quyết 12/09): bảng mẫu KHÔNG còn ở đây. Nó sống MỘT
  # chỗ — `laGiuCho` trong lib/evidence-core.cjs — và hàm này hỏi nó qua node,
  # cùng nếp `lib/lop-nhin-thay.cjs classify`. Bảng bash cũ (bốn dòng `case`) đã
  # GỠ và liệt đích danh trong ALLOWED_REMOVALS của DV5: giữ nó lại là giữ đúng
  # bản-dựng-thứ-hai mà hai lượt chấm vừa bắt.
  # Không đọc được nguồn (thiếu node / thiếu lib / lib lỗi) → KHÔNG chặn, và nói
  # ra: cùng doctrine với lớp nhìn-thấy và ac-line trong chính tệp này, và ca NO2
  # của lưới thường trực ghim đúng điều đó («thiếu node: NOTE không được chặn
  # merge»). Bản đầu của lượt S4-r2 chọn fail-CLOSED ở đây và làm 6 ca đỏ —
  # chốt rỗng phía trên vẫn chặn chữ ký trống, nên đường này không im lặng cho
  # qua một hồ sơ chưa ký; nó chỉ thôi phân loại GIỮ-CHỖ khi không có bộ đọc.
  _gc="$(node "$CHU_KY_LIB" giu-cho "$1" 2>/dev/null)"
  case "$_gc" in
    1) return 0 ;;
    0) return 1 ;;
  esac
  # Engine không nạp được (thiếu node / thiếu lib / lib lỗi). Đây là luật CHẶN và
  # trước đổi khuôn nó KHÔNG cần node — nên KHÔNG được im lặng cho qua (S4-r3:
  # đo được «lib bị gỡ → exit 0, mất VIOLATION»). Bản lùi dưới đây là BẢN CHIẾU
  # của bảng ở lib, KHÔNG phải nguồn thứ hai: chân `lui-khong-engine` chạy MỌI mẫu
  # của nguồn qua chính đường này với lib đã gỡ và đòi kết luận khớp, nên hai bên
  # không trôi khỏi nhau trong im lặng. Tiền lệ cùng hình dạng: khuôn awk của
  # ac-line ở lại làm đường lùi cho máy thiếu node.
  NARROW_NET_BLIND=1
# <<<BANG-LUI-GIU-CHO
  case "$(printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]')" in
    '>'|'|'|'-') return 0 ;;
    '<'*) return 0 ;;                       # template chưa điền: "<name> <date>"
    pending*|tbd*|todo*|n/a*|none|unsigned*|waiting*) return 0 ;;
  esac
# BANG-LUI-GIU-CHO>>>
  return 1
}

# Chữ ký người ở Cổng Bằng chứng ĐÓNG cửa veto (hồ sơ cua-veto-sau-chu-ky).
# Cửa veto là đường đảo cho việc MÁY tự quyết mà người chưa nói gì; người đã
# phát ngôn rồi thì «owner chưa veto» là câu sai. Đo 11/09: 27 trên 30 tên ở
# dòng tổng của kit đã ký, media-library 3/3, floorplanstudio 1/1.
#
# Vị từ là QUAN HỆ, không phải nhãn: `status: signed-off` không đóng cửa (nhãn
# là lời khai, luật khác đã bắt nó), chữ ký giữ-chỗ cũng không — dùng lại ĐÚNG
# `placeholder_signoff` ở trên, không dựng bảng thứ hai. Chỉ đọc frontmatter DẪN
# ĐẦU qua front_field: một dòng `human_signoff:` ở THÂN báo cáo (trích khuôn)
# không phải chữ ký.
# MỘT hàm cho CẢ HAI chỗ đọc (NOTE làn V và vòng veto-trace) — hai bản trong
# cùng một file là hình dạng bên-viết-bên-đọc-trôi mà kit đã dẫm nhiều lần.
chu_ky_gia_tri() { # <đường dẫn báo cáo> — in GIÁ TRỊ chữ ký theo NGUỒN (rỗng nếu vắng)
  local _l
  _l="$(node "$CHU_KY_LIB" chu-ky-that "$1" 2>/dev/null)"
  if [ -n "$_l" ]; then printf '%s' "$_l" | cut -f3; return 0; fi
  NARROW_NET_BLIND=1
  front_field "$1" human_signoff
}

signoff_that() { # <thư mục hồ sơ> — 0 iff có chữ ký THẬT; đặt $SIGNOFF_THAT
  # ĐỔI KHUÔN S4-r2: không tự đọc frontmatter nữa. Ngữ pháp (dấu fence, luật cột,
  # cách viết khoá, bảng giữ-chỗ) sống MỘT chỗ trong lib/evidence-core.cjs; hàm
  # này hỏi nó qua node và đọc MỘT dòng tab — nếp lib/lop-nhin-thay.cjs.
  # Không đọc được nguồn → return 1 (chưa ký): cửa veto GIỮ MỞ, chiều an toàn của
  # luật này, và hồ sơ vẫn đi tiếp qua các chốt bằng chứng như thường.
  SIGNOFF_THAT=""
  [ -f "$1/evidence-report.md" ] || return 1
  local _line _signed
  _line="$(node "$CHU_KY_LIB" chu-ky-that "$1/evidence-report.md" 2>/dev/null)" || return 1
  _signed="$(printf '%s' "$_line" | cut -f1)"
  [ "$_signed" = "1" ] || return 1
  SIGNOFF_THAT="$(printf '%s' "$_line" | cut -f3)"
  return 0
}


# Mọi đường mà luật gap-probe KHÔNG chạy được đều đi qua ĐÂY. Một hàm, một
# marker, một chỗ quyết định mode — vì kênh "NOTE rồi exit 0" đã giết contract
# v1 (ledger d-114) và suýt giết v3 (gap-probe P0-2). Ở `required`, không cưỡng
# chế được nghĩa là KHÔNG cho merge: cổng không tự hạ chuẩn khi nó đang mù.
GP_NOT_ENFORCED=0
gap_probe_not_enforced() { # <lý do>
  [ "$GAP_PROBE_MODE" = "off" ] && return 0
  [ "$GP_NOT_ENFORCED" -eq 1 ] && return 0   # AC-16: ĐÚNG một dòng marker
  GP_NOT_ENFORCED=1
  echo "GAP-PROBE: NOT ENFORCED reason=$1"
  if [ "$GAP_PROBE_MODE" = "required" ]; then
    echo "VIOLATION [gap-probe]: mode required nhưng luật không cưỡng chế được — $1. Sửa nguyên nhân, hoặc hạ gap_probe xuống advisory nếu chấp nhận merge mà không có phản biện."
    violations=$((violations+1))
  else
    echo "NOTE: gap-probe không cưỡng chế được — $1 (advisory, không chặn merge)."
  fi
}

# Cùng khuôn gap_probe_not_enforced: một hàm, một marker, một chỗ quyết định.
# Hai chuỗi là HẰNG — CI grep được, và suite so bằng `grep -F` nên không ai tự
# viết cả đề lẫn đáp án. Tắt im lặng là thứ luật này sinh ra để chặn.
T1_ESCAPE_OFF=0
t1_escape_not_enforced() {
  [ "$T1_ESCAPE_OFF" -eq 1 ] && return 0
  T1_ESCAPE_OFF=1
  ledger_mark declared-off t1-escape
  echo "T1-ESCAPE: NOT ENFORCED reason=push-event-no-pr-premise"
  # Marker trên là cho MÁY (CI grep). Dòng dưới là cho NGƯỜI: một người chưa
  # đọc kit phải biết LỚP NÀO tắt, VÌ SAO, và rủi ro cụ thể là gì.
  echo "NOTE: lớp đang tắt là răng T1-escape — luật đòi mọi thay đổi chạm code quan trọng phải kèm thư mục _acceptance/<slug>/ (hồ sơ nghiệm thu). Nó chỉ có nghĩa khi so một PR với nhánh đích; lần chạy này là commit đẩy thẳng nhánh chính, nơi commit hạ tầng (đóng gói bản phát hành, đồng bộ bản sao) theo thiết kế không kèm hồ sơ nào."
  echo "NOTE: rủi ro khi tắt — nếu một thay đổi chạm code quan trọng lọt vào lần chạy này, nó sẽ KHÔNG bị chặn vì thiếu hồ sơ nghiệm thu. Các luật khác vẫn chạy đủ (phản biện context sạch, chữ ký người, bằng chứng hết hạn). Muốn bật lại: bỏ cờ --no-t1-escape."
}

# ── `**/` là KHÔNG-hoặc-nhiều thư mục (glob-hai-sao-khop-goc-kho, 2.9.0) ──────
# `case` của bash đòi `**/` phải có ít nhất một `/`, nên `**/*.md` bỏ sót
# AGENTS.md ở gốc kho (CRM 07/09: 4 hồ sơ stale/ngày vì commit thuần tài liệu).
# Sinh mọi biến thể của glob với từng đoạn `**/` được GIỮ hoặc BỎ — chỉ tách tại
# chuỗi ba ký tự `**/`, KHÔNG tại `**` (docs/** phải đi qua nguyên vẹn, HS10).
# `*` vẫn vượt `/` như trước — lời khai `*.md`/`docs/**` ở mọi consumer không
# đổi nghĩa. Biến thể rỗng (glob chỉ là `**/`) bị bộ khớp bỏ qua, không khớp-mọi-thứ.
glob_variants() { # <đã-xử-lý> <phần-còn-lại> — in mỗi biến thể một dòng
  case "$2" in
    *'**/'*)
      local pre="${2%%\*\*/*}" post="${2#*\*\*/}"
      glob_variants "$1$pre" "$post"          # GLOB-DOUBLESTAR-ZERO-DIRS
      glob_variants "$1$pre**/" "$post"
      ;;
    *) printf '%s\n' "$1$2" ;;
  esac
}
match_globs() { # <path> <newline-separated globs> — 0 iff any glob matches
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    # unquoted $g on purpose: case PATTERN matching (globs never fs-expand here)
    case "$1" in $g) return 0 ;; esac
    # Glob có `**/` → thử thêm mọi biến thể giữ/bỏ từng đoạn (glob_variants ở
    # trên). Thuần CỘNG: dòng khớp cũ vẫn chạy trước, không đổi nghĩa glob nào
    # không chứa `**/` (HS10) — và DV5 (chỉ-thêm) giữ được nguyên vẹn.
    case "$g" in *'**/'*)
      while IFS= read -r v; do
        [ -n "$v" ] || continue
        case "$1" in $v) return 0 ;; esac
      done <<VARIANTS
$(glob_variants "" "$g")
VARIANTS
    ;; esac
  done <<GLOBS
$2
GLOBS
  return 1
}

stale_files() { # <root> <commit> — files changed since <commit> (incl. working
  # tree) that are neither gate artifacts (_acceptance/) nor t1_skip_globs:
  # i.e. code the pinned evidence no longer covers. Untracked files are
  # invisible to git diff — CI runs on a committed tree, so that is moot there.
  git -C "$1" diff --name-only "$2" -- 2>/dev/null | while IFS= read -r f; do
    case "$f" in _acceptance/*|*/_acceptance/*) continue ;; esac
    match_globs "$f" "$T1_GLOBS" || printf '%s\n' "$f"
  done
}


# config.yaml 2-space lint: every kit parser (hook resolveConfigKey, the sed/awk
# here) is line/indent based — a TAB or odd indent silently breaks config:
# resolution (verifier refs stop resolving, executors vanish). Fail loudly instead.
if [ -f "$ACC/config.yaml" ]; then
  cfg_lint="$(awk '
    /\t/ { printf "line %d: TAB character\n", NR; next }
    /^[ ]*[^ #]/ {
      n = match($0, /[^ ]/) - 1
      if (n % 2 == 1) printf "line %d: odd indentation (%d spaces)\n", NR, n
    }
  ' "$ACC/config.yaml")"
  if [ -n "$cfg_lint" ]; then
    echo "VIOLATION [config]: _acceptance/config.yaml breaks the 2-space line schema (kit parsers are indent-based; use scripts/config-patch.mjs for programmatic writes):"
    printf '%s\n' "$cfg_lint" | head -5 | sed 's/^/    /'
    violations=$((violations+1))
  fi
fi

# ─── PR diff scope (hoisted) ───────────────────────────────────────────────
# Phần này trước đây chỉ được tính ở CUỐI file, trong khối T1-escape — nên mọi
# luật nằm trong vòng lặp per-slug đều không nhìn thấy diff. Luật gap-probe cần
# nó (chỉ xét slug có file trong PR), nên hoist lên đây; T1-escape bên dưới DÙNG
# LẠI ba biến này thay vì tính lại. Thông điệp giữ NGUYÊN VĂN để nội dung và thứ
# tự output không đổi.
DIFF_READY=0
DIFF_FILES=""
DIFF_SKIP_NOTE=""
if [ -z "$BASE" ]; then
  DIFF_SKIP_NOTE="no PR base given (pass --base <ref> or set PRE_MERGE_BASE; GitHub Actions: --base \"origin/\$GITHUB_BASE_REF\")"
elif ! command -v git >/dev/null 2>&1 || ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  # Tới nhánh này là base ĐÃ KHAI (nhánh -z ở trên bắt trường hợp không khai)
  # mà git không dùng được — không phải git repo, hoặc rev-parse bị chặn (CI
  # container hay gặp safe.directory). Bản cũ hạ về DIFF_SKIP_NOTE: gap-probe
  # lẫn T1-escape cùng declared-off và repo sạch thoát 0, ngược cả câu README
  # 'base đã khai mà không resolve được là exit 2 ở MỌI repo' (round 9 bắt).
  # Cùng doctrine với nhánh ref-không-resolve ngay dưới: đã khai thì mù là nổ.
  echo "VIOLATION [scope]: base \"$BASE\" đã khai nhưng git không dùng được trên $ROOT (không phải git repo, hoặc rev-parse bị chặn — CI container kiểm safe.directory). Phạm vi diff KHÔNG xác định được mà bạn đã yêu cầu nó; sửa môi trường git, hoặc bỏ hẳn --base nếu thật sự muốn chạy không phạm vi."
  exit 2
else
  BASE_SHA="$(git -C "$ROOT" rev-parse --quiet --verify "$BASE^{commit}" 2>/dev/null || true)"
  [ -z "$BASE_SHA" ] && BASE_SHA="$(git -C "$ROOT" rev-parse --quiet --verify "origin/$BASE^{commit}" 2>/dev/null || true)"
  if [ -z "$BASE_SHA" ]; then
    # KHÁC với "không truyền base": ở đây người vận hành ĐÃ yêu cầu một phạm vi
    # mà máy không tính được (ref gõ sai, nhánh đã xoá, clone shallow). Hạ về
    # bỏ-qua-rồi-clean là fail-open — cùng doctrine ADR 0004.
    # stdout như MỌI dòng VIOLATION khác (config/gap-probe/PR/ledger/per-slug)
    # — bản đầu >&2 làm CI nào chỉ grep stdout nhận exit 2 trần không lý do.
    echo "VIOLATION [scope]: base \"$BASE\" không resolve được trong clone này — phạm vi diff KHÔNG xác định được, mà bạn đã yêu cầu nó. Sửa ref (CI: fetch-depth: 0 + đúng base_ref), hoặc bỏ hẳn --base nếu thật sự muốn chạy không phạm vi."
    exit 2
  else
    # `rev-parse --verify` mới chỉ chứng minh OBJECT tồn tại. `git diff A...HEAD`
    # vẫn rc=128 + stdout rỗng khi KHÔNG có merge-base (clone shallow/grafted,
    # lịch sử rời nhau, base bị force-push). Nuốt rc ở đây là tai hoạ: script
    # tin phạm vi "đã biết và RỖNG" → gap-probe không bao giờ nổ, T1-escape
    # không thấy gì, NOTE bỏ-qua không in, và guard fail-closed của CI (grep
    # "skipped") bị vượt luôn. Mù thì phải KHAI là mù.
    if DIFF_FILES="$(git -C "$ROOT" diff --name-only "$BASE_SHA...HEAD" -- 2>/dev/null)"; then
      DIFF_READY=1
    else
      DIFF_FILES=""
      DIFF_SKIP_NOTE="git diff \"$BASE\"...HEAD failed (no merge base? shallow/grafted clone, unrelated history, force-pushed base)"
    fi
  fi
fi

# 0 iff PR đổi ít nhất một file dưới _acceptance/<slug>/. NEO `^` là bắt buộc:
# fixture ở tests/.../_acceptance/<slug>/ KHÔNG phải artifact của slug đó — glob
# chưa neo chính là lỗ README đang ghi cho khối T1-escape bên dưới.
# 0 iff PR đổi ít nhất một file dưới _acceptance/<slug>/.
# Path của `git diff` LUÔN tương đối với git top-level, KHÔNG phải với $ROOT —
# nên chỉ neo `^` là giả định ROOT == git root, và repo có `_acceptance/` nằm
# sâu (monorepo: pkg/_acceptance/) sẽ thấy luật TẮT im lặng. Dùng đúng idiom mà
# stale_files() và khối T1-escape trong file này vẫn dùng: chấp cả hai hình
# dạng. Vẫn chặn được fixture rác vì đòi khớp trọn `_acceptance/<slug>/`.
slug_in_diff() { # <slug>
  [ "$DIFF_READY" -eq 1 ] || return 1
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      _acceptance/"$1"/*|*/_acceptance/"$1"/*) return 0 ;;
    esac
  done <<SLUGDIFF
$DIFF_FILES
SLUGDIFF
  return 1
}

# AC-12 nửa sau: không có base thì luật không xác định được phạm vi, nên bỏ qua
# — nhưng bỏ qua phải THẤY ĐƯỢC (cùng lối với răng T1-escape bên dưới).
if [ "$GAP_PROBE_MODE" != "off" ] && [ "$DIFF_READY" -eq 0 ]; then
  gap_probe_not_enforced "$DIFF_SKIP_NOTE (luật chỉ xét slug có file trong diff PR)"
fi

# ─── stale-theo-diff-pr (1.39.2): phạm vi luật staleness ────────────────────
# Không có phạm vi diff (không --base, hoặc base có mà diff không dựng được —
# shallow/orphan/force-push) thì luật staleness chạy trên TOÀN BỘ slug như
# trước bản 1.39.2 (fail-safe, hành vi cũ). Tắt-phạm-vi phải THẤY ĐƯỢC (AC-4):
# đúng MỘT dòng hằng cho cả lần chạy — chuỗi cố định để CI grep được, cố ý
# không chứa chữ "skipped" (guard fail-closed của gate.yml grep chuỗi đó cho
# răng T1-escape, dòng này không được lẫn vào).
if [ "$DIFF_READY" -eq 0 ]; then
  echo "NOTE: staleness scope — no PR diff scope; the stale-evidence rule checks ALL slugs (pass --base <ref> to scope it to slugs whose _acceptance/<slug>/ files are in the PR diff)"
fi

# ─── RECHECK-DIFF-SCOPE (1.41.0): phạm vi luật re-check ─────────────────────
# Cùng fail-safe với staleness: không dựng được phạm vi diff thì kiểm TẤT như
# trước. Tắt-phạm-vi phải THẤY ĐƯỢC — đúng MỘT dòng hằng cho cả lần chạy, cố ý
# không chứa chữ "skipped" (guard fail-closed của gate.yml grep chuỗi đó cho
# răng T1-escape, dòng này không được lẫn vào).
RECHECK_SKIPPED=0
if [ "$RECHECK_MODE" != off ] && [ "$RECHECK_ALL" -eq 0 ] && [ "$DIFF_READY" -eq 0 ]; then
  echo "NOTE: recheck scope — no PR diff scope; the committed-evidence re-check runs on ALL slugs (pass --base <ref> to scope it, or --recheck-all to force the full sweep)"
fi
if [ "$RECHECK_MODE" != off ] && [ "$RECHECK_ALL" -eq 1 ]; then
  echo "NOTE: recheck scope — --recheck-all: the committed-evidence re-check runs on ALL slugs, ignoring the PR diff scope"
fi

# ─── Phân loại diff-chịu-cổng (hoist từ khối T1-escape — status-chua-arm-cong) ─
# Khối T1-escape cuối file cần biết PR có đổi file chịu cổng không (khớp
# t3_paths, hoặc ngoài t1_skip_globs). Luật «hồ sơ chưa arm cổng» trong vòng
# per-slug cũng cần đúng ba con số đó, và vòng per-slug chạy TRƯỚC — nên tính
# một lần ở đây, T1-escape dùng lại (thông điệp và thứ tự output của nó giữ
# nguyên văn; răng ARM08/ARM08b canh). Chỉ có nghĩa khi DIFF_READY=1.
DIFF_GATE_TOUCHED=0; DIFF_T3_HITS=""; DIFF_NONT1_HITS=""
if [ "$DIFF_READY" -eq 1 ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in _acceptance/*|*/_acceptance/*) DIFF_GATE_TOUCHED=1; continue ;; esac
    if [ -n "$T3_PATHS" ] && match_globs "$f" "$T3_PATHS"; then
      DIFF_T3_HITS="${DIFF_T3_HITS}${f}"$'\n'
    elif ! match_globs "$f" "$T1_GLOBS"; then
      DIFF_NONT1_HITS="${DIFF_NONT1_HITS}${f}"$'\n'
    fi
  done <<CHANGED
$DIFF_FILES
CHANGED
fi
# File chịu cổng ĐẦU TIÊN trong diff — để thông điệp per-slug nêu đích danh.
DIFF_GATED_FIRST="$(printf '%s%s' "$DIFF_T3_HITS" "$DIFF_NONT1_HITS" | head -1)"

# per-slug: hai đường dẫn độc lập về lexical — vòng đếm dưới đây dùng biến
# _sd, vòng luật thật dùng dir. Tiêm hỏng một vòng thì con số lệch và điểm
# nghẽn từ chối kết luận (AC-9: bắt cả biến thể CHƯA nghĩ ra).
SLUG_SEEN=0; SLUG_EXPECTED_N=0
for _sd in "$ACC"/*/; do [ -d "$_sd" ] && SLUG_EXPECTED_N=$((SLUG_EXPECTED_N+1)); done
GP_SCOPE_N=0; GP_RAN=0

for dir in "$ACC"/*/; do
  [ -d "$dir" ] || continue
  SLUG_SEEN=$((SLUG_SEEN+1))
  slug="$(basename "$dir")"
  if [ ${#SLUGS[@]} -gt 0 ]; then
    found=0
    for s in "${SLUGS[@]}"; do [ "$s" = "$slug" ] && found=1; done
    [ $found -eq 1 ] || continue
  fi
  # Mỗi `continue` dưới đây loại thư mục khỏi cổng HOÀN TOÀN. Im lặng đó đúng
  # với scaffold bỏ hoang, nhưng một thư mục TỰ KHAI đã phát hành mà vô hình là
  # một PASS chưa ai phán cưỡi CI xanh (incident 2026-07-20 #255 ở repo tiêu thụ).
  contract="$dir/contract.md"
  if [ ! -f "$contract" ]; then
    if claims_released "$dir"; then
      echo "VIOLATION [$slug]: no contract.md — slug invisible to the gate, yet it claims release (evidence-report.md declares verdict PASS). An unjudged PASS would ride CI green. Add contract.md with frontmatter status + risk_tier so the gate can judge it."
      violations=$((violations+1))
    fi
    continue
  fi

  tier="$(fm_field "$contract" risk_tier)"
  status="$(fm_field "$contract" status)"

  # Thiếu field ≠ khai báo → bị flag. Field CÓ mặt nhưng tier ngoài
  # required_for LÀ khai báo có chủ đích của config → im lặng đúng thiết kế.
  # Status draft/approved thì KHÔNG còn im lặng vô điều kiện — xem nhánh
  # «chưa arm cổng» ngay dưới `case REQUIRED_FOR`.
  if [ -z "$tier" ] || [ -z "$status" ]; then
    if claims_released "$dir"; then
      if   [ -z "$tier" ] && [ -z "$status" ]; then uj_missing="status nor risk_tier"
      elif [ -z "$tier" ];                     then uj_missing="risk_tier"
      else                                          uj_missing="status"
      fi
      echo "VIOLATION [$slug]: contract has no $uj_missing — slug invisible to the gate, yet it claims release. Add the missing frontmatter to $slug/contract.md so the gate can judge it."
      violations=$((violations+1))
    fi
    continue
  fi
  case "$REQUIRED_FOR" in *"$tier"*) ;; *) continue ;; esac
  # ── Hồ sơ CHƯA ARM cổng (status ngoài implemented/verified/signed-off) ──
  # (machine-cleared cũng đã arm — arm mới thêm ở case dưới, hồ sơ ra-co-ten)
  # Bản cũ `continue` im lặng ở đây — cửa thứ ba của lớp «PASS chưa ai phán»
  # (hai cửa đầu: không contract / thiếu field, xử ở trên). Vòng 4 hồ sơ
  # release-2-2-0 (18/08): status approved + evidence-report REJECT + chữ ký
  # rỗng → «clean» không một dòng, T1-escape lại được thoả bởi chính hồ sơ đó.
  # Hai điều kiện, trúng một là VIOLATION, không trúng mới im lặng (đường
  # đọc-cũ: draft/approved KHÔNG bằng chứng + PR không chạm code chịu cổng —
  # hạt giống hồ sơ merge kèm docs vẫn qua; scaffold bỏ hoang vẫn im):
  #   (a) đã có evidence-report.md (verdict BẤT KỲ) và hồ sơ trong phạm vi
  #       diff PR — hoặc không dựng được phạm vi thì xét mọi slug (fail-safe,
  #       cùng nếp luật staleness);
  #   (b) hồ sơ trong diff PR mà PR đổi ít nhất một file chịu cổng — hồ sơ
  #       này đang thoả T1-escape cho code đó, mà chưa arm thì không luật nào
  #       chấm.
  # Đặt SAU `case REQUIRED_FOR`: tier ngoài required_for vẫn im (ARM12).
  case "$status" in
    implemented|verified|signed-off) ;;
    machine-cleared) ;;
    *)
      _arm_why=""
      if [ -f "$dir/evidence-report.md" ] && { [ "$DIFF_READY" -eq 0 ] || slug_in_diff "$slug"; }; then
        _arm_why="evidence-report.md verdict=$(fm_field "$dir/evidence-report.md" verdict) đã có"
      elif [ "$DIFF_READY" -eq 1 ] && [ -n "$DIFF_GATED_FIRST" ] && slug_in_diff "$slug"; then
        _arm_why="PR đổi code chịu cổng ($DIFF_GATED_FIRST…) mà hồ sơ trong PR chưa arm"
      fi
      if [ -n "$_arm_why" ]; then
        echo "VIOLATION [$slug]: hồ sơ có bằng chứng nhưng status chưa arm cổng — status=$status; $_arm_why. Cổng chỉ chấm hồ sơ ở implemented/verified/signed-off, hồ sơ này đang tàng hình. Đặt status: implemented để cổng chấm, hoặc gỡ evidence-report.md / tách hồ sơ khỏi PR nếu bằng chứng thuộc phạm vi đã bỏ."
        violations=$((violations+1))
      fi
      continue ;;
  esac

  # ── Răng LỜI KHAI của machine-cleared (hồ sơ ra-co-ten, AC-2) ──
  # «máy đã thông» tự khai sáu điều kiện xanh-sạch. Lưới đòi VẬT, và trả lời bằng ĐÚNG
  # điều kiện trượt. Đặt TRƯỚC luật Cổng 1 để trạng thái mới có thông điệp của chính nó
  # thay vì mượn câu của làn V. Báo cáo VẮNG thì im ở đây — luật thiếu-hồ-sơ bên dưới
  # sở hữu câu đó, mỗi luật một câu.
  if [ "$status" = "machine-cleared" ] && [ -f "$dir/evidence-report.md" ]; then
    if xanh_sach_check "$dir/evidence-report.md"; then :; else
      echo "VIOLATION [$slug]: status machine-cleared nhưng hồ sơ còn cần người — $CLEAN_WHY. Hạ về verified rồi mời ký, hoặc sửa cho bằng chứng xanh-sạch thật."
      violations=$((violations+1)); continue
    fi
  fi

  # Gate 1 must have been recorded BEFORE any post-approval status: a contract
  # that reached implemented+ with an empty approved_by jumped the gate. The
  # explicit user skip (gate1_skipped: true) is tolerated but NOTEd (audit).
  approved_by="$(front_field "$contract" approved_by)"
  g1skip="$(front_field "$contract" gate1_skipped | tr '[:upper:]' '[:lower:]')"
  if [ -z "$approved_by" ]; then
    case "$g1skip" in
      true|1|yes)
        echo "NOTE [$slug]: gate1_skipped: true — user explicitly skipped Gate 1 (approved_by empty tolerated, audit trail)" ;;
      *)
        # ── LÀN V (hồ sơ cong-chan-nham-cho): hook ghi-lúc-viết đã cho làn này
        # đi từ đợt 2; lưới biên merge phải hiểu ĐÚNG như thế, nếu không mọi hồ
        # sơ máy-đi-trước vẫn phải xin một chữ duyệt ở đây — đúng trạm thu phí
        # đợt 2 dựng để gỡ. Cửa mở khi ĐỦ: veto_state=mo · vết giờ parse được ·
        # hạng T2 · VÀ (bằng chứng xanh-sạch sáu điều kiện HOẶC đã có chữ ký).
        # Vế cuối là QUAN HỆ, không phải cái nhãn: `mo` gõ tay lên một hồ sơ
        # không sạch mà chưa ai ký thì vẫn chặn (gap-probe P0 của hồ sơ này).
        _vst="$(front_field "$contract" veto_state | tr '[:upper:]' '[:lower:]')"
        _vat="$(front_field "$contract" veto_opened_at)"
        _vrep="$dir/evidence-report.md"
        if [ "$_vst" = "mo" ]; then
          _vsig="$(front_field "$_vrep" human_signoff 2>/dev/null)"
          if [ "$tier" != "T2" ]; then
            echo "VIOLATION [$slug]: status=$status but approved_by is empty — làn V chỉ T2, hồ sơ này hạng $tier: T3 chạm lõi cưỡng chế / dữ liệu / API phá vỡ nên LUÔN cần người ở Cổng 1. Điền approved_by (+ approved_at)."
            violations=$((violations+1)); continue
          elif [ -z "$_vat" ] || ! date_parseable "$_vat"; then
            echo "VIOLATION [$slug]: status=$status but approved_by is empty — veto_opened_at ${_vat:+\"$_vat\" }không đọc được: làn V ĐÒI một mốc thời gian parse được, không có nó thì đây là bỏ cổng im lặng chứ không phải cửa veto có dấu vết."
            violations=$((violations+1)); continue
          elif signoff_that "$dir"; then
            # Đã ký ở Cổng Bằng chứng: cửa veto hết là chốt đang giữ hồ sơ, nên
            # câu «cửa veto mở» là sai. Nhánh này đặt TRƯỚC nhánh cũ; vế
            # `[ -n "$_vsig" ]` của nhánh dưới từ nay không còn tới được nhưng
            # GIỮ NGUYÊN VĂN — luật diff-chỉ-thêm (DV5) cấm sửa dòng cũ.
            echo "NOTE [$slug]: làn V — Cổng 1 không có chữ duyệt; Cổng 2 đã có chữ ký người ($SIGNOFF_THAT): cửa veto đã đóng bằng chữ ký"
          elif [ -n "$_vsig" ] || xanh_sach_check "$_vrep"; then
            echo "NOTE [$slug]: làn V — máy đi trước, Cổng 1 không có chữ duyệt; cửa veto mở"
          else
            echo "VIOLATION [$slug]: status=$status but approved_by is empty — làn V đòi xanh-sạch hoặc chữ ký ($CLEAN_WHY). Máy được đi trước khi bằng chứng tự đứng vững; hồ sơ này thì không, nên nó cần người: điền approved_by, hoặc ký Cổng 2."
            violations=$((violations+1)); continue
          fi
        else
          echo "VIOLATION [$slug]: status=$status but approved_by is empty and gate1_skipped is not true — Gate 1 approval was never recorded (contract skipped the gate)"
          violations=$((violations+1)); continue
        fi ;;
    esac
  fi

  # Cross-layer pairing teeth (wave 2): a gated feature whose contract tags a
  # criterion (cross-layer) MUST pair it with >=1 eval declaring
  # layer: backend-effect in evals.yaml — otherwise this merge would ride on
  # UI-only evidence for a UI→API→backend path. Write-time stays advisory
  # (lint W4); this is the merge-boundary backstop for every runtime.
  # Fail-open: evals.yaml missing → NOTE, never a block.
  # `## Criteria` runs until the next H1/H2 — a `### nhóm phụ` inside it is
  # content, not a boundary. Exiting on any heading truncated the scan and every
  # AC after the first sub-heading went untagged (teeth silently off).
  xl_acs="$(awk '/^#/ && !/^###/ {insec=0} tolower($0) ~ /^##[[:space:]]+criteria/{insec=1; next} insec && tolower($0) ~ /^[[:space:]]*[-*].*\(cross-layer\)/ { if (match($0, /AC-[0-9]+/)) print substr($0, RSTART, RLENGTH) }' "$contract" | sort -u)"
  # "Thế nào là một dòng criterion" có MỘT nguồn: lib/ac-line.cjs — cùng nơi
  # gate-card.js, eval-coverage-lint.js và evidence-page.js đọc. Khi có node +
  # lib, kết quả của nó ĐÈ khuôn awk ở trên; khuôn awk ở lại làm đường lùi cho
  # máy thiếu node (cùng nếp fail-open có tiếng với gap-probe/recheck-evidence).
  #
  # Vì sao KHÔNG xoá awk đi cho gọn: nó RỘNG hơn cả ba khuôn JS nên không rụng
  # dòng nào — bỏ nó là tự tay tắt răng chặn trên máy thiếu node, đúng chiều hỏng
  # tệ nhất cho một cổng CHẶN. (Luật diff-chỉ-thêm của DV5 cũng cấm sửa dòng cũ.)
  # Cái awk KHÔNG làm được, và đây là lý do có khối này: nó không phân biệt được
  # dòng THAM CHIẾU CHÉO (`- **AC-5, AC-9 chưa có gì** (cross-layer)` là văn xuôi
  # trong Notes) với một tiêu chí thật, nên nó chấm oan và chặn merge nhầm;
  # parseAC loại đúng dạng đó bằng AC_XREF. Nó cũng đóng section ở h1 trong khi
  # lib/md-section.cjs coi h1 là nội dung.
  AC_LINE_LIB="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/lib/ac-line.cjs"
  if [ -f "$AC_LINE_LIB" ] && command -v node >/dev/null 2>&1; then
    if xl_from_lib="$(AGK_CONTRACT="$contract" node -e '
        const { parseAC } = require(process.argv[1]);
        const { section } = require(process.argv[2]);
        const t = require("fs").readFileSync(process.env.AGK_CONTRACT, "utf8");
        const out = new Set();
        for (const l of section(t, "Criteria")) {
          const a = parseAC(l);
          if (a && /\(cross-layer\)/i.test(a.gwt)) out.add(a.id);
          // Dòng trên là khuôn CŨ: regex trần trên `gwt`, nên nó KHÔNG phân biệt
          // được criterion MANG Dấu với criterion TRÍCH DẪN Dấu (hồ sơ giải thích
          // Dấu cho người mới) → VIOLATION GIẢ chặn merge. Hồ sơ ngược #36.
          // Luật diff-chỉ-thêm (DV5) cấm sửa dòng cũ của file này, nên phần sửa
          // là một dòng ĐÈ: parseAC nay trả `crossLayer` tính theo cùng luật với
          // `judgment` (bỏ code span qua uncoded()), và nó là tiếng nói cuối.
          if (a && a.crossLayer === false) out.delete(a.id);
        }
        process.stdout.write([...out].sort().join("\n"));
      ' "$AC_LINE_LIB" "$(dirname "$AC_LINE_LIB")/md-section.cjs" 2>/dev/null)"; then
      xl_acs="$xl_from_lib"
    else
      AC_LINE_FALLBACK_SEEN=1
    fi
  else
    AC_LINE_FALLBACK_SEEN=1
  fi
  if [ -n "$xl_acs" ]; then
    if [ ! -f "${dir}evals.yaml" ]; then
      echo "NOTE [$slug]: cross-layer criteria declared but no evals.yaml — pairing unverifiable (fail-open)"
    else
      # Buffer per eval block then flush: `layer:` may appear BEFORE `criterion:`
      # in a hand-written evals.yaml — printing at layer-time would miss those.
      # A YAML mapping key REQUIRES whitespace (or EOL) after its colon — that
      # alone separates `- id: E1` (opens a block) from a `paths:` glob like
      # `- api:v2/**` (a list item, colon glued to the value). Do NOT whitelist
      # key names here: a block opening on an unlisted key would fail to flush,
      # leaking the previous block's `layer:` onto it — false-green, the exact
      # failure these teeth exist to stop. Open wide, discriminate on syntax.
      # Thân block scalar (`expected: >` — khuôn mặc định của eval-gen — hay
      # `cmd: |`) là DATA, phải bị nuốt trọn: một bullet "- baseline: green"
      # trong thân từng khớp luật flush và reset crit giữa block (false
      # VIOLATION), còn một dòng prose "layer: backend-effect" trong thân từng
      # pair hộ eval UI-only (false-green — đúng thứ răng này chặn).
      xl_paired="$(awk '
        function flush() { if (lay=="backend-effect" && crit!="") print crit }
        { if (inblk) { if ($0 ~ /^[[:space:]]*$/) next; if (match($0, /[^[:space:]]/) - 1 > blkind) next; inblk = 0 } }
        tolower($0) ~ /^[[:space:]]*-[[:space:]]*[a-z_]+:([[:space:]]|$)/ { flush(); crit=""; lay="" }
        /^[[:space:]]*(-[[:space:]]*)?[A-Za-z_][A-Za-z0-9_-]*:[[:space:]]*[>|][+0-9-]*[[:space:]]*(#.*)?$/ { inblk = 1; blkind = match($0, /[^[:space:]]/) - 1; next }
        tolower($0) ~ /^[[:space:]]*(-[[:space:]]*)?criterion:[[:space:]]*/ {v=$0; sub(/^[^:]*:[[:space:]]*/,"",v); gsub(/["'\'']/,"",v); sub(/[[:space:]]+#.*$/,"",v); sub(/[[:space:]]+$/,"",v); crit=v}
        tolower($0) ~ /^[[:space:]]*(-[[:space:]]*)?layer:[[:space:]]*/ {v=tolower($0); sub(/^[^:]*:[[:space:]]*/,"",v); gsub(/["'\'']/,"",v); sub(/[[:space:]]+#.*$/,"",v); sub(/[[:space:]]+$/,"",v); lay=v}
        END { flush() }
      ' "${dir}evals.yaml" | sort -u)"
      while IFS= read -r xac; do
        [ -n "$xac" ] || continue
        # `xl_paired` giữ giá trị criterion NGUYÊN VĂN từ evals.yaml, mà nhiều repo
        # viết kèm chữ mô tả cho người đọc (`criterion: AC-7 (ghi sổ phía sau)`).
        # So nguyên-chuỗi (`grep -qx`) thì mã "AC-7" không bao giờ khớp những dòng
        # đó → luật bắn dương-tính-giả cho MỌI tiêu chí có nhãn (cross-layer).
        # Neo ĐẦU CHUỖI + biên không-phải-số: thiếu biên thì "AC-1" khớp nhầm
        # "AC-16 (...)" và luật tự tạo xanh-giả — đúng thứ nó sinh ra để chặn. (P183)
        if ! printf '%s\n' "$xl_paired" | grep -qE "^${xac}([^0-9]|$)"; then
          echo "VIOLATION [$slug]: $xac is tagged (cross-layer) but no eval of it declares layer: backend-effect — a cross-layer criterion would merge on UI-only evidence; add the paired test/script eval, or untag it with the human's signoff at Gate 1"
          violations=$((violations+1))
        fi
      done <<XLACS
$xl_acs
XLACS
    fi
  fi

  # ─── Lớp bằng chứng nhìn-thấy — NOTE, chưa VIOLATION (hồ sơ lop-bang-chung-nhin-thay) ──
  # Gương của răng cross-layer ở trên: hợp đồng có MẶT NGƯỜI NHÌN (ui; alias web/web-ui —
  # KHÔNG mobile) mà evals.yaml không có eval executor: ui-check → merge sẽ đi trên bằng
  # chứng lớp mã cho một bề mặt người nhìn. Vị từ/alias/tiền tố descope RÚT từ
  # lib/lop-nhin-thay.cjs (một nguồn với lint W8 và thẻ) qua MỘT lệnh node classify in
  # một dòng tab (mẫu lib/gap-probe.cjs). Phạm vi: slug trong diff, --recheck-all (đường
  # đếm ngưỡng), hoặc không có phạm vi diff (fail-safe như luật staleness — NOTE vô hại).
  # Ngưỡng siết thành VIOLATION: 2 hợp đồng ký không frame trong một mốc phát hành — NOTE
  # in kèm approved_at để đếm «ký trong cửa sổ» bằng grep, hồ sơ cũ bị kéo vào diff ở chiến
  # dịch ghim lại có ngày cũ nên loại được. Fail-open có tiếng: thiếu node/lib → NOTE
  # «không kiểm được», không đổi exit. Chỉ THÊM dòng (DV5).
  LNT_LIB="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/lib/lop-nhin-thay.cjs"
  if { [ "$DIFF_READY" -eq 0 ] || slug_in_diff "$slug" || [ "$RECHECK_ALL" -eq 1 ]; } && [ -f "${dir}evals.yaml" ]; then
    # Ba nguyên nhân KHÔNG-kiểm-được từng nấp sau một câu gộp: người đọc NOTE không
    # biết phải copy lib, cài node, hay đi sửa lib đang lỗi (nợ C1 Ngoài-5).
    lnt_line=""; lnt_why=""
    if ! command -v node >/dev/null 2>&1; then
      lnt_why="thiếu node; cài node để cổng đọc được lib"
    elif [ ! -f "$LNT_LIB" ]; then
      lnt_why="thiếu lib/lop-nhin-thay.cjs (mang cổng vào repo phải copy CẢ lib/)"
    else
      lnt_line="$(node "$LNT_LIB" classify "$dir" 2>/dev/null)"; lnt_rc=$?
      # exit 3 = hồ sơ không có contract.md (không phải lỗi lib) — im lặng như trước.
      if [ "$lnt_rc" -ne 0 ] && [ "$lnt_rc" -ne 3 ]; then lnt_why="lib lỗi (exit $lnt_rc)"; lnt_line=""; fi
    fi
    if [ -n "$lnt_why" ]; then
      echo "NOTE [$slug]: lớp nhìn-thấy không kiểm được — ${lnt_why}; NOTE này không chặn."
    elif [ -n "$lnt_line" ]; then
      lnt_app="$(printf '%s' "$lnt_line" | cut -f1)"; lnt_decl="$(printf '%s' "$lnt_line" | cut -f2)"
      lnt_desc="$(printf '%s' "$lnt_line" | cut -f3)"; lnt_appr="$(printf '%s' "$lnt_line" | cut -f4)"
      if [ "$lnt_app" = "1" ] && [ "$lnt_decl" = "0" ]; then
        if [ "$lnt_desc" != "-" ]; then
          echo "NOTE [$slug]: mặt người nhìn (surfaces ui/web) nhưng không eval ui-check — đã BỎ có tên theo ledger $lnt_desc (approved_at $lnt_appr); người ký Cổng Bằng chứng đọc tên ca máy, không nhìn frame. Ngưỡng siết: 2 hợp đồng ký không frame trong một mốc phát hành."
        else
          echo "NOTE [$slug]: mặt người nhìn (surfaces ui/web) nhưng không eval ui-check nào — bằng chứng lớp mã thay lớp nhìn-thấy (approved_at $lnt_appr). Thêm ≥1 ui-check (layer: ui-observed) theo hợp đồng, hoặc ghi entry descope có tên. Ngưỡng siết: 2 hợp đồng ký không frame trong một mốc phát hành."
        fi
      fi
    fi
  fi

  # Counter scope NẰM NGOÀI khối luật bên dưới và cố ý khác lexical (off không
  # nháy kép): tiêm vô hiệu khối thì counter vẫn đếm, sổ lệch, chokepoint bắt.
  [ "$GAP_PROBE_MODE" != off ] && slug_in_diff "$slug" && GP_SCOPE_N=$((GP_SCOPE_N+1))

  # ─── Gap-probe presence (phản biện context sạch) ─────────────────────────
  # Vị trí có chủ đích: SAU hai bước lọc `REQUIRED_FOR` và `status implemented+`
  # phía trên, nên AC-4 (T1) và AC-10 (draft/approved) đúng theo CẤU TRÚC chứ
  # không nhờ một nhánh if riêng. Chỉ xét slug có file trong diff PR: quét cả
  # `_acceptance/` khiến repo có lịch sử nhận hàng chục VIOLATION không liên
  # quan diff ở PR đầu tiên rồi tắt luật (Cổng 1 2026-07-26, ledger d-116).
  if [ "$GAP_PROBE_MODE" != "off" ] && slug_in_diff "$slug"; then
    gp_fix='Chạy bước S1#7 (phản biện context sạch) để sinh gap-probe.md, HOẶC ghi vào decisions.jsonl một entry {"id":"d-<UTC>-<rand>","type":"descope","stage":"S1","at":"<ISO>","decision":"bỏ gap-probe — <lý do>","impact":"đổi lại không có phản biện context sạch trước duyệt"}'
    # front_field CHỈ đọc khối --- ĐẦU file: một dòng `verdict:` nằm trong thân
    # bài (vd trích trong bảng finding) không được tính, và `touch` file rỗng cho
    # chuỗi rỗng nên rơi vào nhánh "thiếu". Đó là chốt chống bypass.
    gp_line=""
    if [ -f "$GP_LIB" ] && command -v node >/dev/null 2>&1; then
      gp_line="$(node "$GP_LIB" classify "$dir" 2>/dev/null || true)"
    fi
    if [ -z "$gp_line" ]; then
      if ! command -v node >/dev/null 2>&1; then
        gap_probe_not_enforced "không có \`node\` trên máy chạy pre-merge"
      elif [ ! -f "$GP_LIB" ]; then
        gap_probe_not_enforced "thiếu $GP_LIB (mang cổng vào repo phải copy CẢ lib/)"
      else
        gap_probe_not_enforced "node lib/gap-probe.cjs classify thất bại trên $slug"
      fi
    else
      GP_RAN=1
      gp_outcome="${gp_line%%	*}"
      gp_id="${gp_line#*	}"
      case "$gp_outcome" in
        ok) : ;;
        probe-failed)
          echo "NOTE [$slug]: gap-probe verdict là probe-failed — phản biện KHÔNG chạy được. Merge lúc này nghĩa là merge mà chưa có phản biện context sạch; chạy lại S1#7 nếu muốn có, hoặc chấp nhận rủi ro đó." ;;
        descoped)
          echo "NOTE [$slug]: phản biện context sạch đã được BỎ có chủ đích theo ledger $gp_id — quyết định có dấu vết, không phải sơ suất." ;;
        *)
          if [ "$GAP_PROBE_MODE" = "required" ]; then
            echo "VIOLATION [$slug]: chưa qua phản biện context sạch (gap-probe) — không có gap-probe.md hợp lệ và ledger không có entry descope. $gp_fix"
            violations=$((violations+1))
          else
            echo "NOTE [$slug]: chưa qua phản biện context sạch (gap-probe) — advisory, không chặn merge. $gp_fix"
          fi ;;
      esac
    fi
  fi

  report="$dir/evidence-report.md"
  if [ ! -f "$report" ]; then
    echo "VIOLATION [$slug]: status=$status but no evidence-report.md"
    violations=$((violations+1)); continue
  fi
  # Read report fields from the leading frontmatter ONLY — same scope as the
  # provenance reads below, so a no-fence/offset-fence report can't pass verdict
  # while its provenance reads empty (would otherwise let a bypassed PASS slip).
  verdict="$(front_field "$report" verdict)"
  # S4-r3: chỗ đọc chữ ký của luật Cổng 2 cũng đi qua NGUỒN. Trước đó nó dùng
  # front_field (awk chỉ nhận `human_signoff:`) trong khi engine nhận thêm `=` và
  # khoảng trắng trước dấu — cùng một tệp cho hai kết luận: lưới in «đã đóng bằng
  # chữ ký (…)» rồi ngay dưới in «xanh-sạch … cửa veto vẫn mở». Một ngữ pháp, một
  # chỗ. Engine vắng → lùi về front_field (khai ở NOTE của lưới giữ-chỗ).
  signoff="$(chu_ky_gia_tri "$report")"
  LAN_V=0 # DLPS-LAN-V-MOT-DUONG: 1 khi hồ sơ làn V xanh-sạch đi tiếp KHÔNG chữ ký (đổi khuôn, owner 08/09)
  # ── machine-cleared × chữ ký người = hai sự thật cãi nhau (hồ sơ ra-co-ten, AC-15) ──
  # Ký thì status phải sang signed-off; để chữ ký nằm trên hồ sơ máy-thông là mọi bên đọc
  # nói hai chuyện về cùng một hồ sơ.
  if [ "$status" = "machine-cleared" ] && [ -n "$signoff" ]; then
    echo "VIOLATION [$slug]: chữ ký người trên hồ sơ máy-thông — ký thì status phải sang signed-off (human_signoff=\"$signoff\", status=machine-cleared). /signoff đổi status cùng lượt ghi chữ ký."
    violations=$((violations+1)); continue
  fi
  if [ "$verdict" != "PASS" ]; then
    echo "VIOLATION [$slug]: verdict=$verdict (must be PASS to merge)"
    violations=$((violations+1)); continue
  fi
  bypass="$(front_field "$report" bypass_used | tr '[:upper:]' '[:lower:]')"
  ack="$(front_field "$report" bypass_ack)"
  case "$bypass" in true|1|yes)
    if [ -n "$ack" ]; then
      echo "NOTE [$slug]: bypass_used=$bypass acknowledged (bypass_ack: $ack) — released with audit trail"
    else
      echo "VIOLATION [$slug]: bypass_used=$bypass — PASS produced with the gate bypassed (ACCEPTANCE_GATE_BYPASS); re-verify without bypass, or record bypass_ack: <name> <date> to consciously release"
      violations=$((violations+1)); continue
    fi ;;
  esac
  enf="$(front_field "$report" enforcement_mode | tr '[:upper:]' '[:lower:]')"
  case "$enf" in
    off) echo "VIOLATION [$slug]: enforcement_mode=off — gate did nothing at write time; re-verify under enforcement: strict before merge"
      violations=$((violations+1)); continue ;;
    warn) echo "WARNING [$slug]: enforcement_mode=warn — gate only warned (not blocked) when this PASS was written; evidence present but not hard-enforced" ;;
  esac
  if [ -z "$signoff" ]; then
    # ── Cổng Bằng chứng xanh-sạch thôi mời ký (hồ sơ veto-co-dau-vet, đợt 2)
    # Chữ ký lui về đúng nơi có ĐÁNH-ĐỔI. Ở đây «sạch» là một danh sách ĐÓNG,
    # và MỌI điều kiện phải HIỆN DIỆN-và-rỗng chứ không phải vắng — bỏ hẳn một
    # mục khỏi báo cáo là đường sạch-giả rẻ nhất (gap-probe P1). Hạng đọc từ
    # CONTRACT (owner đặt), báo cáo không tự phong hạng cho mình.
    # Bản khai người-đọc của danh sách này sống ở khối DIEU-KIEN-SACH-V trong
    # hợp đồng; bộ răng của hồ sơ đối chiếu hành vi dưới đây với khối đó.
    # verdict=PASS đã được chốt ở trên (nhánh verdict != PASS đã continue).
    clean_ok=1; clean_why=""
    if xanh_sach_check "$report"; then :; else clean_ok=0; clean_why="$CLEAN_WHY"; fi
    if [ "$clean_ok" -eq 1 ]; then
      # Đường xanh-sạch KHÔNG có chữ ký để kiểm tiếp — các chốt dưới (giữ-chỗ,
      # provenance commit chữ ký) đều nói về một chuỗi không tồn tại ở đây.
      echo "NOTE [$slug]: xanh-sạch — máy đi tiếp, KHÔNG mời ký (verdict PASS · 0 UNCERTAIN · không bypass · Known limits rỗng · Ngoài hợp đồng rỗng · hạng T2). Cửa veto vẫn mở."
      # DLPS-LAN-V-MOT-DUONG (duong-lui-phai-song, đổi khuôn — owner 08/09/2026): KHÔNG `continue`.
      # Làn V rơi xuống CÙNG chuỗi kiểm với hồ sơ có chữ ký — hoá cũ · pin ma · re-pin
      # provenance · làn eval · soi lại — đúng chữ «soi MỌI hồ sơ ở MỌI lượt» (ADR 0014).
      # Ba vòng S4 của hồ sơ này đều bắt cùng lớp fail-open ở chính chỗ `continue` cũ: hồ sơ
      # máy-đi-trước là loại KHÔNG có người đọc lại, nên không được là loại duy nhất thoát lưới.
      # Các chốt chỉ nói về chữ ký (giữ-chỗ · chiều ghi chữ ký) tự bỏ qua vì $signoff rỗng /
      # LAN_V=1; dòng OK ở cuối gọi đúng tên làn.
      LAN_V=1
    fi
    if [ "$LAN_V" != 1 ]; then
    echo "NOTE [$slug]: không đủ điều kiện xanh-sạch để đi tiếp không ký — $clean_why"
    echo "VIOLATION [$slug]: verdict PASS but human_signoff is empty (Gate 2 pending)"
    violations=$((violations+1)); continue
    fi
  fi
  # THỨ TỰ CÓ RĂNG: chốt rỗng ngay trên chạy TRƯỚC. Gộp hai chốt cho gọn sẽ làm
  # chuỗi rỗng không khớp mẫu lưới-đen nào rồi rơi ra `clean` — hồi quy fail-open
  # trên một luật đang bảo vệ.
  #
  # human_signoff trước 1.24.0 chỉ bị kiểm KHÁC-RỖNG, nên "PENDING — chờ Manh
  # gật" thoả và cổng in "signed off by PENDING". Đó KHÔNG phải đường tấn công
  # mà là đường đi bộ bình thường: người duyệt mở file định ký, gõ một dòng giữ
  # chỗ, commit đúng nghi thức human-fields-only. Và require_human_commit không
  # cứu được — nó kiểm AI commit và commit đó chạm dòng nào, không kiểm nội
  # dung có phải một cái tên.
  #
  # PHẠM VI ĐÃ RÚT (2026-07-29, sau BỐN lần thử): chốt này CHỈ so chuỗi trên
  # chính chữ ký — không đọc `signoff.approvers`, không phân tích YAML nào. Bốn
  # bản vá liên tiếp cố khớp chữ ký với allowlist đều hỏng theo một hình dạng
  # YAML hợp lệ MỚI (khoá trần / indent 2 / ngang cột / chú thích đuôi / dấu
  # phẩy trong nháy / flow mapping / space trước dấu hai chấm), ba lần kèm hồi
  # quy chặn nhầm người duyệt thật. Không gian hình dạng YAML hợp lệ là vô hạn
  # còn mỗi bản vá chỉ đóng được tập mình nghĩ ra — nên lớp đó bị GỠ HẲN thay
  # vì vá lần năm. Đánh đổi đã khai: giữ-chỗ viết bằng ngôn ngữ ngoài bảng dưới
  # vẫn lọt (xem "Đã biết là không bắt được" trong contract).
  if placeholder_signoff "$signoff"; then
    echo "VIOLATION [$slug]: human_signoff \"$signoff\" is a placeholder, not a signature — it names no approver, so Gate 2 is still pending. Replace it with the approver's name + date once they actually sign."
    violations=$((violations+1))
    # Nói THẲNG giới hạn của chính luật vừa nổ, đúng lúc người vận hành đang
    # sửa dòng đó. Không có câu này, cách sửa rẻ nhất là đổi "PENDING" thành
    # một cách nói khác — và cổng sẽ xanh, vì lưới chỉ khớp một bảng tiền tố
    # ngắn cố định. Một dòng cho cả lần chạy, in ở cuối (xem NARROW_NET_SEEN).
    NARROW_NET_SEEN=1
    continue
  fi
  # ── Provenance chữ ký (hồ sơ cong-chan-nham-cho, 16/08) ──────────────────
  # TRƯỚC: chữ ký phải nằm trong commit RIÊNG chỉ-trường-người, author không
  # khớp blocklist — ba VIOLATION. Lớp ấy xác thực AI GÕ CHUỖI, không xác thực
  # QUYẾT ĐỊNH có đúng; mối đe doạ nó chặn (máy giả chữ ký) chưa từng xảy ra,
  # còn phí thì thật: squash-merge giết hạt commit và chặn mọi PR. Provenance
  # nay lấy từ forge — người approve / bấm merge PR — và chiều GHI chữ ký hiện
  # ra ngay dưới đây để người merge nhìn thấy nó ra đời. ADR 0012.
  # Hai khoá cũ còn trong config vẫn ĐỌC ĐƯỢC (đường đọc-cũ) nhưng chỉ đổi lấy
  # một dòng nhắc cho CẢ lần chạy, in ở cuối.
  # CCNC-ALLOWLIST: 2 dòng dưới là chỗ DUY NHẤT hai tên khoá cũ còn được nhắc.
  if [ "$REQ_HUMAN_COMMIT" = "true" ] || [ -n "$AGENT_AUTHORS" ]; then
    LEGACY_SIGN_KNOB=1
  fi
  # Chiều GHI chữ ký: diff PR đưa human_signoff từ rỗng → khác rỗng thì nói ra.
  # Đây là lưới THAY cho lớp cũ: rẻ, không chặn ai, và đặt đúng chỗ người quyết
  # đang nhìn (trang PR) thay vì bắt một nghi thức commit.
  # Phạm vi: CHỈ hồ sơ nằm trong diff PR — dùng ĐÚNG hàm slug_in_diff mà luật
  # staleness/gap-probe dùng. Không thu phạm vi thì mọi hồ sơ sử liệu đều in
  # một dòng mỗi lần chạy (đo thật: 20+ dòng), đúng lớp loãng-tín-hiệu.
  if [ "$LAN_V" != 1 ]; then # DLPS-LAN-V-MOT-DUONG: làn V không có chữ ký → không có chiều ghi để nói
  if [ -n "$BASE" ] && slug_in_diff "$slug" && command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    rel_report="$(cd "$ROOT" 2>/dev/null && git ls-files --full-name -- "${report#"$ROOT"/}" 2>/dev/null | head -1)"
    [ -n "$rel_report" ] || rel_report="${report#"$ROOT"/}"
    base_sig="$(git -C "$ROOT" show "$BASE:$rel_report" 2>/dev/null \
      | awk '!f && NF==0 {next} !f && /^---[[:space:]]*$/ {f=1; next} !f {exit} /^---[[:space:]]*$/ {exit} {print}' \
      | sed -n 's/^human_signoff:[[:space:]]*//p' | head -1 | sed -e 's/[[:space:]]*$//')"
    if [ -z "$base_sig" ]; then
      echo "NOTE [$slug]: chữ ký mới trong diff — $signoff — provenance ở forge: người bấm merge xác nhận đây là quyết định của người"
    fi
  fi
  fi # đóng guard DLPS-LAN-V-MOT-DUONG
  # Stale-evidence check: the PASS certifies the tree at verified_commit. Any
  # non-gate file changed since then (committed or working tree) means the code
  # being merged is NOT the code that was verified — re-verify, don't ride old
  # evidence. Reports without the field (older template) and clones where the
  # commit is unreachable (rebase/squash/shallow fetch) only get a NOTE.
  vc="$(front_field "$report" verified_commit)"
  # ─── stale-theo-diff-pr (1.39.2): sử liệu ngoài diff im lặng TRỌN khối ────
  # Ngữ nghĩa: staleness bảo vệ "bằng chứng mô tả cây ĐANG merge". Hồ sơ đã
  # merge là sử liệu bất biến qua git — một nhánh mới ĐƯƠNG NHIÊN đổi code sau
  # verified_commit của mọi feature cũ, nên soi chúng là chặn-mọi-PR-vì-lịch-sử
  # (2 lần cắn + 4 lần re-pin bắc cầu ở repo tiêu thụ, sổ vấp dòng 68). Phạm
  # vi dùng ĐÚNG hàm slug_in_diff mà luật gap-probe dùng (ledger d-116) — một
  # nguồn ngữ nghĩa slug↔diff, không parser thứ ba. Bọc TRỌN khối (cả
  # phantom-pin/shallow/no-vc NOTE): pin của sử liệu sau squash-merge thành
  # SHA-ma là số phận tự nhiên của lịch sử, không phải lỗi của PR đang merge;
  # đánh đổi (pin ma ngoài diff vô hình — chạm hồ sơ là nổ lại) owner ký có
  # mắt tại Cổng 1 hồ sơ stale-theo-diff-pr. Dòng vc= ở TRÊN cố ý nằm NGOÀI
  # guard: khối re-pin phía dưới so lane với vc của CHÍNH slug này — skip phép
  # gán là rò vc slug trước sang (đúng lớp rò-trạng-thái gap-probe P0-2).
  # Guard kiểm DIFF_READY chứ KHÔNG kiểm $BASE: base-có-mà-diff-không-dựng-được
  # (clone shallow CI) phải rơi về kiểm-tất, không phải tắt im (gap-probe P0-1).
  if [ "$DIFF_READY" -eq 1 ] && ! slug_in_diff "$slug"; then # STALE-DIFF-SCOPE-GUARD
    : # sử liệu ngoài diff — không soi verified_commit (AC-2); chạm hồ sơ là nó vào diff và bị soi lại như thường (AC-3)
  else
  if [ -z "$vc" ]; then
    echo "NOTE [$slug]: report has no verified_commit (older template) — evidence is not pinned to a commit; code drift since verify is NOT machine-checked. Re-verify to pin."
  elif ! command -v git >/dev/null 2>&1 || ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    echo "NOTE [$slug]: verified_commit present but $ROOT is not a git repo here — staleness unverifiable"
  elif ! git -C "$ROOT" rev-parse --quiet --verify "$vc^{commit}" >/dev/null 2>&1; then
    # Pin không giải được nghĩa là staleness KHÔNG được kiểm cho hồ sơ này. Hai
    # nguyên nhân rất khác nhau từng nấp sau cùng một dòng NOTE:
    #   - clone nông / fetch thiếu: commit có thể vẫn lành, ta chỉ không thấy nó ở
    #     đây. Không-kiểm-được ≠ sai, nên NOTE và để một clone đầy đủ phán.
    #   - clone đầy đủ mà commit thật sự không tồn tại: pin là MA. Re-pin vào một
    #     SHA nhánh rồi bị squash-merge vứt đi sinh ra đúng cảnh này, và nó câm —
    #     hồ sơ đó tắt thanh chắn trong khi cổng vẫn in "clean". Đo trên một repo
    #     tiêu thụ: 136/136 hồ sơ ghim vào commit không clone nào có, 135 NOTE,
    #     không đỏ dòng nào.
    # Nên: chỉ hạ xuống NOTE khi CHỨNG MINH được là nông. `unknown` (git quá cũ
    # không trả lời được) giữ nguyên hành vi khoan dung cũ, có chủ đích. (P184)
    shallow="$(git -C "$ROOT" rev-parse --is-shallow-repository 2>/dev/null || echo unknown)"
    if [ "$shallow" = false ]; then
      echo "VIOLATION [$slug]: verified_commit $vc does not exist in this repo — the pin is a phantom, so staleness is NOT machine-checked (evidence could be arbitrarily out of date and this gate would not notice). Usual cause: re-pinned to a branch SHA that squash-merge discarded. Re-pin to a commit that lives on the target branch."
      violations=$((violations+1)); continue
    fi
    echo "NOTE [$slug]: verified_commit $vc not found in this SHALLOW clone (fetch-depth) — staleness unverifiable here; a full clone decides"
  else
    stale="$(stale_files "$ROOT" "$vc")"
    if [ -n "$stale" ]; then
      echo "VIOLATION [$slug]: evidence is stale — code changed after verify (verified_commit $vc); re-run verify before merge. Changed:"
      printf '%s\n' "$stale" | head -10 | sed 's/^/    /'
      violations=$((violations+1)); continue
    fi
  fi
  fi # đóng STALE-DIFF-SCOPE-GUARD — từ đây trở đi mọi luật chạy cho CẢ slug ngoài diff (AC-2 vế "vẫn chạy")
  # run-log presence: the re-check below reconciles report run_ids against
  # _acceptance/<slug>/run-log.jsonl (machine-written at verify). A missing log
  # (older verify flow) is tolerated but must be visible.
  if [ ! -f "$dir/run-log.jsonl" ]; then
    echo "NOTE [$slug]: no run-log.jsonl (older verify flow) — run_id provenance is not machine-logged; report run_ids are unreconciled. Re-verify to generate the log."
  fi
  # Re-pin provenance (delta-verify-repin, additive): new-form "### Re-pin"
  # sections cite run_id on its own line — the lane must be logged per-slug
  # ({"kind":"repin"} line), its sha must equal verified_commit, and every
  # suites_exit element must be 0 (a red lane cannot back a signature).
  # Old-form sections (no "run_id:" line) are grandfathered — no rule applies.
  # Ngữ pháp ranh giới section THỐNG NHẤT với recheck-evidence.cjs (fix S4-r2):
  # section chỉ kết thúc ở heading cấp 1-3 (# / ## / ### + khoảng trắng) —
  # #### sub-heading là NỘI DUNG của section; run_id bắt không phân biệt hoa
  # thường (recheck dùng flag i). Hai reader lệch ngữ pháp = một bên fail-open.
  repin_ids="$(awk '/^### Re-pin/{s=1;next} /^(#|##|###)[[:space:]]/{s=0} s { low=tolower($0); if (match(low, /^[[:space:]]*run_id[:=][[:space:]]*/)) { t=substr($0, RSTART+RLENGTH); sub(/[ \t·,].*$/,"",t); if(t!="")print t } }' "$report")"
  if [ -n "$repin_ids" ]; then
    if [ ! -f "$dir/run-log.jsonl" ]; then
      echo "VIOLATION [$slug]: re-pin run_id cited in ### Re-pin but _acceptance/$slug/run-log.jsonl does not exist — no lane was ever logged for this workspace"
      violations=$((violations+1)); continue
    fi
    repin_bad=""
    repin_current=""
    while IFS= read -r rid; do
      [ -n "$rid" ] || continue
      rline="$(grep -F "\"run_id\":\"$rid\"" "$dir/run-log.jsonl" | grep -F '"kind":"repin"' | tail -1)"
      if [ -z "$rline" ]; then
        echo "VIOLATION [$slug]: re-pin run_id \"$rid\" cited in ### Re-pin but no {\"kind\":\"repin\"} line with that run_id in run-log.jsonl — the lane never logged this re-pin; re-run the lane, do not hand-mint run_ids"
        repin_bad=1; continue
      fi
      rsha="$(printf '%s' "$rline" | sed -n 's/.*"sha":"\([0-9a-fA-F]\{7,40\}\)".*/\1/p')"
      # Hotfix sự-kiện-thứ-hai: sha-khớp chuyển thành quan hệ tổng hợp bên dưới
      # (ít nhất MỘT citation khớp vc) — section cũ có sha lịch sử là hợp lệ.
      if [ -n "$vc" ] && [ "$rsha" = "$vc" ]; then repin_current=1; fi
      if ! printf '%s' "$rline" | grep -Eq '"suites_exit":[[:space:]]*\[[0-9][0-9, ]*\]'; then
        echo "VIOLATION [$slug]: re-pin line for run_id \"$rid\" has no well-formed suites_exit array — a lane that never recorded its suite results cannot back a signature; re-run the lane"
        repin_bad=1; continue
      fi
      if printf '%s' "$rline" | grep -Eq '"suites_exit":[[:space:]]*\[[0-9, ]*[1-9]'; then
        echo "VIOLATION [$slug]: re-pin line for run_id \"$rid\" has nonzero suites_exit — a red lane cannot back a signature; fix the suites and run a NEW lane"
        repin_bad=1; continue
      fi
    done <<REPINIDS
$repin_ids
REPINIDS
    if [ -n "$vc" ] && [ -z "$repin_current" ]; then
      echo "VIOLATION [$slug]: none of the cited re-pin lane(s) matches verified_commit $vc — the current pin has no backing lane; re-pin against the verified commit, do not hand-edit the pin"
      repin_bad=1
    fi
    # ── Eval-lane rule (repin-chay-lai-eval, 2026-09-07) ─────────────────────
    # Làn chống lưng verified_commit phải chạy lại eval MÁY của CHÍNH hồ sơ
    # (evals_exit phủ mọi eval test/script trong evals.yaml, đều 0) — làn chỉ
    # chứng suite từng cho một hồ sơ mất tiền đề đi thẳng nhánh chính với CI
    # xanh (crm-onehub 07/09). MỘT nguồn luật: checkRepinEvals trong
    # lib/evidence-core.cjs (bên đọc thứ hai là recheck-evidence.cjs); nó liệt
    # kê eval máy qua lib/eval-yaml.cjs, nên cả hai phải được chép theo
    # INIT-CI-COPY-LIST. KHÔNG mốc ngày, KHÔNG phạm vi diff (owner 08/09/2026,
    # hai lần): làn suite-only đời nào, hồ sơ nào trong kho, cũng là VIOLATION ở
    # MỌI lượt chạy — pin chưa chứng không được nằm im chỉ vì PR không chạm nó;
    # cách sửa duy nhất là ghim lại bằng làn eval. Thiếu node/lib → khai NOT
    # ENFORCED, không im lặng.
    if [ -n "$vc" ]; then
      if command -v node >/dev/null 2>&1 && [ -f "$HERE/../lib/evidence-core.cjs" ]; then
        repin_evals_out="$(REPIN_IDS="$repin_ids" node -e '
          const fs = require("fs");
          const core = require(process.argv[1]);
          const logPath = process.argv[2], evalsPath = process.argv[3], vc = process.argv[4], slug = process.argv[5];
          if (typeof core.checkRepinEvals !== "function") { process.stdout.write("lib/evidence-core.cjs is older than the eval-lane rule (no checkRepinEvals)\n"); process.exit(3); }
          const ids = new Set(String(process.env.REPIN_IDS || "").split("\n").map(s => s.trim()).filter(Boolean));
          const repins = new Map();
          for (const l of fs.readFileSync(logPath, "utf8").split("\n")) {
            try { const e = JSON.parse(l); if (e && e.kind === "repin" && typeof e.run_id === "string") repins.set(e.run_id, e); } catch (_) { /* dòng hỏng: bỏ qua */ }
          }
          const evalsText = fs.existsSync(evalsPath) ? fs.readFileSync(evalsPath, "utf8") : null;
          let bad = 0;
          for (const id of ids) {
            const e = repins.get(id); if (!e || e.sha !== vc) continue;
            const r = core.checkRepinEvals(e, evalsText, slug, core.readSignedReportFor(evalsPath));
            if (r.note) process.stdout.write(`NOTE [${slug}]: ${r.note}\n`);
            for (const x of r.errs) { bad = 1; process.stdout.write(`VIOLATION [${slug}]: ${x}\n`); }
          }
          process.exit(bad);
        ' "$HERE/../lib/evidence-core.cjs" "$dir/run-log.jsonl" "$dir/evals.yaml" "$vc" "$slug" 2>&1)"; repin_evals_rc=$?
        [ -n "$repin_evals_out" ] && printf '%s\n' "$repin_evals_out"
        case "$repin_evals_rc" in
          0) ;;
          1) repin_bad=1 ;;
          *) echo "VIOLATION [$slug]: eval-lane rule could not run (exit $repin_evals_rc) — fail-closed; vendor lib/evidence-core.cjs + lib/eval-yaml.cjs per INIT-CI-COPY-LIST"; repin_bad=1 ;;
        esac
      else
        echo "NOTE [$slug]: eval-lane rule NOT ENFORCED — node or lib/evidence-core.cjs unavailable; a suite-only re-pin lane is not caught here"
      fi
    fi
    if [ -n "$repin_bad" ]; then violations=$((violations+1)); continue; fi
  fi
  # observed (schema v2): older reports with screenshot evidence never faced the
  # inspected-frames bar — tolerated, but must be visible.
  sv="$(front_field "$report" schema_version)"
  case "$sv" in (*[!0-9]*|'') sv=1 ;; esac
  if [ "$sv" -lt 2 ] \
     && grep -qiE '^[[:space:]]*screenshot[[:space:]]*[:=]' "$report" \
     && ! grep -qiE '^[[:space:]]*observed[[:space:]]*[:=]' "$report"; then
    echo "NOTE [$slug]: schema v$sv report has screenshot evidence without observed: — frame inspection was not machine-enforced for this report. Re-verify with template v2 to enforce."
  fi
  # network truth (wave 1, advisory): a claim-bearing network_observed (clean /
  # app-fail) must have its dump file on disk — vocab without evidence is NOTEd,
  # never blocked (nothing network-related is hook-enforced until schema v3).
  net_missing=0
  while IFS= read -r eid; do
    [ -n "$eid" ] || continue
    [ -f "$dir/evidence/${eid}-network.txt" ] || net_missing=$((net_missing+1))
  done <<NETIDS
$(awk 'tolower($0) ~ /^[[:space:]]*-[[:space:]]*eval:/ {id=$NF} tolower($0) ~ /^[[:space:]]*network_observed[[:space:]]*[:=][[:space:]]*["'\''"]?(clean|app-fail)($|[^a-z-])/ {print id}' "$report")
NETIDS
  if [ "$net_missing" -gt 0 ]; then
    echo "NOTE [$slug]: $net_missing network_observed claim(s) (clean/app-fail) with no evidence/E{id}-network.txt on disk — vocab without a dump file (advisory until schema v3)"
  fi
  # Re-verify the COMMITTED evidence with the same core the hook runs — catches a
  # report hand-edited after the write-time hook, or written under bypass.
  # ─── RECHECK-DIFF-SCOPE (1.41.0): sử liệu ngoài diff không bị re-check ────
  # Ngữ nghĩa GIỐNG luật staleness: bar này bảo vệ "bằng chứng đi kèm cây ĐANG
  # merge". Hồ sơ đã merge là sử liệu; soi lại chúng ở MỌI lượt CI biến một
  # quyết định đã duyệt trong quá khứ thành cái chặn mọi PR tương lai vì lý do
  # không liên quan gì tới PR đó. Đã cắn thật: hồ sơ lưu-kho gỡ khoá
  # `executors.script.mirror_sync` (tiêu chí AC-9 của nó), và 21 hồ sơ ĐÃ KÝ có
  # eval trỏ khoá ấy lập tức chặn merge — không hồ sơ nào trong 21 nằm trong
  # diff, không hồ sơ nào sửa được mà không viết vào vật đã ký.
  # Phạm vi dùng ĐÚNG hàm `slug_in_diff` mà gap-probe và staleness dùng — một
  # nguồn ngữ nghĩa slug↔diff, không parser thứ ba.
  # Guard kiểm DIFF_READY chứ KHÔNG kiểm $BASE: base-có-mà-diff-không-dựng-được
  # (clone shallow CI) phải rơi về kiểm-tất, không phải tắt im.
  # ĐÁNH ĐỔI, khai thẳng: thước thôi HỒI TỐ. Siết bar trong evidence-core.cjs
  # về sau sẽ không tự đo lại hồ sơ cũ. Đường cứu là cờ `--recheck-all`; không
  # có cờ đó thì cái mất này là vĩnh viễn chứ không phải tạm.
  if [ "$RECHECK_MODE" != off ]; then
    if [ -f "$RECHECK" ] && command -v node >/dev/null 2>&1; then
      # Guard đặt Ở ĐÂY, ôm đúng MỘT dòng gọi node, và dòng ấy giữ NGUYÊN VĂN cả
      # thụt lề — kể cả khi trông lệch mắt. Lý do: răng `additive-only` (DV5)
      # đòi diff của tệp này so với base CHỈ ĐƯỢC THÊM, không dòng luật cũ nào
      # bị xoá/sửa. Bản đầu của tôi viết lại `if [ "$RECHECK_MODE" != off ]`
      # thành `elif` và DV5 đỏ đúng như nó phải đỏ. Nắn thụt lề cho đẹp ở đây
      # là xoá một dòng luật cũ — đúng thứ răng ấy sinh ra để chặn.
      if [ "$RECHECK_ALL" -eq 0 ] && [ "$DIFF_READY" -eq 1 ] && ! slug_in_diff "$slug"; then # RECHECK-DIFF-SCOPE-GUARD
        RECHECK_SKIPPED=$((RECHECK_SKIPPED+1)); recheck_out=""; rc=0
      else
      recheck_out="$(node "$RECHECK" "$report" 2>&1)"; rc=$?
      fi
      if [ "$rc" -eq 1 ]; then
        if [ "$RECHECK_MODE" = strict ]; then label="VIOLATION"; else label="NOTE"; fi
        echo "$label [$slug]: committed evidence fails re-check (recheck: $RECHECK_MODE):"
        printf '%s\n' "$recheck_out" | sed 's/^/    /'
        if [ "$RECHECK_MODE" = strict ]; then violations=$((violations+1)); continue; fi
      elif [ "$rc" -ne 0 ]; then
        if [ "$RECHECK_MODE" = strict ]; then echo "VIOLATION [$slug]: evidence re-check KHÔNG CHẠY ĐƯỢC (exit $rc) — recheck: strict coi cổng câm là cổng hỏng; sửa: vendor lib/ cạnh scripts/, đọc được evidence-report.md"; violations=$((violations+1)); continue; fi
        echo "NOTE [$slug]: evidence re-check unavailable (exit $rc) — ${recheck_out:-skipped}"
      fi
    else
      if [ "$RECHECK_MODE" = strict ]; then
        if [ ! -f "$RECHECK" ]; then rc_duong="recheck-evidence.cjs vắng"; else rc_duong="node vắng"; fi
        echo "VIOLATION [$slug]: evidence re-check KHÔNG CHẠY ĐƯỢC ($rc_duong) — recheck: strict coi cổng câm là cổng hỏng; vendor scripts/recheck-evidence.cjs + lib/ và cài node"; violations=$((violations+1)); continue
      fi
      echo "NOTE [$slug]: evidence re-check not vendored (recheck-evidence.cjs/node missing) — committed-evidence bar NOT enforced"
    fi
  fi
  if [ "$LAN_V" = 1 ]; then echo "OK [$slug]: $verdict — làn V, máy đi tiếp không chữ ký (đã qua cùng chuỗi kiểm: hoá cũ · pin · làn eval · soi lại)"; continue; fi
  echo "OK [$slug]: $verdict, signed off by $signoff"
done

# Cắt im lặng đọc y hệt "đã phủ hết" — nên số hồ sơ KHÔNG được re-check phải in
# ra. Chỉ in khi có cắt thật: lần chạy không cắt gì thì thêm một dòng hằng là
# rác, và một dòng rác lặp lại là dòng người đọc học cách bỏ qua.
if [ "$RECHECK_SKIPPED" -gt 0 ]; then
  echo "NOTE: recheck scope — $RECHECK_SKIPPED slug ngoài diff PR không được re-check (sử liệu; dùng --recheck-all để quét toàn bộ)"
fi

# per-slug chỉ được ghi `ran` khi vòng lặp nhìn thấy ĐÚNG số thư mục mà phép
# đếm độc lập nhìn thấy.
[ "$SLUG_SEEN" -eq "$SLUG_EXPECTED_N" ] && ledger_mark ran per-slug

# ─── veto-có-dấu-vết (đợt 2) ────────────────────────────────────────────────
# Hai luật, hai kiểu hỏng khác nhau nên hai thông điệp:
#   (1) ĐẾM cửa đang mở — cắt im lặng đọc y hệt «đã phủ hết», nên phải in
#       đích danh slug, không chỉ tổng.
#   (2) CHIỀU ĐỔI, không phải trạng thái cuối. Đây là lỗ P0 của gap-probe:
#       owner gõ `da-veto`, máy sửa ngược về `mo` (hoặc xoá hẳn khoá) thì
#       trạng thái cuối trông sạch và veto của người bốc hơi không dấu vết.
#       So với BASE của diff; đường xử hợp lệ (có entry sổ quyết định khớp
#       slug) KHÔNG bị chặn oan.
VETO_OPEN_N=0; VETO_OPEN_SLUGS=""
if [ -d "$ACC" ]; then
  for dir in "$ACC"/*/; do
    [ -d "$dir" ] || continue
    slug="$(basename "$dir")"
    contract="$dir/contract.md"
    [ -f "$contract" ] || continue
    vstate="$(front_field "$contract" veto_state | tr '[:upper:]' '[:lower:]')"
    # Hồ sơ đã có chữ ký người thì cửa veto không còn là chốt đang giữ nó — đổi
    # nhãn TRƯỚC khi `case` đếm, để dòng `mo)` bên dưới giữ nguyên văn (DV5).
    # Nhãn `mo-da-ky` cố ý KHÔNG rỗng: nhánh ghi-ngược bên dưới đọc `$vstate`, và
    # một chuỗi rỗng ở đó nghĩa là «đã gỡ khoá» — nói dối về một hồ sơ còn khoá.
    if [ "$vstate" = "mo" ] && signoff_that "$dir"; then vstate="mo-da-ky"; fi
    case "$vstate" in
      mo)
        VETO_OPEN_N=$((VETO_OPEN_N+1))
        VETO_OPEN_SLUGS="$VETO_OPEN_SLUGS $slug" ;;
      da-veto)
        echo "VIOLATION [$slug]: veto_state=da-veto chưa xử — owner đã veto, hồ sơ không được merge ở trạng thái này. Xử bằng một trong hai đường rồi ghi entry sổ quyết định: quay hồ sơ về status draft để làm lại phạm vi, hoặc owner duyệt tay (approved_by)."
        violations=$((violations+1)) ;;
    esac
    # Trả nhãn tạm về ngay sau `case`: `mo-da-ky` chỉ sống ĐÚNG trong phép đếm ở
    # trên. Để nó chảy tiếp thì thông điệp của luật ghi-ngược in «da-veto ->
    # mo-da-ky» — một nhãn nội bộ rò ra câu nói với người, và đó là ĐỔI một câu
    # chặn chứ không còn là đổi lời của cửa veto (chân luat-lan-can bắt sống).
    if [ "$vstate" = "mo-da-ky" ]; then vstate="mo"; fi
    # chiều ghi-ngược — chỉ xét được khi dựng nổi phạm vi diff
    if [ "$DIFF_READY" -eq 1 ] && slug_in_diff "$slug"; then
      base_c="$(git -C "$ROOT" show "$BASE_SHA:_acceptance/$slug/contract.md" 2>/dev/null || true)"
      if [ -n "$base_c" ]; then
        base_v="$(printf '%s\n' "$base_c" | sed -n '/^---[[:space:]]*$/,/^---[[:space:]]*$/p' \
                  | sed -n 's/^veto_state[[:space:]]*:[[:space:]]*//p' | head -1 \
                  | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
        base_status="$(printf '%s\n' "$base_c" | sed -n '/^---[[:space:]]*$/,/^---[[:space:]]*$/p' \
                  | sed -n 's/^status[[:space:]]*:[[:space:]]*//p' | head -1 | tr -d '[:space:]')"
        if [ "$base_v" = "da-veto" ] && [ "$vstate" != "da-veto" ]; then
          if [ -s "$dir/decisions.jsonl" ] && grep -q "veto" "$dir/decisions.jsonl" 2>/dev/null; then
            echo "NOTE [$slug]: veto đã xử — veto_state da-veto -> ${vstate:-(gỡ khoá)} kèm entry sổ quyết định"
          else
            echo "VIOLATION [$slug]: veto_state da-veto -> ${vstate:-(gỡ khoá)} mà KHÔNG có entry sổ quyết định ghi việc xử — veto là quyết định của người, không được xoá bằng một lượt ghi của máy. Ghi entry vào decisions.jsonl rồi chạy lại."
            violations=$((violations+1))
          fi
        elif [ -n "$base_v" ] && [ -z "$vstate" ] && [ "$base_status" != "draft" ]; then
          echo "VIOLATION [$slug]: khoá veto_state biến mất khỏi một hồ sơ đã rời draft (base: $base_v) — gỡ khoá là xoá dấu vết cửa veto. Giữ khoá, hoặc ghi entry sổ quyết định cho việc xử."
          violations=$((violations+1))
        fi
      fi
    fi
  done
fi
if [ "$VETO_OPEN_N" -gt 0 ]; then
  echo "NOTE: cửa veto đang mở — $VETO_OPEN_N hồ sơ máy đã đi trước mà owner chưa veto:$VETO_OPEN_SLUGS"
fi
ledger_mark ran veto-trace

# gap-probe ghi sổ ở ĐÚNG MỘT chỗ, sau khi đã biết trọn lịch sử lần chạy. Bản
# trước mark từ HAI nơi độc lập — `declared-off` trong gap_probe_not_enforced()
# và `ran` trong vòng lặp — nên một lần chạy mà classifier thành công ở slug này
# và thất bại ở slug kia ghi CẢ HAI tên: chokepoint đếm 2 rồi exit 2, biến một
# suy giảm advisory (theo thiết kế chỉ NOTE, không chặn) thành chặn cứng, VÀ
# nuốt luôn dòng tổng kết violation thật của lần chạy đó — người đọc nhận đúng
# lời khuyên SAI ("không phải lỗi của bạn, báo maintainer").
# Thứ tự dưới đây là thứ tự trung thực: một lần chạy chỉ cưỡng chế được MỘT
# PHẦN thì khai là `declared-off`, không phải `ran`.
if [ "$GAP_PROBE_MODE" = "off" ]; then
  ledger_mark declared-off gap-probe          # tắt CÓ khai báo qua config (AC-3)
elif [ "$GP_NOT_ENFORCED" -eq 1 ]; then
  ledger_mark declared-off gap-probe          # mọi đường *_not_enforced (AC-12)
elif [ "$GP_RAN" -eq 1 ] || [ "$GP_SCOPE_N" -eq 0 ]; then
  # chạy thật ít nhất một slug, HOẶC vũ trang mà scope rỗng = đã làm trọn việc
  ledger_mark ran gap-probe
fi
# Còn lại (scope KHÔNG rỗng, không chạy, không khai tắt) = khối bị trượt qua:
# cố ý KHÔNG mark để chokepoint bắt (AC-2/AC-9).

# ── T1-escape backstop (PR-level) ────────────────────────────────────────────
# T1 is self-declared at Phase 0 from EXPECTED paths — nothing stops a "docs
# typo" PR from also touching src/billing/. With a PR base: changed files
# matching t3_paths — or falling outside t1_skip_globs — require the PR to
# carry _acceptance/<slug>/ artifacts. (Under the stale-evidence rule every
# gated PR re-verifies, so its diff always includes gate artifacts.) There is
# no path→slug mapping, so "carries artifacts" means any _acceptance/ change;
# the per-slug checks above judge their quality.
if [ "$T1_ESCAPE" -eq 0 ]; then
  t1_escape_not_enforced
elif [ "$DIFF_READY" -eq 0 ]; then
  echo "NOTE: T1-escape backstop skipped — $DIFF_SKIP_NOTE"
  # AC-3: thiếu --base là tắt CÓ khai báo (bỏ-qua-có-tín-hiệu, hành vi cũ).
  ledger_mark declared-off t1-escape
else
  # Phân loại đã tính MỘT lần trước vòng per-slug (khối «Phân loại
  # diff-chịu-cổng») — dùng lại, không tính lại.
  gate_touched="$DIFF_GATE_TOUCHED"; t3_hits="$DIFF_T3_HITS"; nont1_hits="$DIFF_NONT1_HITS"
  if [ "$gate_touched" -eq 0 ]; then
    if [ -n "$t3_hits" ]; then
      echo "VIOLATION [PR]: T3 paths (t3_paths) changed but the PR carries NO _acceptance/<slug>/ artifacts — critical code changed without the gate. Changed:"
      printf '%s' "$t3_hits" | head -10 | sed 's/^/    /'
      violations=$((violations+1))
    elif [ -n "$nont1_hits" ]; then
      echo "VIOLATION [PR]: non-T1 files changed (outside t1_skip_globs) but the PR carries NO _acceptance/<slug>/ artifacts — declare T1 honestly (t1_skip_globs) or run the gate. Changed:"
      printf '%s' "$nont1_hits" | head -10 | sed 's/^/    /'
      violations=$((violations+1))
    fi
  fi
  ledger_mark ran t1-escape
fi

# AC-16 vế sau: dòng tổng kết PHẢI khai là luật đã tắt. Một marker lẻ giữa hàng
# chục dòng output là thứ người đọc lướt qua; khai ở dòng cuối thì không.
[ "$GP_NOT_ENFORCED" -eq 1 ] && echo "pre-merge-check: gap-probe: KHÔNG cưỡng chế trong lần chạy này (xem dòng marker NOT ENFORCED ở trên)"
[ "$T1_ESCAPE_OFF" -eq 1 ] && echo "pre-merge-check: T1-escape: KHÔNG cưỡng chế trong lần chạy này (xem dòng marker NOT ENFORCED ở trên)"

# ─── Điểm nghẽn sổ luật: `clean` phải được chứng minh (AC-2/AC-5/AC-7) ──────
if [ "$LEDGER_ENABLED" -eq 1 ]; then
  ledger_bad=0
  for _n in $LEDGER_EXPECTED; do
    _c="$(ledger_count "$_n")"
    if [ "$_c" -eq 0 ]; then
      echo "VIOLATION [ledger]: luật $_n không chạy và không khai tắt"
      ledger_bad=1
    elif [ "$_c" -gt 1 ]; then
      echo "VIOLATION [ledger]: luật $_n ghi sổ $_c lần — trạng thái sổ không nhất quán"
      ledger_bad=1
    fi
  done
  for _w in $LEDGER_RAN $LEDGER_OFF; do
    case " $LEDGER_EXPECTED " in
      *" $_w "*) ;;
      *) echo "VIOLATION [ledger]: tên lạ $_w — cập nhật EXPECTED"; ledger_bad=1 ;;
    esac
  done
  # k lấy từ LEDGER_K (đếm EXPECTED lúc khai báo) — TUYỆT ĐỐI không n+m: in
  # tổng tự cộng là tautology không bao giờ hiển thị lệch được (AC-5).
  echo "pre-merge-check: rules ran=$LEDGER_RAN_N declared-off=$LEDGER_OFF_N expected=$LEDGER_K"
  if [ "$ledger_bad" -eq 1 ]; then
    echo "NOTE: VIOLATION [ledger] là lỗi NỘI TẠI của cổng pre-merge (một khối luật bị trượt qua hoặc sổ lệch) — KHÔNG phải lỗi trong thay đổi của bạn. Bước kế tiếp: báo maintainer của kit kèm TOÀN BỘ output lần chạy này; đừng sửa feature của bạn để né nó."
    exit 2
  fi
fi

if [ -n "$AC_LINE_FALLBACK_SEEN" ]; then
  echo "NOTE: cross-layer teeth graded with the built-in awk pattern, not lib/ac-line.cjs (node or the lib was unavailable). The teeth still fire — the awk form is WIDER than the shared parser, so it drops no criterion — but it does not reject cross-reference bullets and it closes the Criteria section at an H1, so a blocking finding reported above may be spurious. Install node / vendor lib/ac-line.cjs to grade on the same definition the rest of the kit uses."
fi

if [ -n "$NARROW_NET_SEEN" ]; then
  echo "NOTE: the placeholder net that just fired matches a SHORT FIXED prefix list — $(node "$CHU_KY_LIB" bang-mau 2>/dev/null) (dấu * = khớp tiền tố). NOTHING else is treated as a placeholder: unlisted English holds (FIXME, placeholder, LGTM), curt words (ok, yes, x, .), and holds written in any other language ALL PASS the net. Bảng ở lib/evidence-core.cjs là MỘT nguồn — câu này đọc từ đó, không chép lại."
fi

if [ -n "$NARROW_NET_BLIND" ]; then
  echo "NOTE: lưới giữ-chỗ của chữ ký KHÔNG chạy được lượt này — thiếu node hoặc thiếu lib/evidence-core.cjs (mang cổng vào repo phải copy CẢ lib/). Chốt «chữ ký rỗng» vẫn chặn; riêng phép phân loại giữ-chỗ (bảng ở lib/evidence-core.cjs, xem \`node lib/evidence-core.cjs bang-mau\`) không kiểm được, nên một dòng giữ chỗ có thể lọt. NOTE này không chặn."
fi

if [ "$LEGACY_SIGN_KNOB" -eq 1 ]; then
  echo "NOTE: signoff.require_human_commit/agent_authors đã hết hiệu lực từ 2.1 — provenance chữ ký lấy từ forge (PR approval / người bấm merge); gỡ khoá khỏi config.yaml"
fi

if [ "$violations" -gt 0 ]; then
  echo "pre-merge-check: $violations violation(s) — merge blocked"
  exit 1
fi
echo "pre-merge-check: clean"
exit 0
