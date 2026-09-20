// workspace-record.cjs — LUẬT DUY NHẤT trả lời "hồ sơ của slug này có hỏng
// không", dùng chung bởi MỌI bên đọc `_acceptance/<slug>/`.
//
// Vì sao một chỗ: bản đồ sản phẩm và bộ quét vào phiên là hai READER của cùng
// một bộ hồ sơ. Ở S4-r1 chúng đã trôi khỏi nhau ngay lần đầu ra mắt — cùng một
// `uat-session.md` mất frontmatter, bộ quét gọi là hỏng còn bản đồ xếp vào
// "Đã ship — chờ phiên nghiệm thu". Hai kết luận trái nhau về cùng một sự thật
// là false-green đúng nghĩa, và vá riêng từng bên chỉ dời chỗ trôi. Ai thêm
// bên đọc thứ ba thì gọi hàm này, đừng chép luật.
const { frontmatterField, machineClearedSignoffConflict } = require('./evidence-core.cjs');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');

// ĐỌC hồ sơ — ENOENT (file vắng) là tin bình thường; MỌI lỗi khác là sự thật
// phải nêu tên. Nuốt chung một rọ biến "mất quyền đọc" thành "không có file",
// và slug bị phân ô theo artifact bên cạnh: bản đồ từng xếp một việc mất quyền
// đọc contract.md vào "Sắp mở vòng" trong khi bộ quét gọi nó là hỏng (S4-r14,
// dựng lại được bằng chmod 000). Ngữ nghĩa đọc là MỘT PHẦN của luật đọc hồ sơ,
// nên nó ở đây chứ không phải một `read` cục bộ trong từng reader.
function readRecord(p) {
  try { return { t: readFileSync(p, 'utf8'), err: null }; }
  catch (e) { return e.code === 'ENOENT' ? { t: null, err: null } : { t: null, err: e }; }
}

const ioReason = err => `không đọc được (${err.code})`;

// Luật khoá theo (FILE, FIELD) chứ không theo tên field trần: `stage` là HAI
// enum khác nhau — `discovery|decided|archived` trong opportunity.md và
// `scheduled|held` trong uat-session.md. Bảng khoá theo tên trần thì người sau
// thêm cặp uat/stage vào sẽ gắn nhầm enum của opportunity và bắn "hồ sơ hỏng"
// lên MỌI phiên nghiệm thu hợp lệ, ở cả hai reader cùng lúc (S4-r3).
//
//   required  — file có mặt thì khoá phải ĐỌC ĐƯỢC (null = frontmatter hỏng
//               hoặc thiếu hẳn key, cả hai là hồ sơ hỏng).
//   allowEmpty— giá trị RỖNG là trạng thái hợp lệ (khoá cố ý để trống tới lúc
//               người ký). Rỗng ở khoá không allowEmpty là hồ sơ hỏng, không
//               phải khoảng trống vô hại.
const NAV_RULES = {
  'contract.md': {
    status: { enum: ['draft', 'approved', 'implemented', 'verified', 'signed-off', 'machine-cleared'], required: true },
  },
  'opportunity.md': {
    stage: { enum: ['discovery', 'decided', 'archived'], required: true },
    decision: { enum: ['build', 'iterate', 'park', 'kill'], allowEmpty: true },
  },
  'uat-session.md': {
    verdict: { enum: ['release', 'iterate', 'kill'], required: true, allowEmpty: true },
    stage: { enum: ['scheduled', 'held'], allowEmpty: true },
  },
  // `verdict` ở đây là enum CỦA CỔNG MÁY — khác hẳn enum release/iterate/kill
  // của phiên nghiệm thu ngay trên. Khoá theo (FILE, FIELD) là để hai thang
  // điểm này không bao giờ chấm lẫn nhau (AC-2 workspace-reader-unification).
  'evidence-report.md': {
    verdict: { enum: ['pass', 'pending-judgment', 'reject', 'blocked'], required: true },
  },
};

// Hai file NÀY là bằng chứng một slug tồn tại. Chỉ có `uat-session.md` mà
// thiếu cả hai là hồ sơ hỏng — KHÔNG được lọt qua rồi biến mất khỏi mọi ô
// (hồi quy S4-r3: bản vá gộp luật đã xoá mất nhánh này).
const ANCHOR_FILES = ['contract.md', 'opportunity.md'];

const NAV_FIELDS = Object.entries(NAV_RULES)
  .flatMap(([file, fields]) => Object.keys(fields).map(field => [file, field]));

function fieldProblem(file, txt, field) {
  const rule = (NAV_RULES[file] || {})[field];
  if (!rule) return null;
  const raw = frontmatterField(txt, field);
  if (raw == null)
    return rule.required ? { file, reason: `frontmatter không đọc được hoặc thiếu ${field}` } : null;
  if (raw === '')
    return rule.allowEmpty ? null : { file, reason: `${field} không nhận diện được: (rỗng)` };
  if (!rule.enum.includes(raw.toLowerCase()))
    return { file, reason: `${field} không nhận diện được: ${raw}` };
  return null;
}

// ĐIỀU KIỆN TIÊU THỤ — luật DUY NHẤT trả lời "trạng thái này DÙNG hồ sơ nào".
//
// Vì sao ở đây chứ không để mỗi reader tự suy: bảng enum đã gom về một chỗ ở
// S4-r3 nhưng điều kiện tiêu thụ thì vẫn chép đôi, nên hai bên tiếp tục trôi
// khỏi nhau ở r12 (bản đồ soi opportunity.md trên lối bộ quét không đọc) và ở
// r13 (bộ quét bỏ qua stage của phiên nghiệm thu, bỏ qua decision lạ khi stage
// chưa `decided`). Gom LUẬT mà để lại ĐIỀU KIỆN GỌI LUẬT là gom một nửa: cùng
// một bảng enum áp lên hai tập hồ sơ khác nhau vẫn ra hai kết luận khác nhau.
//
// Doctrine (start-scan-hardening, học qua 4 round): hồ sơ nào trạng thái hiện
// tại KHÔNG dùng thì lỗi của nó không được quyết định ô của slug.
//   contract.md    — luôn tiêu thụ, nó quyết định mọi lối.
//   uat-session.md — chỉ khi hợp đồng đã ký.
//   opportunity.md — chỉ khi KHÔNG có hợp đồng (còn ở khám phá), HOẶC đã ký mà
//                    phiên nghiệm thu chưa chốt verdict (lúc đó mới dò đường A).
// HAI trạng thái «đã thông Cổng Bằng chứng»: người ký (`signed-off`) hoặc máy thông
// (`machine-cleared` — xanh-sạch sáu điều kiện, KHÔNG chữ ký; lưới trước-merge kiểm lời
// khai đó). Mảng export để các bên đọc HỎI, đừng chép — chép là hai bản trôi.
const DA_THONG_CONG_2 = ['signed-off', 'machine-cleared'];
function usesUat(contractTxt) {
  if (contractTxt == null) return false;
  return DA_THONG_CONG_2.includes((frontmatterField(contractTxt, 'status') || '').toLowerCase());
}

function usesOpportunity(contractTxt, uatTxt) {
  if (contractTxt == null) return true;
  if (!usesUat(contractTxt)) return false;
  return !(uatTxt != null && frontmatterField(uatTxt, 'verdict'));
}

// Trạng thái nào TIÊU THỤ hồ sơ bằng chứng (đọc và kiểm khuôn khi file có):
// implemented (máy đang chấm) và verified (máy chấm xong chờ ký). signed-off
// KHÔNG tiêu thụ — ma trận P105 ghim: sau ký, ô của slug do uat/decision quyết,
// evidence hỏng không được lôi việc đã ký về "hồ sơ hỏng".
const EVIDENCE_CONSUMING = ['implemented', 'verified', 'machine-cleared'];
function usesEvidence(contractTxt) {
  if (contractTxt == null) return false;
  return EVIDENCE_CONSUMING.includes((frontmatterField(contractTxt, 'status') || '').toLowerCase());
}

// Luật khai-xong-mà-thiếu-file (trước sống RIÊNG ở start-scan và pre-merge):
// CHỈ verified đòi file phải tồn tại — implemented chưa chấm lần nào thì vắng
// là bình thường (bước kế là S4). Trả {file, reason} hoặc null.
// `machine-cleared` cũng đòi file: nó TỰ KHAI sáu điều kiện xanh-sạch, mà lời khai không
// có vật thì không kiểm được. Luật ở ĐÂY chứ không ở từng reader — bản vá riêng trong
// start-scan là đúng hình dạng đã làm hai bên trôi khỏi nhau ở r12/r13 (P123 bắt lại).
const ARTIFACT_REQUIRING = ['verified', 'machine-cleared'];
function missingArtifact(texts) {
  const c = texts['contract.md'];
  if (c == null) return null;
  const st = (frontmatterField(c, 'status') || '').toLowerCase();
  if (!ARTIFACT_REQUIRING.includes(st)) return null;
  if (texts['evidence-report.md'] != null) return null;
  return { file: 'evidence-report.md', reason: `status ${st} nhưng thiếu evidence-report.md` };
}

// Mâu thuẫn hai sự thật: hồ sơ tự khai «máy thông, không chữ ký» mà báo cáo lại có chữ ký.
// Cùng chỗ với missingArtifact vì cùng vai: luật đọc hồ sơ, mọi reader hỏi chung.
function conflictProblem(texts) {
  const msg = machineClearedSignoffConflict(texts['contract.md'], texts['evidence-report.md']);
  return msg ? { file: 'evidence-report.md', reason: msg } : null;
}

// Nhận NGUYÊN văn 3 file đã đọc, trả đúng tập được tiêu thụ (file bị loại →
// null). Bên đọc nào cần đọc lười thì gọi thẳng usesUat/usesOpportunity để
// quyết định có mở file hay không, rồi vẫn đi qua hàm này — một đường duy nhất.
function consumedTexts({ contract = null, opportunity = null, uat = null, evidence = null }) {
  const u = usesUat(contract) ? uat : null;
  return {
    'contract.md': contract,
    'opportunity.md': usesOpportunity(contract, u) ? opportunity : null,
    'uat-session.md': u,
    'evidence-report.md': usesEvidence(contract) ? evidence : null,
  };
}

// texts: { 'contract.md': string|null, 'opportunity.md': ..., 'uat-session.md': ... }
// Trả { file, reason } cho vấn đề ĐẦU TIÊN gặp, hoặc null nếu hồ sơ đọc được.
function recordProblem(texts) {
  if (ANCHOR_FILES.every(f => texts[f] == null))
    return { file: '(workspace)', reason: 'không có contract.md lẫn opportunity.md' };
  for (const [file, field] of NAV_FIELDS) {
    if (texts[file] == null) continue;
    const p = fieldProblem(file, texts[file], field);
    if (p) return p;
  }
  return null;
}

// Giá trị điều hướng đã chuẩn hoá (chữ thường, '' khi vắng) — chỉ gọi SAU khi
// recordProblem trả null, lúc đó mọi giá trị đều đọc được và hợp enum.
// `stage` ở đây là stage của OPPORTUNITY (thứ quyết định ô); stage của phiên
// nghiệm thu không tham gia phân ô nên không trả ra, tránh lẫn hai enum.
function navValues(texts) {
  const pick = (file, field) => {
    const txt = texts[file];
    if (txt == null) return '';
    const raw = frontmatterField(txt, field);
    return raw == null ? '' : raw.toLowerCase();
  };
  return {
    status: pick('contract.md', 'status'),
    stage: pick('opportunity.md', 'stage'),
    decision: pick('opportunity.md', 'decision'),
    verdict: pick('uat-session.md', 'verdict'),
  };
}

// ĐỌC một danh sách trong `_acceptance/config.yaml` (t1_skip_globs, t3_paths…)
// — cắt ĐÚNG section rồi bóc `- `, comment đuôi, và nháy. Regex quét cả file
// thì sai hai chiều: `- "PRODUCT-MAP.md"   # bản đồ` bị coi là chưa khai (âm
// tính giả), còn cùng chuỗi nằm dưới `t3_paths:` lại bị coi là đã khai (dương
// tính giả). Bản bash trong scripts/pre-merge-check.sh làm đúng các bước này;
// hai bên đọc cùng một khoá không được cho hai kết luận trái nhau (S4-r15).
function configList(cfgTxt, key) {
  const lines = String(cfgTxt || '').split('\n');
  // Dòng khoá được mang comment đuôi (`  t1_skip_globs:   # ghi chú`) — bản
  // bash của pre-merge đọc được hình dạng này, neo `\s*$` ở đây thì bản JS
  // trả rỗng và hai bên đọc cùng một khoá cho hai kết luận trái nhau
  // (bug round 16 product-map-uat-session, Notes của contract kế nhiệm).
  const start = lines.findIndex(l => new RegExp('^\\s{2}' + key + ':\\s*(#.*)?\\r?$').test(l));
  if (start < 0) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s{0,2}[A-Za-z0-9_-]+:/.test(line)) break;      // sang khoá kế
    const m = line.match(/^\s*-\s*(.*)$/);
    if (!m) continue;
    const v = m[1].replace(/\s*#.*$/, '').trim().replace(/^["'](.*)["']$/, '$1').trim();
    if (v) out.push(v);
  }
  return out;
}

// ── Trạng thái bản đồ sản phẩm — MỘT bảng nhãn cho mọi bên đọc ──────────────
// Ba bên từng giữ ba chuỗi riêng (product-map --check, bộ quét /start, thân
// lệnh start.md) nên "đã xoá" ở nơi này là "chưa dựng" ở nơi khác. State suy
// từ hai tín hiệu máy-kiểm-được:
//   exists  — PRODUCT-MAP.md có trong cây làm việc
//   tracked — repo coi bản đồ là PHẢI CÓ: index/lịch-sử git, HOẶC config khai
//             PRODUCT-MAP.md trong t1_skip_globs (tín hiệu duy nhất sống được
//             trên checkout nông của CI — không cần lịch sử)
function mapState({ exists, tracked }) {
  return exists ? 'dang-co' : (tracked ? 'da-xoa' : 'chua-bat');
}
const MAP_LABELS = {
  'dang-co': 'đang có',
  'da-xoa': 'PRODUCT-MAP.md đã bị xoá khỏi cây làm việc',
  'chua-bat': 'repo chưa bật bản đồ sản phẩm',
};

// tracked — MỘT nguồn tín hiệu cho mọi bên đọc (S4-r1 vòng này: bộ quét chỉ
// hỏi config còn cổng CI hỏi cả git, nên cây clone-đầy-đủ có bản đồ từng
// commit mà config không khai bị hai bên kết luận trái nhau). Ba tín hiệu,
// tín hiệu nào TRÚNG trước trả trước:
//   daBat     — config khai PRODUCT-MAP.md trong t1_skip_globs (không cần
//               lịch sử — tín hiệu duy nhất sống trên checkout nông của CI)
//   trongIndex— git còn theo dõi file (xoá khỏi cây làm việc chưa commit)
//   tungBiXoa — lịch sử có lần xoá (PR đã commit việc xoá)
// git vắng/không phải repo → hai tín hiệu git im lặng, còn lại config.
function mapTracked(root, cfgTxt) {
  if (configList(cfgTxt || '', 't1_skip_globs').includes('PRODUCT-MAP.md')) return true;
  const git = args => {
    try {
      return execFileSync('git', ['-C', root, ...args],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return null; }
  };
  if (git(['ls-files', '--error-unmatch', '--', 'PRODUCT-MAP.md']) != null) return true;
  if ((git(['log', '--diff-filter=D', '--format=%H', '-1', '--', 'PRODUCT-MAP.md']) || '').trim() !== '') return true;
  return false;
}

module.exports = {
  NAV_RULES, NAV_FIELDS, ANCHOR_FILES,
  recordProblem, navValues, fieldProblem,
  usesUat, usesOpportunity, usesEvidence, missingArtifact, consumedTexts,
  readRecord, ioReason, configList, conflictProblem,
  mapState, MAP_LABELS, mapTracked,
  DA_THONG_CONG_2,
};
