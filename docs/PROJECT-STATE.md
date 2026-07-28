# RJ-laixue 项目状态

> 维护者：研发协作  
> 最近更新：2026-07-24  
> 配套文档：`docs/CLAUDE.md`（AI 协作项目记忆） / `docs/reports/`（阶段报告） / `docs/diff-from-upstream.md`（与 OpenMAIC 差异）

---

## 当前阶段

**Phase 0 完成 ✅**，准备进入 **Phase 1+2**（RuntimeStore 架构 cherry-pick）。

| 阶段 | 状态 | 报告 |
|---|---|---|
| Phase 0 — 救火 + 安全 + 基线 | ✅ 完成 | [2026-07-24-phase0.md](reports/2026-07-24-phase0.md) |
| Phase 1+2 — RuntimeStore + DocumentStore cherry-pick | ⬜ 待启动 | — |
| Phase 3 — learnerKey 决策 spike | ⬜ 待启动（与 Phase 1+2 并行） | — |
| Phase 4 — 31 文件切流 + SupabaseRuntimeStore | ⬜ 业务平稳期另立项 | — |

---

## 关键决策记录

### ✅ 已拍板（按时间倒序）

| 决策 | 日期 | 理由 | 记录位置 |
|---|---|---|---|
| **v0.3.1 同步走混合路线**（不全量 merge）：元素级编辑 5-commit 链定向 cherry-pick；SSRF `redirect:'manual'` 精准回捞；资料导入增强等 course-assets 收尾；架构对齐挂 Phase 4 | 2026-07-28 | 全量 merge 实测 1-1.5 周全职且强行带入 RuntimeStore 业务切流，与 B2.x 渐进策略冲突；编辑链与 fork 自研文件零业务冲突、零架构依赖 | `docs/reports/2026-07-28-merge-vs-cherry-pick-decision.md` |
| **Phase 4 接法选型 A**：Next.js API routes 实现上游 HTTP 契约，服务端再访问 Supabase；不让浏览器直连 PostgREST 写 RuntimeStore | 2026-07-28 | append/CAS/冲突处理需事务边界；统一走 api-guard 做 Auth/角色/课程访问/审计；service_role 必须显式鉴权 | 同上 + Codex 施工边界确认 |
| **持久化目标架构 = 部署期可替换 adapter**：上游 HttpStore 客户端 → RJ Next.js API → adapter（云上 Supabase+RLS / 私有化自托管 Postgres+企业认证）；**每部署单权威后端，不做双写** | 2026-07-28 | 私有化部署已立项（GFW 阻断事件加速）；上游 compose/reference server 可作私有化运行形态参考，但其身份授权不进生产 | `docs/handoffs/2026-07-27-gfw-block-handoff.md` |
| **learnerKey = auth.uid() 对 access_code 无歧义**：6 位码只在已登录 Supabase Auth 后绑定 `students.user_id`；未登录持码人无 RuntimeStore 分区写权限；分享语义是"已登录学员/老师拿链接学习"，非匿名访问码学习 | 2026-07-28 | `app/api/access-code/redeem/route.ts` 明确要求 Auth 登录后绑定 | Codex 施工边界确认 |
| **17 个未提交 course-assets 文件归属 WorkBuddy**：非 Codex B2 在制品，由 WorkBuddy 独立验证、独立 commit 后才做上游操作 | 2026-07-28 | 边界澄清，避免双线施工互相污染 | Codex 施工边界确认 |
| **edit_elements 供应链核实**：上游真实实现为 `cc5a6ab1`（NL→EditIntent，typebox 契约 RFC 6902 test/add/replace）+ `ebb12b5f`（带校验 JSON Patch）；fork 现有 `edit_interactive_html` 是 oldText→newText 替换，**非** JSON Patch；MiniMax M2.7 的 Patch 准确率未经实测 | 2026-07-28 | 纠正"已有 4 工具 ⇒ Patch 质量已验证"的推断——只能确认 tool-calling 链路可用，不能确认 Patch 质量 | 决策文档 §3.4 |
| **Phase 0 修开关位置**：从 `fireAndForgetAutoSave` 函数内部上移到调用点 | 2026-07-24 | saveStageToCloud 有 3 个调用点（自动 / 顺序修复回传 / 手动按钮），开关只管"自动"那条 | commit `21712c39` |
| **Next_PUBLIC_LEGACY_AUTOSAVE 命名 + 默认开** | 2026-07-24 | 语义准确；保留 PR1 行为；设 `=0` 关闭 | commit `21712c39` |
| **59a8bac6 SSRF 修复搁置**（v0.3.1 #930） | 2026-07-24 | modify/delete 冲突：`probe-auth.ts` 在 RJ-laixue 已删，改走 `api-guard` 路线 | Phase 0 报告 §二 |
| **59a8bac6 真实攻击面 + api-guard 覆盖对照** | 2026-07-24 | 11 个 media adapter 在 `testXxxConnectivity` 用 `redirect: 'follow'` 默认；ssrf-guard 只校验单 URL，不处理 fetch redirect 行为；**有缺口**——`redirect: 'manual'` 修复不能被 `api-guard` 或 `ssrf-guard` 替代 | 见本页"SSRF 风险对照表" |
| **Phase 1+2 修正版 B（cherry-pick Part A+B）** | 2026-07-24 | 三 commit cherry-pick 实测 0-3 冲突，seq 风险需"写端归一"或"读端 wrapper"修 | `docs/reports/2026-07-24-independent-review.md` |
| **learnerKey 决策**：v0.3.1 默认走 `learnerKey = crypto.randomUUID()` 不适合 RJ-laixue | 2026-07-24 | 内训平台每个学员有 Supabase Auth；`learnerKey = auth.uid()` 更贴合 | `docs/HANDOFF-FOR-CLAUDE-FABLE-5.md` §3.4 |
| **RuntimeStore 是机会不是负担** | 2026-07-24 | 上游用 9.2 万行解决的正是 RJ-laixue 自研兜底想解决的事 | `docs/DRY-RUN-V031-MERGE-REPORT.md` |
| **DSL 扩展字段扫描** | 2026-07-24 | 12 个 RJ 扩展字段（4 Stage + 5 Scene + 1 Audio + 2 DB 镜像），**7 个**在 DocumentStore 路径下需存活（sceneOrderTrusted/seq/teacherVoiceConfig/narrationText/kind/interactionType/name） | `docs/fork-extensions.md` |
| **P0-2 修复 POST /api/courses upsert 越权** | 2026-07-24 | service_role 写 + 无 owner 校验 + 硬编码 `created_by: user.id` → 任意登录用户可覆盖他人课程 + 静默转移所有权。最小修复：upsert 前查 owner；UPDATE 分支不写 created_by；6 个测试覆盖 | `docs/reports/2026-07-24-p0-2-courses-upsert.md` + commit `9be2ba5e` |
| **83fdecf3 严格校验实测**：静默通过未知字段 | 2026-07-24 | `validateStage`/`validateScene` 只查已知字段；`splitDocument` spread 保留——RJ 扩展字段不会丢。但未来上游可能改严格模式 | `docs/fork-extensions.md` 关键问题段 |

### ⏳ 待拍板

| 决策 | 触发时机 | 备注 |
|---|---|---|
| **seq 风险修复方案**：写端归一（推荐）vs 读端 wrapper vs 双保险 | Phase 1+2 启动前 | Fable 5 推荐写端归一 |
| **PR1+2+3 是否立即上生产** | Phase 0 完成 | Vercel preview 冒烟确认 |
| **api-guard.ts 是否覆盖 media adapter 出站 URL 拉取** | Phase 4 启动前 | 关联 59a8bac6 搁置决策的兜底验证 |

### 📋 Backlog

- [ ] api-guard.ts 覆盖 media adapter（kling/seedream）出站 URL 验证
- [ ] 上游 v0.3.1 完整同步评估（独立 PR review）
- [ ] PR1+2+3 + LEGACY_AUTOSAVE 开关在 Vercel preview 实测（本地 build 阻塞）
- [ ] **media adapter `redirect: 'manual'` 精准回捞**（11 个 adapter，v0.3.1 #930 修复被搁置后的真实安全缺口）
- [ ] Phase 1+2 cherry-pick 后加 7 个 DSL 扩展字段的金丝雀测试
- [ ] Phase 4 评估 `sceneOrderTrusted` / `seq` / `sceneOrderRepairedAt` 退役条件（写端归一后可考虑）
- [ ] Phase 1+2 之后复扫 app/api/ 写操作路由，确认新引入路由都带 owner/role 校验

## SSRF 风险对照表（任务二产出）

**59a8bac6 真实修复的向量**：12 个 media adapter 在 `testXxxConnectivity` 函数内的 `fetch()` 调用加 `redirect: 'manual'`——阻止 fetch 默认跟 3xx 重定向到内网地址。

| Adapter | 修复方式 | api-guard 覆盖？ | ssrf-guard 覆盖？ | 风险 |
|---|---|---|---|---|
| comfyui-image | `redirect: 'manual'` | ❌（不涉及 URL 校验）| ❌（只校验单 URL）| ⚠️ adapter 在 v0.3.0 已删，**修改丢失** |
| grok-image / grok-video / happyhorse / kling / lemonade-image / nano-banana / openai-image / qwen-image / seedance / seedream / veo | `redirect: 'manual'` | ❌ | ❌ | ⚠️ **11 个 adapter 当前在 RJ-laixue 都用默认 `redirect: 'follow'`，真 SSRF 风险** |
| probe-auth.ts + 2 tests | modify/delete 冲突 | n/a | n/a | 搁置（RJ 走 api-guard 路线） |

**关键结论**：
- `redirect: 'manual'` 是**独立**的修复向量（fetch redirect 行为），不是单 URL 校验问题
- `api-guard.ts` 不涉及 URL 校验
- `ssrf-guard.ts`（7c2aaafc 已加）只校验**单 URL**（黑名单 IP/协议），不处理 fetch redirect 行为
- **`redirect: 'manual'` 修复不能被任何 RJ 现存模块替代**——是真实安全缺口

**Phase 4 处理建议**：精准回捞——只 cherry-pick 11 个 adapter 文件的 `redirect: 'manual'` 改动（不取 probe-auth.ts + 2 tests），2-3 小时工作量。

---

## main 分支当前状态

```
9be2ba5e security: P0-2 修复 POST /api/courses upsert 越权写入       ← HEAD
6d7142a1 fix(ssrf): harden provider redirects and ISATAP detection (#928)
21712c39 chore: PR1 autosave 加 NEXT_PUBLIC_LEGACY_AUTOSAVE 开关
92904f72 docs: v0.3.1 cherry-pick 冲突预检报告
431a221e docs: v0.3.1 merge dry-run 冲突清单报告
e428c4ab chore: 加 Supabase schema 自动 dump workflow
e0fa358c chore: 维护周 - 上游差异清单 + CLAUDE.md + README 锐捷定制说明
6287ae23 PR3: 生成超时机制（单页 3min + 整体 15min）
8b70ad9a PR2: 生成过程实时进度 UI（每个 outline 状态可见）
ac91244e PR1: 生成完成后自动保存到云端（fire-and-forget）
bfe7cae3 i18n: 修正老师主页文案位置（误改回滚 + 重新分配）
```

**Tag**：`pre-runtimestore-baseline` (6d7142a1)

---

## 操作规约（铁律）

### 1. `git reset --hard` 铁律

> **2026-07-24 今日两次违反此规约导致工作差点/真的丢失**：
> - 第一次：工作树里 LEGACY_AUTOSAVE 开关改动被 reset 清掉（独立评审发现并修正）
> - 第二次：cp/ssrf-1 分支上 commit 67e92657 被 reset 清掉（用户发现后重做）

**`git reset --hard` 前必须自查**：

1. 当前分支是否有未合入 main 的 commit？
   - 是 → 先 merge 或打 tag
2. 工作树是否有未提交改动？
   - 是 → 先 `git stash` 或 commit
3. 两者任一存在 → **不** reset

**例外**：明确知道要丢弃的废弃分支 → `git branch -D <branch>` 删分支，不需要 reset。

### 2. 拍板类结论及时入库

拍板类结论（如"59a8bac6 搁置"、"LEGACY_AUTOSAVE 默认开"）必须当天进入本文档"关键决策记录"区域，否则会重复询问/拍板。

### 3. SSRF / 安全相关 commit 必须独立测试

cherry-pick 安全类 commit 后：必须跑该 commit 自带的测试文件 + 主干 tsc，**双重通过**才进 main。

### 4. 改"调用点" vs 改"函数内部"

新增 feature flag / 开关时，**优先在调用点加**（明确局部化作用域），不在共享函数内部加（容易误伤其他调用方）。判断标准：开关影响的范围 = 多少个调用方？1 个 → 函数内 OK；>1 个 → 调用点分别加。

### 5. 不顺手重构

"看不顺眼" ≠ "需要改"。Phase 0 任务卡明确"不碰 packages/@openmaic/*" + "不顺手重构"。

### 7. WorkBuddy 注入的 NODE_OPTIONS 解法（P0-1b）

**问题**：WorkBuddy 桌面端全局注入 `NODE_OPTIONS=--require=".../genie-safe-delete.cjs" --use-system-ca`。Next.js 16 的 Worker 拒绝 `--use-system-ca`，build 报 `ERR_WORKER_INVALID_EXEC_ARGV`。

**定位**：环境变量，非项目配置。

**解决（按优先级）**：

| 场景 | 命令 | 备注 |
|---|---|---|
| 临时 unset（开发够用） | `NODE_OPTIONS="" npx next build` 或 `set NODE_OPTIONS= && pnpm build` | 临时清空，shell 退出即失效 |
| 企业内网证书必须保留 | `NODE_OPTIONS=--require=...genie-safe-delete.cjs NODE_EXTRA_CA_CERTS=<证书路径> pnpm build` | 只保留 `--require`（WorkBuddy 自用），CA 走 `NODE_EXTRA_CA_CERTS`（Next.js 接受） |
| 永久 CI 配置 | Vercel Dashboard → Project Settings → Environment Variables → 设置 `NODE_OPTIONS=--require=...` | 别把 `--use-system-ca` 推到 Vercel |

**验证**：`✓ Compiled successfully in 22.2s` 实测通过。

**预防**：CI 跑 build 时**先 unset NODE_OPTIONS**——避免 WorkBuddy 全局注入污染 production build。

### 6. service_role 写必须显式 owner/role 校验

**2026-07-24 P0-2 教训**：`app/api/courses/route.ts:POST` 走 service_role 但缺 owner 校验 + 硬编码 `created_by: user.id`，导致任意登录用户可覆盖他人课程 + 静默转移所有权。

**新规约**：

- 任何**新增**的 `serviceSupabase.from(...).upsert/insert/update/delete` 调用，**必须**在同函数内显式做以下任一校验：
  - `serviceSupabase.from('profiles').select('role').eq('id', user.id).maybeSingle()` 查 role（admin/teacher）
  - 或先查 existing row 的 owner，校验 `existing.created_by === user.id`
- 路由只解构已知白名单字段（`{ id, title, topic, data }` 等），**永不**把 `created_by` / `updated_at` 等敏感字段从 body 透传到 upsert payload
- 现有 `getServerSupabase()`（user session）路径**不需要**这条规约——RLS 自动管

未来 Phase 4 切流到 RuntimeStore 时再 review，但**任何 service_role 写路径都不允许零校验**。

## Rebase 检查清单（Phase 4 必跑）

每次 rebase 上游 OpenMAIC v0.3.x 之后，跑以下检查：

- [ ] `tsconfig.json` paths 中 `@openmaic/dsl` 映射是否仍指向有效入口（`./packages/@openmaic/dsl/src/index.ts`）。上游改包名 / 入口路径时失效，症状友好（tsc 大面积"找不到模块"），不会静默腐烂。
- [ ] 金丝雀测试 `tests/dsl/extensions-canary.test.ts` 全过（9/9）—— 验证 RJ 扩展字段不丢 / runtimeOnly 正确剥离。
- [ ] 上游 DSL 的 `validateStage` / `validateScene` 仍是 6 字段静默通过——若上游加 strict 模式立即报错（详见 P1-b 报告 §3.3）。
- [ ] `lib/dsl-extensions/registry.ts` 的 CLOUD_PERSISTED 清单与上游 DSL 已声明字段无重叠——若上游补同名字段（如 scene.audioUrl）需去重。

---

## 未解决问题 / 阻塞

### Build 环境配置阻塞

```
Error: Initiated Worker with invalid NODE_OPTIONS env variable:
--use-system-ca is not allowed in NODE_OPTIONS
```

- **影响**：本地 `npx next build` 失败，Vercel preview 冒烟无法在本地进行
- **与本次代码无关**：Vercel 部署环境继承的 `NODE_OPTIONS` 配置问题
- **建议解决**：Vercel Dashboard → Project Settings → Environment Variables → 找到 `NODE_OPTIONS`，删掉 `--use-system-ca`（或整个变量）

---

## 关键基础设施

- **上游同步**：`git remote -v` → `upstream = https://github.com/THU-MAIC/OpenMAIC.git`
- **tags**：`v0.3.0` / `v0.3.1`（已 fetch）
- **Supabase 9 SQL**：按顺序应用 `supabase-learning-mvp.sql` → `supabase-auth-mvp.sql` → ...
- **PR 跟踪**：本周已合的 3 个 PR（PR1-3）已在 main，未推到 origin/main

---

## 联系 Fable 5 / 上游同步

- `docs/HANDOFF-FOR-CLAUDE-FABLE-5.md`：项目背景包
- `docs/diff-from-upstream.md`：与 v0.3.0 的差异（人可读）
- `docs/diff-from-upstream-commits.md` / `docs/diff-from-upstream-files.md`：原始 git log
- `docs/DRY-RUN-V031-MERGE-REPORT.md`：v0.3.1 全量 merge dry-run
- `docs/runtimestore-conflict-scan.md`：Phase 1+2 cherry-pick 实测

---

## 2026-07-27 B2.1 决策：DocumentStore 安全桥接

- `NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE` 默认 `0`；关闭时完全绕过 DocumentStore，Dexie 保持唯一课程读写源。
- B2.1 仅在成功读取旧 Dexie 课程后后台复制；校验或 IndexedDB 失败必须降级为继续使用 Dexie，绝不阻断 UI。
- 新 DocumentStore 数据库按 `SHA-256(auth.uid())` 前 32 个十六进制字符（128 bit）命名空间隔离；旧 Dexie 的历史设备级缓存归属不可倒推，另立项处理。
- B2.1 后先做 B2.2 双读指纹校验，再另立 B2.3 主读写切换；本期不接 RuntimeStore/learnerKey/Supabase。

## 2026-07-27 CI 基线门禁决策

- GitHub CI 的 E2E 必须通过 Playwright 夹具建立合成登录态并拦截 inert Supabase 测试请求；禁止在生产认证代码中添加 E2E 绕过。
- 本地/CI 的 standalone 输出只能用 `node .next/standalone/server.js` 启动，不能用 `next start`。
- 在全仓历史 Prettier/ESLint 债务清理前，`pnpm check` 与 `pnpm lint` 只校验本次 push/PR 的变更文件；不得以全局 `--write` 混入无关格式化改动。
- `pnpm test` 固定使用 `vitest run --no-file-parallelism`：251 个测试文件中有重试/流式全局 mock 与计时器型旧测试，文件级并发会制造假超时；串行全量实测 2017/2017 通过（约 150 秒）。
