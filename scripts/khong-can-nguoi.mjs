// khong-can-nguoi.mjs — vị từ «hồ sơ verified chưa ký này còn cần người không?»
//
// Đây là câu mà lưới trước-merge (scripts/pre-merge-check.sh) hỏi một hồ sơ
// `status: verified` chưa có chữ ký, ở HAI chỗ:
//   Cổng 1 — `approved_by` rỗng ⇒ đòi làn V đúng vết (veto_state: mo, vết giờ
//            parse được, hạng T2); thiếu ⇒ VIOLATION.
//   Cổng 1 — hoặc `gate1_skipped: true` (người chủ động miễn cổng) ⇒ lưới chỉ NOTE.
//   Cổng 2 — chữ ký rỗng ⇒ đòi SÁU điều kiện xanh-sạch (xanh_sach_check):
//            verdict PASS · bypass_used không true · hạng T2 · 0 mục UNCERTAIN ·
//            «Known limits» HIỆN DIỆN-và-rỗng · «Ngoài hợp đồng» HIỆN DIỆN-và-rỗng.
//            Và TRƯỚC đó lưới chặn `enforcement_mode: off` (cổng không làm gì lúc
//            ghi) — đọc cùng khối frontmatter, nên hỏi ở đây luôn (S4-r3 bắt).
//   Và `da-veto` là phát ngôn của người: lưới chặn tới khi xử.
//
// Máy quét vào phiên (start-scan.mjs) dùng vị từ này để quyết «đã giao, không
// hiện ở mục chờ ký» hay «còn ở cổng». Vòng một của hồ sơ lan-v-khong-phai-cho-ky
// chỉ hỏi veto_state và lệch NGƯỢC chiều an toàn: hồ sơ chưa sạch biến mất khỏi
// danh sách chờ ký trong khi lưới vẫn chặn.
//
// Đây là BẢN DỰNG THỨ HAI của luật (bản một là bash trong pre-merge-check.sh),
// cố ý KHÔNG gọi chung lúc chạy: «một nguồn» giữ bằng phép đo đẳng thức trên
// chính pre-merge-check.sh (tests/plugins/lan-v.test.mjs LV5) — hai bản độc lập
// thì đột biến bên nào cũng làm phép so đỏ. Không sống ở lib/ (t3_paths) là chủ
// ý của hồ sơ T2; sổ known-limits lan-v-khong-phai-cho-ky#7 ghi lớp «hai bản dựng
// độc lập chỉ được giữ bằng ma trận fixture chọn tay» (S4-r3 từng bỏ sót hai điều kiện).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { frontmatterField, vetoGateState } = require(path.join(__dirname, '..', 'lib', 'evidence-core.cjs'));
const { section } = require(path.join(__dirname, '..', 'lib', 'md-section.cjs'));

// Cùng regex với bash: grep -qiE '(^|[^a-z])UNCERTAIN([^a-z]|$)' trên TRỌN file.
const UNCERTAIN_RE = /(^|[^a-z])UNCERTAIN([^a-z]|$)/i;

// Tiêu đề có mặt? — hỏi RIÊNG với «thân rỗng» (vắng ≠ rỗng). Ranh tiêu đề là
// #{2,6} — CÙNG ranh với section() của lib/md-section.cjs. Nhận cả h1 ở đây mà
// section() không nhận là h1 «Known limits» có nội dung bị đọc thành «rỗng» ⇒
// sạch giả (S4-r5 bắt; bash xanh_sach_check đang mang đúng lỗi đó — sổ #9).
function sectionState(txt, heading) {
  const has = txt.split('\n').some(l => /^#{2,6}\s+/.test(l)
    && l.replace(/^#{2,6}\s+/, '').trim().toLowerCase() === heading.toLowerCase());
  if (!has) return 'vang';
  return section(txt, heading).join('\n').trim() ? 'co' : 'rong';
}

// Sáu điều kiện xanh-sạch, CÙNG THỨ TỰ với xanh_sach_check để `why` nêu cùng
// điều kiện trượt đầu tiên. Trả { clean, why }.
export function xanhSach(contractTxt, evidenceTxt) {
  if (evidenceTxt == null) return { clean: false, why: 'không có evidence-report.md' };
  const v = (frontmatterField(evidenceTxt, 'verdict') || '').trim();
  // KCN-PASS: chỉ PASS mới sạch.
  if (v !== 'PASS') return { clean: false, why: `verdict=${v} (chỉ PASS mới xanh-sạch)` };
  const bp = (frontmatterField(evidenceTxt, 'bypass_used') || '').trim().toLowerCase();
  if (bp === 'true' || bp === '1' || bp === 'yes') return { clean: false, why: `bypass_used=${bp}` };
  // KCN-ENF: lưới chặn enforcement_mode=off TRƯỚC khi tới nhánh xanh-sạch — bỏ
  // sót là máy quét giấu đúng hồ sơ lưới đang chặn (S4-r3, chiều lệch ngược an toàn).
  const enf = (frontmatterField(evidenceTxt, 'enforcement_mode') || '').trim().toLowerCase();
  if (enf === 'off') return { clean: false, why: 'enforcement_mode=off (cổng không làm gì lúc ghi)' };
  const tier = (frontmatterField(contractTxt, 'risk_tier') || '').trim().toUpperCase();
  if (tier !== 'T2') return { clean: false, why: `hạng ${tier} (chỉ T2 được đi tiếp không ký)` };
  if (UNCERTAIN_RE.test(evidenceTxt)) return { clean: false, why: 'có mục UNCERTAIN' };
  for (const h of ['Known limits', 'Ngoài hợp đồng']) {
    const st = sectionState(evidenceTxt, h);
    if (st === 'vang') return { clean: false, why: `mục «${h}» VẮNG khỏi báo cáo (vắng ≠ rỗng)` };
    if (st === 'co') return { clean: false, why: `mục «${h}» có nội dung` };
  }
  return { clean: true, why: '' };
}

// Trả null khi hồ sơ CÒN cần người; trả tên trạng thái «đã giao» khi không:
//   'lan-v-mo'  — cửa veto ĐANG MỞ: máy đã đóng một cổng (Cổng 1 hoặc Cổng 2)
//                 với vết `veto_state: mo` — bất kể người có duyệt Cổng 1 hay không
//                 (release-2-0-0: approved_by có tên + mo ở Cổng 2 ⇒ cửa vẫn mở)
//   'xanh-sach' — không có cửa veto: người đóng/miễn Cổng 1, Cổng 2 xanh-sạch
// Thứ tự nhánh tường minh (AC-4): da-veto cắt trước → chữ ký (bên gọi xử) →
// Cổng 1 → Cổng 2.
export function khongCanNguoi(contractTxt, evidenceTxt) {
  const veto = vetoGateState(contractTxt);
  // KCN-VETO: veto là phát ngôn của người — không bao giờ «đã giao».
  if (veto.present && veto.state === 'da-veto') return null;
  // KCN-SACH: Cổng 2 — sáu điều kiện.
  if (!xanhSach(contractTxt, evidenceTxt).clean) return null;
  // Cổng 1 — người duyệt, hay máy đóng đúng vết.
  const approvedBy = (frontmatterField(contractTxt, 'approved_by') || '').trim();
  // KCN-SKIP: người chủ động miễn Cổng 1 — lưới chỉ NOTE, không chặn (cùng luật với
  // lưới ghi-lúc-viết). Khác V: đây là người miễn, V là máy đóng và người giữ veto.
  const gate1Skipped = /^(true|yes|1)$/i.test((frontmatterField(contractTxt, 'gate1_skipped') || '').trim());
  const vMo = veto.present && veto.state === 'mo' && veto.stamped && veto.tier === 'T2';
  if (vMo) return 'lan-v-mo';
  if (approvedBy || gate1Skipped) return 'xanh-sach';
  return null;
}

// ── CLI: đường GHI ô kết (duong-lui-phai-song AC-8) ─────────────────────────
//   node khong-can-nguoi.mjs --write|--check --root <repo> --slug <slug>
// verified + T2 + khongCanNguoi() ≠ null → ghi đúng dòng status thành machine-cleared,
// tự kiểm bằng CHÍNH luật lưới ghi-lúc-viết (evaluateContractWrite) trước khi ghi đĩa.
// Exit: 0 ghi/sẽ ghi · 2 chưa đủ (in lý do, không ghi) · 3 thiếu cờ hoặc không đọc được.
// So bằng realpath: /var → /private/var trên macOS làm argv[1] và import.meta.url lệch nhau
// khi script chạy từ một bản sao trong thư mục tạm (chân ket-ghi chiều đỏ M1/M2 im lặng exit 0).
const _isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (_isMain) {
  const argv = process.argv.slice(2); const get = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const mode = argv.includes('--write') ? 'write' : argv.includes('--check') ? 'check' : null;
  const root = get('--root'), slug = get('--slug');
  if (!mode || !root || !slug) { console.error('khong-can-nguoi: dùng --write|--check --root <repo> --slug <slug>'); process.exit(3); }
  const { evaluateContractWrite, machineClearedSignoffConflict } = require(path.join(__dirname, '..', 'lib', 'evidence-core.cjs'));
  const cp = path.join(root, '_acceptance', slug, 'contract.md'), ep = path.join(root, '_acceptance', slug, 'evidence-report.md');
  let contract, evidence;
  try { contract = fs.readFileSync(cp, 'utf8'); } catch { console.error(`khong-can-nguoi: không đọc được ${cp}`); process.exit(3); }
  try { evidence = fs.readFileSync(ep, 'utf8'); } catch { evidence = null; }
  const status = (frontmatterField(contract, 'status') || '').trim().toLowerCase();
  const tier = (frontmatterField(contract, 'risk_tier') || '').trim().toUpperCase();
  const why = status !== 'verified' ? `status ${status || '(rỗng)'} (chỉ verified)`
    : tier !== 'T2' ? `hạng ${tier || '(rỗng)'} (chỉ T2)`
    : (khongCanNguoi(contract, evidence) == null ? (xanhSach(contract, evidence).why || 'còn cần người') : '');
  if (why) { console.error(`chưa đủ: ${why}`); process.exit(2); }
  // Dòng status của khuôn hợp đồng mang comment đuôi (`status: verified   # draft | approved | …`) —
  // giữ nguyên phần comment, chỉ thay giá trị (S4-r2 finding: regex đòi hết dòng làm cửa ghi
  // duy nhất thất bại với lý do sai trên mọi hợp đồng sinh từ khuôn).
  const next = contract.replace(/^(status:[ \t]*)verified([ \t]*(?:#.*)?)$/m, '$1machine-cleared$2');
  if (next === contract) { console.error('chưa đủ: không tìm được dòng status: verified'); process.exit(2); }
  const r = evaluateContractWrite(next, contract);
  if (r.anyFailure) { console.error(`lưới ghi từ chối: ${r.failures.join(' | ')}`); process.exit(2); }
  // Luật THỨ HAI của hook ghi-lúc-viết (hooks/acceptance-evidence-gate.js): chữ ký người trên hồ sơ
  // máy-thông là hai sự thật cãi nhau — CLI ghi thẳng đĩa không qua hook nên phải hỏi cùng luật
  // (S4-r1/r3 finding: ca ký bị ngắt giữa chừng rồi resume vào hàng verified).
  const conflict = machineClearedSignoffConflict(next, evidence);
  if (conflict) { console.error(`lưới ghi từ chối: ${conflict}`); process.exit(2); }
  if (mode === 'write') fs.writeFileSync(cp, next);
  console.log(`${mode === 'write' ? 'machine-cleared' : 'sẽ machine-cleared'}: ${slug}`);
}
