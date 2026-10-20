# Course Series 开发日志

跟踪"材料超预算时自动拆分成多门课程系列"功能的开发过程。背景、范围与架构决策见对应 PR / 会话记录中的方案（Phase 1-4 调研与计划）。本文件只记录逻辑单元级别的进展，每个逻辑单元完成后在此追加一条记录，并同步 `git commit`。

## 范围回顾

- 拆分粒度：按字符预算均分，不做章节/页码语义切分（首版）。
- 多子课程执行顺序：顺序执行，第 N+1 部分等第 N 部分 `completed` 后才启动。
- 落地范围：优先完成后端编排能力，前端只做最小必要改动（超预算提示 + 系列徽标）。

---

## 2025-xx-xx（本次会话）

### 单元 1：材料切分算法

**改动**：
- `lib/document/bundle.ts`：导出原本私有的 `truncateTextAtBoundary`，供切分模块复用同一套 Unicode 边界截断逻辑，避免重复实现。
- `lib/document/series-split.ts`（新增）：
  - `materialNeedsSeriesSplit(parts, maxChars)`：判断材料总字符数是否超出单课程预算。
  - `splitMaterialIntoSeries(parts, maxChars)`：按材料原始顺序（`source.order`），把超预算的 `ParsedDocumentPart[]` 切成多组，每组对应系列中的一门课程；单个文档本身超预算时会被再切成多个连续分片（分片 id 带 `#n` 后缀区分）。保证不丢字符（只在分片边界做语义边界回退，不做内容截断）。
- `tests/document/series-split.test.ts`（新增）：9 个用例，覆盖未超预算、跨多文档拆分、单文档超预算内部分片、图片只随第一个分片保留、`source.order` 重新编号、输入顺序无关性等边界情况。

**验证**：
- `vitest run tests/document/series-split.test.ts tests/document/bundle.test.ts`：14/14 通过。
- 过程中发现一处测试断言设计错误（假设每个文档只会出现在一个系列分组里，但单文档跨分组分片时同一 base id 会连续出现在相邻分组），修正为校验"原始顺序不回退"而不是"每个 id 只出现一次"。

**环境问题记录（非代码问题）**：
- 本会话历史中反复出现 `corepack pnpm` 递归自我 fork 成上百个子进程的情况（`corepack pnpm pnpm pnpm ...`），会拖慢甚至拖死后续命令。再次遇到测试命令异常挂起时，先用 `pgrep -fl 'corepack pnpm pnpm'` 排查，`pkill` 清理后改用 `./node_modules/.bin/vitest` 直接调用二进制，绕开这层壳。

**Commit**：`feat(document): add material series-splitting algorithm`

---

### 单元 2：数据库层 —— course_series 新表 + generation_runs/stage_meta 系列列

**改动**：
- `lib/persistence/course-series.ts`（新增）：`course_series` 表（`id`, `owner_id`, `title`, `part_count`, `pending_parts` JSONB, `created_at`），独立的 `ensureCourseSeriesSchema`，采用与 `generation-runs.ts` 相同的“独立模块自带迁移集”写法。`pending_parts` 暂存尚未启动为 run 的后续分片材料（`MaterialSeriesPart[]`），因为那些 run 还不存在，材料无处安放。
- `lib/persistence/generation-runs.ts`：migration 6（`series`）给 `generation_runs` 加 `series_id`、`series_order` 列和一条部分索引；不加外键到 `course_series`，因为两个模块的 schema 各自独立引导（bootstrap），不能假设对方的表已存在。
- `lib/persistence/stage-meta.ts`：migration 3（`series`）给 `stage_meta` 镶镜像的 `series_id`、`series_order` 列（课程本身需要留自己的一份拷贝，因为 run 完成后其 checkpoint 会被压实清除，不能永远依赖 run 行）。新增 `setStageSeries()` setter，`StageMetaRow`/`readStageMeta` 同步返回这两个字段。
- `lib/server/generation/run/types.ts`：`GenerationRunSnapshot` 新增必填字段 `series: GenerationRunSeriesMembership | null`；新增 `GenerationRunSeriesMembership { seriesId, order }` 类型。
- `lib/server/generation/run/store.ts`：`RunRow`/`RUN_COLUMNS`/`storedRun()`/`runSnapshot()` 同步新增 `series_id`/`series_order` 的读取与映射；`CreateRunOptions` 新增可选 `series` 字段，`createGenerationRun()` 的 INSERT 语句据此写入（系列归属在创建时一次性确定，之后不可变更，所以放在创建选项里而不是 `RunPatch` 里）。

**验证**：
- `tsc --noEmit`：全量通过。唯一受影响的下游是 `tests/api/generate-classroom.test.ts` 里手工构造 `StoredRun` 的测试 fixture，补了 `series: null` 字段后类型检查通过。
- `vitest run tests/api/generate-classroom.test.ts tests/document/series-split.test.ts tests/document/bundle.test.ts`：59/59 通过。
- **未能验证**：`tests/server/generation-runs.pg.test.ts` 等 `.pg.test.ts` 契约测试需要真实 Postgres（通过 `PG_CONTRACT_URL` 环境变量注入），本机沙箱内没有可用的 Postgres 或 Docker（`pg_isready`、`docker` 均不可用），这些套件会被 `describe.skipIf(!contractUrl)` 自动跳过，无法在本环境验证新迁移的实际执行效果（列是否正确创建、索引是否生效等）。建议在有 Postgres 的环境里至少跑一次 `generation-runs.pg.test.ts` 和 `stage-meta-tenancy.pg.test.ts`。

**Commit**：`feat(persistence): add course_series table and series columns`

---
