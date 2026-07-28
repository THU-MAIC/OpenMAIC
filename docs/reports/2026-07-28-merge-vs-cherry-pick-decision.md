# v0.3.1 同步路线决策：全量合并 vs 定向 cherry-pick

> 2026-07-28 · 基于 git 实测数据（非估算）
> 前置文档：`docs/DRY-RUN-V031-MERGE-REPORT.md`（全量合并冲突面）/ `docs/runtimestore-conflict-scan.md`（RuntimeStore 线）
> 结论先行：**推荐方案 C（混合路线）——先定向 cherry-pick 元素级编辑链拿功能，安全修复单独捞，全量架构对齐并入既有 Phase 1+2/Phase 4 节奏，不做一次性全量 merge。**

---

## 1. 现状数据（2026-07-28 实测）

| 维度 | 数字 |
|---|---|
| fork `main` 落后 upstream/main | **67 commits**（53 个 ∈ v0.3.1，14 个为发布后新增） |
| fork `main` 领先 upstream/main | 206 commits（自研：Supabase RBAC / MiniMax / admin / 移动端 / PR1-3） |
| 分叉点 | 2026-07-06（`04b70f03`） |
| 工作区状态 | ⚠️ 有未提交改动（course-assets / Supabase Storage 迁移进行中） |

### v0.3.1 三大宣传功能对照

| 功能 | fork 现状 | 判定 |
|---|---|---|
| ⚛️ 元素级 AI 编辑 | **完全缺失**（无 `edit_elements`） | 🔴 最大差距 |
| 📖 资料一键成课 | 有基础版（#741：PDF/DOCX/PPTX）；缺 xlsx、音视频提取（AliDocMind #887）、document bundles M3、MinerU 增强 | 🟡 部分落后 |
| 🤖 课堂智能体管理 | `AgentRosterPanel` 与 v0.3.1 **逐字节一致**（#816 在分叉点前）；仅缺 07-27 的 roster 单一数据源重构（#994） | 🟢 不落后 |

---

## 2. 方案 A：全量 merge v0.3.1

依据 `DRY-RUN-V031-MERGE-REPORT.md`（07-24 dry-run 实测）：

- 冲突 18 文件 / 24 hunks；P0 业务冲突 4 个（classroom page / database.ts v14↔v15 schema 分叉 / stage-storage / settings）
- 预估 **1–1.5 周全职**（解冲突 3–4 天 + 测试 2–3 天 + 回归修复 1–2 天）
- 隐藏风险：9 个 `supabase-*.sql` 与 v0.3.1 运行时的 schema 命名冲突未排查

**致命问题**：全量 merge 会把 RuntimeStore/DocumentStore 的**业务切流**（#926/#955/#965 等）一起带进来——这正是 fork 自己 Phase 1+2/B2.x 计划要**受控、灰度、带开关**做的事（B2.1 决策：`NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE` 默认关、Dexie 保持唯一读写源）。一次性 merge 与既有渐进策略直接冲突，且 classroom page 的 P0 冲突本质是两套 scene-order / loadClassroom 演进路线相撞。

**判定：不推荐现在做。**

---

## 3. 方案 B：定向 cherry-pick 元素级编辑链（实测依赖链）

### 3.1 链路与规模

| 顺序 | commit | 内容 | 规模 |
|---|---|---|---|
| 1 | `191689f9` | 渲染器 v2：元素选择 + 拖拽移动（#851 Part A） | 23 文件 / +3571 |
| 2 | `ff300b07` | 8 点缩放 + 旋转手柄 | 15 文件 / +2408 |
| 3 | `09f490cf` | 框选多选 + 多元素拖拽 | 19 文件 / +2900 |
| 4 | `cc5a6ab1` | `edit_elements`：自然语言 → EditIntent（#895） | 45 文件 / +7198 |
| 5 | `ebb12b5f` | 带校验的 JSON Patch 元素编辑（#927） | 18 文件 / +2000 |

合计 ~18k 行，**但绝大部分是新文件**（renderer editing 模块、lib/agent/tools/edit-elements*、测试）。

### 3.2 冲突面实测（关键结论）

- 5 个 commit 触及的文件，与 fork 206 个自研 commit 改过的文件做交集：**仅 8 个 i18n locale + package.json + pnpm-lock.yaml**
  - i18n：key 集合并集，可脚本化（dry-run 报告 P2 已验证此模式）
  - package.json / pnpm-lock：`pnpm install` 重生成
- `packages/@openmaic/renderer/`：**fork 从未碰过**（分叉点至今零改动）
- `lib/agent/`、`components/slide-renderer/`、`components/edit/`：fork 从未碰过
- **业务代码预期零冲突**

### 3.3 架构依赖实测

- 新增代码对 `@openmaic/storage` / RuntimeStore / DocumentStore 的 import：**0 处**
- 依赖 `@openmaic/dsl`（fork 已有，且 Part A runtime envelope 已 cherry-pick 入库）
- 依赖 `@openmaic/renderer/editing`（来自本链 1–3 号 commit，自包含）
- `edit-elements-patch.ts` 由 `ebb12b5f` 自身引入，无链外依赖

**判定：技术上高度可摘。预估 2–4 天（cherry-pick + i18n 脚本合并 + tsc + vitest + 冒烟），只有方案 A 的 1/3。**

### 3.4 ⚠️ 运行时风险：MiniMax 工具调用（2026-07-28 更新：风险大幅降级）

`edit_elements` 是 pi-agent 框架的 native tool-calling 链路（`build-agent.ts` → V0_ALLOWLIST → StreamFn → 服务端 `resolveModelFromRequest` / `MODEL_ROUTES` / `DEFAULT_MODEL`）。

**关键事实**：fork 的 `V0_ALLOWLIST` 已有 **4 个 agent tools 在生产运行**（`read_scene_content` / `regenerate_scene` / `regenerate_scene_actions` / `edit_interactive_html`），走的就是同一框架、同一服务端模型解析路径、同一 MiniMax 端点。`edit_elements` 只是已验证链路上的第 5 个工具。

- "MiniMax 是否支持 tool-calling" → 已不再是开放问题（前提是线上 AI 编辑面板确实可用，需 owner 确认）
- 残留风险：`edit_elements` 要求模型输出 RFC 6902 JSON Patch（`test`/`add`/`replace` + 路径语义），对指令遵循能力要求高于现有工具；MiniMax M2.7 的 patch 准确率需实测——影响"好不好用"，不影响"能不能跑"
- 架构兼容性 ✅：上游路由本身支持服务端 `MODEL_ROUTES` 按 stage 配模型，与 fork"服务端统一配、客户端零配置"原则一致，老师/学员无需任何配置

---

## 4. 方案 C（推荐）：混合路线

按「功能价值 ÷ 风险」分四条独立轨道，各自可单独上线、单独回滚：

### 轨道 1（P0，立即）：元素级编辑链 cherry-pick
- 即方案 B 的 5 commit 链，新分支 `feat/element-editing-v031`
- Day 1 上午先做 MiniMax tool-calling 探针（§3.4），不通则暂停评估降级方案
- 顺带可摘 `40ff80ab`（拖拽插入工具栏 #912）——同区域、独立、低险

### 轨道 2（P0，立即，2–3 小时）：SSRF 精准回捞
- PROJECT-STATE Backlog 已立项：11 个 media adapter 的 `redirect: 'manual'`（v0.3.1 #930 被搁置后的真实安全缺口）
- 按操作规约 §3：安全类 commit 必须独立测试 + 主干 tsc 双通过

### 轨道 3（P1，跟随既有 Phase）：资料导入增强
- xlsx / 音视频提取（#887）/ document bundles M3（#844）/ MinerU 增强
- **前提**：先完成当前工作区未提交的 course-assets / Supabase Storage 迁移——两边在同区域施工，避免自我冲突

### 轨道 4（P2，挂 Phase 4 之后）：全量架构对齐
- RuntimeStore/DocumentStore 业务切流、视频导出管线（#864–866）、playback canvas、#994 roster 重构
- 跟随 B2.1 → B2.2 → B2.3 的受控节奏，不做一次性 merge
- v0.3.1 之后上游还在快进（14 commits/周），等 Phase 4 时基线应重新评估，目标可能是 v0.3.2+

---

## 5. 执行前置条件（铁律合规）

1. **先处理工作区未提交改动**（course-assets 迁移）——commit 或 stash，遵守 `git reset --hard` 铁律
2. 所有 cherry-pick 在新分支进行，打 `pre-element-editing-baseline` tag
3. i18n 用脚本合并后必须跑 `node scripts/check-i18n-keys.mjs`
4. 每轨道独立 PR，遵守 Rebase 检查清单（金丝雀测试 9/9 等）
5. 拍板结论当天入库 PROJECT-STATE.md「关键决策记录」

---

## 6. 需要 owner 拍板的点

| # | 决策 | 建议 |
|---|---|---|
| 1 | 是否采用方案 C（混合路线） | ✅ 推荐 |
| 2 | 轨道 1 是否本周启动 | ✅ 推荐；首日先做 MiniMax tool-calling 探针 |
| 3 | 若 MiniMax 不支持 tools：降级方案（走解析文本协议模拟 tool call / 临时切其他 provider） | 探针出结果后再议 |
| 4 | 轨道 3 与当前 course-assets 迁移的先后 | 建议迁移先收尾，避免同区域双线施工 |
