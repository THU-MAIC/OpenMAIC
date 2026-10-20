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

### 单元 3：GenerationRunInput.seriesContext + 材料切片应用 + 纯规划函数

**设计决策**：材料是按 `materialId` 存储、独立走提取流水线的真实上传文件，系列中的每个 run 不应该拥有一份“派生材料”（会重复一整套提取/配额/生命周期机制）。改为：系列里每个 run 的 `materialIds` 和原始材料一致，但 `GenerationRunInput.seriesContext.textRanges` 携带「这个 run 只教每个材料文本的哪一段 `[start, end)`」，在 `analyzeMaterials` 组装 `ParsedDocumentPart[]` 时按此切片，再交给既有的 `buildDocumentBundle`。不在系列中的 run 该字段缺省，行为完全不变。

**改动**：
- `lib/server/generation/run/types.ts`：`GenerationRunInput` 新增可选 `seriesContext: { seriesId, order, textRanges }`。
- `lib/server/generation/run/services.ts`：`RunStepServices.analyzeMaterials` 新增可选第 4 参数 `textRanges`；默认实现据此过滤掉完全不在范围内的材料（文本和图片都不带），对范围内的材料做文本切片；只有材料切片里的第一段（`range.start === 0`）保留图片，呼应切分算法本身"图片只跟第一个分片走"的约定。
- `lib/server/generation/run/engine.ts`：`material-analysis` 步骤调用处把 `input.seriesContext?.textRanges` 传给 `analyzeMaterials`。
- `lib/server/generation/series/plan.ts`（新增）：纯函数 `planCourseSeries(parts, maxChars)`，包一层 `splitMaterialIntoSeries`，把切分结果转换成每个系列分部的 `textRanges`（通过跟踪每个原始材料 id 被消费到的偏移量，把 `#n` 分片 id 还原回在原文本里的字符区间）。预算内返回 `null`。与真正落库、创建 run 的编排器（下一单元）分开，保持可以脱离数据库单测。
- `tests/server/generation/series-plan.test.ts`（新增）：5 个用例，覆盖预算内返回 null、材料各自独占一个分部时拿到完整区间、单材料跨分部时区间连续不重叠且拼接还原原文、以及按区间切出的文本能精确重建原文档切片。

**验证**：
- `tsc --noEmit`：全量通过（包括 `engine.ts`、`services.ts` 的新参数)。
- `vitest run tests/server/generation/series-plan.test.ts`：5/5 通过。
- `RunStepServices.analyzeMaterials` 的其他调用点都在 `*.pg.test.ts` 契约测试里（同单元 2 提到的环境限制，无法在本沙箱跑），但新参数是可选的，不会导致这些测试在 compile 阶段出错；运行期行为是否符合预期仍待有 Postgres 的环境验证。

**Commit**：`feat(generation): thread series text ranges through material analysis`

---

### 单元 4：系列编排层 + material-analysis 自动晋升 + run 完成自动续接

**背景与设计决策（重要，接手前请先读完这一段）**：

一个系列从不被“主动创建”——没有任何 API 一开始就说“我要开一个系列”。系列是在某个普通 run 执行到 `material-analysis` 步骤、读到自己的材料时，*被动发现*的：如果材料按单课程预算（`MAX_PDF_CONTENT_CHARS`）切分后超出一门课程能装的量，这个 run 就当场晋升为该系列的第 1 部分，`course_series` 表这时才第一次出现一行记录。后续每一部分都是等前一部分的 run `completed` 之后，由 run 引擎自己在 `complete()` 内部触发创建的，不经过任何 HTTP 请求——整条系列从发现到跑完全程不需要用户或前端再操心。这是为什么 `lib/server/generation/series/orchestrator.ts` 里没有"创建系列"这个独立入口：`startCourseSeries()` 只能从"刚发现自己超预算"的那个 run 的 `material-analysis` 步骤内部调用，`startNextSeriesPart()` 只能从"刚完成"的 run 的 `complete()` 内部调用。

**一个会影响后续所有决策的教训**：最初的设计（写在 `plan.ts` 的单元 3 commit 里）是 `course_series.pending_parts` 存完整的 `ParsedDocumentPart[]`（含图片的 base64）。写到这一单元要落库时才意识到问题：`GenerationRunSnapshot.input` 会原样塞进每次 run 状态轮询的 HTTP 响应体（`lib/server/generation/run/types.ts:263`），如果 `pending_parts` 也存这么重的结构，虽然它不直接出现在 `input` 里，但这提醒了我——“系列相关的任何东西只要可能被扔进这类会被序列化返回的结构里，就不能带大字段”。于是把 `pending_parts` 改成只存 `textRanges`（`Record<materialId, {start,end}>`，几个数字），需要真正的切片文本/图片时，到了那一部分自己的 run 跑到 `material-analysis` 时才按 `textRanges` 现场从已经提取好的材料（`readMaterialExtractionResult`，有缓存）里切，重新切一次的代价几乎为零。**如果后续要改 `pending_parts` 的结构，先确认新结构不会把大字段（文本全文、图片字节）放进任何可能被整体序列化返回给前端的结构里。**

**改动**：

- `lib/persistence/course-series.ts`：
  - 重新设计 `pendingParts`：从"完整 `ParsedDocumentPart[]`"改为 `PendingSeriesPart[]`（`{ order, textRanges }`，与 `plan.ts` 产出的分部形状一致）。
  - 新增 `materialIds` 列（`material_ids` JSONB）：系列每一部分读的都是同一份原始材料列表，不是派生材料，这份列表只需要存一次，放在 `course_series` 行上，`pendingParts` 不必各自重复携带。
  - 新增三个函数：
    - `createCourseSeries(queryable, { ownerId, title, materialIds, partCount, restParts })`：建系列行。调用方（晋升中的 run）自己就是第 1 部分，不出现在 `restParts` 里。
    - `getCourseSeries(queryable, id, ownerId)`：按 owner 读单条，供编排器和（将来的）API 用。
    - `claimNextPendingSeriesPart(queryable, seriesId)`：`SELECT ... FOR UPDATE` 锁行后弹出 `order` 最小的一条待启动分部并原子更新 `pending_parts`，保证 run 完成事件的重试不会和另一次调用抢到同一个分部。
- `lib/server/generation/series/orchestrator.ts`（新增）：编排层，只给 `engine.ts` 用，不直接对外：
  - `planSeriesSplit(parts, maxChars?)`：薄包装 `planCourseSeries`，把结果拆成 `{ firstPart, restParts }`。
  - `startCourseSeries({ ownerId, title, materialIds, plan })`：落一行 `course_series`，返回 `seriesId`。
  - `startNextSeriesPart(ownerId, seriesId, base, limits)`：读系列行、`claimNextPendingSeriesPart` 弹出下一分部、以该分部的 `textRanges` 构造新的 `GenerationRunInput`（`materialIds` 用系列的全量材料列表，`outlineReview` 强制为 `'auto'`——系列后续分部没有人在前端等着确认大纲，不能卡在等人确认上）后调用 `createGenerationRun`。没有下一分部时返回 `null`。
  - `seriesTitleFromRequirement` / `seriesPartCourseTitle`：标题相关的小工具函数（目前还没有消费方真正用上课程标题展示，留着给前端最小改动那一单元用）。
- `lib/server/generation/run/services.ts`：
  - 把 `analyzeMaterials` 里"读提取结果 → 按 `textRanges` 切片 → 组装 `ParsedDocumentPart[]`"这段循环抽成模块级函数 `extractOwnerMaterialParts(ownerId, materialIds, ctx, textRanges?)`，避免和新方法重复实现。
  - `RunStepServices` 新增 `planMaterialSeries(ownerId, materialIds, ctx): Promise<SeriesSplitPlan | null>`：读同一批材料的提取结果（不带 `textRanges`，即未切片的全量），喂给 `planSeriesSplit` 看是否超预算。调用时机只在"这个 run 自己不是系列某一分部"（`!input.seriesContext`）时才需要问一次——系列分部自己已经只读自己的切片，不会再触发二次拆分。
- `lib/server/generation/run/engine.ts`：
  - `material-analysis` 步骤：在原来调用 `analyzeMaterials` 之前，若 `!input.seriesContext`，先调用 `services.planMaterialSeries`；拿到非空结果时调用 `startCourseSeries` 落库，并把这个 run 自己的 `patch: { series: { seriesId, order: 1 } }` 随这一步的 `done()` 一起提交（复用已有的 `RunPatch.series` 写入路径，单元 2 里已经打通），同时把传给 `analyzeMaterials` 的 `textRanges` 换成这一部分（`plan.firstPart.textRanges`）而不是"不传"（即不再是全量）。
  - `complete()`：commit 完 `completed` 状态和事件之后，若 `run.series` 非空（这个 run 本身就是系列的某一分部），调用 `startNextSeriesPart`，构造下一部分的 `GenerationRunInput` 基础字段（`requirement`/`interactive`/`taskEngine`/`agents`/`learnerProfile`/`voice`，从刚完成的这个 run 自己的 `input` 上读）。**这是 fire-and-forget**：`.catch()` 只打日志，不重新抛出——失败不该拖垮这个 run 自己已经成功提交的 `completed` 状态；下一部分留在 `pending_parts` 里，等别的机制（目前还没有；见"已知缺口"）重试。

**已知缺口 / 需要后续单元关注**：

1. **`startNextSeriesPart` 失败后的重试机制还不存在**：如果某一部分 run 完成后紧接着调用 `startNextSeriesPart` 抛错（比如那一刻 owner 的并发 run 数已经顶到 `maxActiveRunsPerOwner`），这一部分会卡在 `pending_parts` 里，目前没有任何后台任务会再去扫一遍"有未启动分部但没有活跃 run 的系列"。短期内可接受（概率低，且日志会记录），但如果要做得稳妥，需要一个类似 sweep 的机制或者在 API 层加一个"手动续推"的入口。
2. **没有任何 HTTP 端点能读系列状态**：`getCourseSeries` 已经写好但未被任何路由调用。前端目前完全看不到"这门课是系列的第几部分/系列还有几部分没跑"。
3. **前端零改动**：超预算提示事件、系列徽标都还没做。
4. **集成测试 `course-series.test.ts` 未写**：这是风险最高的缺口——`material-analysis` 的晋升逻辑和 `complete()` 的自动续接逻辑目前只过了 `tsc`，没有任何测试真正跑过"一个超预算材料的 run 走到 completed，验证确实产生了第二个 run，且第二个 run 的 `seriesContext` 切片正确"这条路径。
5. **本机沙箱仍然没有 Postgres/Docker**（`pg_isready`、`docker` 命令都不存在），`*.pg.test.ts` 契约测试全程跳过。本单元改动的三个契约测试 fixture（`generate-classroom-api.pg.test.ts`、`generation-run-hooks.pg.test.ts`、`generation-runs.pg.test.ts`）只补了 `planMaterialSeries: async () => null` 让它们满足新的 `RunStepServices` 类型，**没有跑过**。务必在有 Postgres 的环境里至少跑一次这三个契约套件。

**验证**：
- `tsc --noEmit -p tsconfig.json`：全量通过。
- `vitest run tests/api/generate-classroom.test.ts tests/document/series-split.test.ts tests/server/generation/series-plan.test.ts`：59/59 通过（均为本单元改动波及但不直接测试新逻辑的回归面）。
- **未跑**：任何真正跑通"晋升为系列 → 完成 → 自动续接"流程的测试（见缺口 4）。

**Commit**：尚未提交（本单元代码已写完、`tsc` 已验证，等下一步补完集成测试或在提交前单独 commit 当前进度，由后续处理决定）。

---
