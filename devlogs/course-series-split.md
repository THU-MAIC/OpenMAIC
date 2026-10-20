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

**Commit**：`feat(generation): orchestrate course series split and auto-continue`

---

### 单元 5：`course_series` 表从未被真正建表的 bug + 集成测试

**发现的问题（阻断性，单元 4 当时漏掉了）**：`lib/persistence/course-series.ts` 里的 `ensureCourseSeriesSchema` 写完之后一直没有任何地方调用它——既不在 `lib/persistence/server-provider.ts` 的集中建表清单里（那份清单是给"所有部署都用得到"的核心表用的，故意不包含每个可选功能模块），也不像 `generation_runs` 自己那样有一段"懒加载建表"的代码。结果是：即使单元 4 的编排逻辑完全正确，一上真实环境第一次有材料超预算触发 `startCourseSeries` 时也会直接报表不存在的错——这个 bug 本可能一直潜伏到有人在生产环境第一次踩到超预算材料才暴露，而不是在任何单测里，因为所有非 pg 测试都 mock 掉了 `RunStepServices`，根本不会真的碰到 `course_series` 表。

**修复**：参照 `lib/server/generation/run/store.ts` 里 `generation_runs` 自己的懒加载建表写法（`provider()` 内部用 `globalThis` 挂一个按 connection string 做键的"建表完成" promise，第一次用到时在 `withSchemaBootstrapLock` 下跑 `ensureXxxSchema`），在 `lib/server/generation/series/orchestrator.ts` 里加了一份同构的 `provider()`，`startCourseSeries`/`startNextSeriesPart` 都改为经过它取 `pool`，不再直接调用 `getServerPersistenceProvider`。同时导出 `resetCourseSeriesSchemaForTests()`，供测试在 `beforeAll`/`afterAll` 里跟 `resetGenerationRunSchemaForTests()` 配对清掉缓存的 ready-promise（否则多个 `.pg.test.ts` 文件各自起/删 schema 时会互相串）。

**集成测试**：`tests/server/course-series.pg.test.ts`（新增，`.pg.test.ts` 命名与 `describe.skipIf(!contractUrl)` 跳过机制，和 `generation-runs.pg.test.ts` 完全一致的套路——engine 的 `RunStepServices` 全部用 fake，真实的是 run store、`course_series` 表和 engine 自己的 `complete()` 续接路径）：

- 第一个用例是本功能最核心的端到端路径：造一个 `planMaterialSeries` 会返回两段计划的 fake，启动一个普通 run（此刻 `run.series` 为 `null`，系列还不存在）→ 跑到 `completed`，断言这个 run 的 `material-analysis` 步骤只拿到了第 1 部分自己的 `textRanges`（不是全量材料），断言完成后的 run 自己的 `series` 字段变成了 `{ seriesId, order: 1 }`，断言 `course_series` 表里确实多了一行、`partCount` 为 2。再用 `vi.waitFor` + `listGenerationRunsUpdatedSince`（而不是直接等某个已知 id，因为第 2 部分的 run 是引擎内部 fire-and-forget 创建的，测试事先并不知道它的 id）等到第 2 部分的 run 出现，断言它的 `seriesContext`、`outlineReview: 'auto'`、`materialIds` 都符合预期。把第 2 部分也跑到完成后，断言系列的 `pendingParts` 清空，且没有凭空多出一个"第 3 部分"的 run（两部分的系列，不该有第三个）。
- 第二个用例是回归性质的对照组：`planMaterialSeries` 返回 `null` 的一个普通 run 跑完之后 `series` 必须仍然是 `null`，确认这套改动没有让不需要拆分的材料也被误判。

**本单元也顺手做的小事**：`startNextSeriesPart` 的输入基础字段（`requirement`/`interactive`/`taskEngine`/`agents`/`learnerProfile`/`voice`）是从刚完成的那个 run 自己的 `input` 上现读的（`engine.ts` 的 `complete()` 内），测试里断言了下一部分的 `input.materialIds`/`outlineReview` 确实是按这条路径算出来的，不是沿用了第一部分 run 创建时测试自己传的那份 `runInput()`。

**验证**：
- `tsc --noEmit -p tsconfig.json`：全量通过。
- `vitest run tests/server/course-series.pg.test.ts ...`：新文件在没有 `PG_CONTRACT_URL` 时被 `describe.skipIf` 正确跳过（2 skipped），不报错，说明文件本身能被测试运行器正常加载、类型和导入都没问题。
- **仍未能验证**：这个新集成测试的两个用例实际跑起来是否真的通过——本机沙箱没有 Postgres 也没有 Docker，`PG_CONTRACT_URL` 从未被设置过，所以 `describe.skipIf` 全程跳过真正的测试体。**这是目前最大的风险点**：`startCourseSeries`/`startNextSeriesPart`/`claimNextPendingSeriesPart` 这些直接动 `course_series` 表的函数，以及 engine 里 `material-analysis` 晋升和 `complete()` 自动续接这两段逻辑，到目前为止只被 `tsc` 验证过类型，从未被任何测试真正执行过一次。接手后第一件事应该是找一个有 Postgres（或能跑 `docker compose up -d postgres` 之类）的环境，设置 `PG_CONTRACT_URL` 后跑一次这个文件，把这里记录的"预期行为"和真实行为对一遍。

**Commit**：`fix(generation): bootstrap course_series schema lazily; add integration test`（提交时一并包含本单元的 bug 修复和新测试文件）。

---

### 单元 6：系列状态读取端点 `GET /api/course-series/:id`

**改动**：

- `lib/server/generation/series/orchestrator.ts`：新增 `getCourseSeriesById(ownerId, seriesId)`，走模块自己懒加载的 `provider()`（和 `startCourseSeries`/`startNextSeriesPart` 同一套，保证在表还没被任何写入建过的情况下，一次纯读也能先把表建出来再查）包一层 `getCourseSeries`。
- `app/api/course-series/[id]/route.ts`（新增）：`GET`，`withRequestOwner` 鉴权，查不到或属于别的 owner 都答统一的 404（`ownerNotFound`），避免把"系列存在但不是你的"和"系列不存在"区分开泄露信息。返回体只给前端真正缺的那一样东西——系列总分部数（`partCount`）和还没开始的分部数（`pendingPartCount`）——因为某一分部自己的课程内容和生成进度，前端已经能从它自己的 `generation_runs` 快照（`series: { seriesId, order }`）或生成后的 `stage_meta` 镜像字段里读到，不需要这个端点重复给。

**验证**：`tsc --noEmit -p tsconfig.json` 全量通过；路由文件本身没有专门的单测（和同类的 owner-scoped 只读路由一致，走契约测试间接覆盖），本机沙箱无 Postgres，`.pg.test.ts` 契约套件无法运行验证。

---

### 单元 7：前端——`series` 字段穿透 + 系列徽标 + 超预算提示

**改动**：

- `lib/server/generation/run/types.ts` 原有的 `GenerationRunSeriesMembership`（`{ seriesId, order }`）通过 `lib/generation-run-client/types.ts` 重新导出给客户端用；`RunSnapshot.series` 本就在服务端类型上，这次补上 `RunView.series`，并在 `reducer.ts` 的 `viewFromSnapshot` 里把它从快照搬进视图（`applyRunEvent` 每次都 `{...view}` 展开，`series` 本身不随事件变化，天然原样传递下去，不用在每个 `case` 里显式搬一次）。
- `lib/generation-run-client/api.ts`：新增 `CourseSeriesInfo` 类型和 `fetchCourseSeries(seriesId)`，对应单元 6 的新端点。
- `lib/generation-run-client/use-course-series.ts`（新增）：`useCourseSeriesPartCount(seriesId)`——`run.series` 只有 `order`，没有系列总分部数，徽标要显示"第 2 部分 / 共 5 部分"就还需要一次按 `seriesId` 的额外读。首页课程网格里，同一系列的多张卡（一张一个分部）会并发用到同一个 `seriesId`，所以用模块级 `Map` 做跨组件实例的缓存 + in-flight 请求去重，不是每张卡各自发一次请求。按 React 19 的 `set-state-in-effect` lint 规则重写过一次：组件渲染期间先从缓存里同步算出当前该显示的值，`useEffect` 只在缓存未命中时负责发请求、在 then 里 `setState` 一次，不在 effect 里做"根据 prop 同步清空"这种纯派生的 `setState`。
- `components/generation/course-series-badge.tsx`（新增）：`<CourseSeriesBadge seriesId order />`，拿不到 `partCount`（仍在加载或系列已不存在）时不渲染任何东西，不占位不闪烁。
- `app/page.tsx`：`ClassroomCard` 新增 `series` prop，徽标渲染在原有的"运行状态/页数"那一行旁边；两处调用点（待开始的 pending run 卡、已有课程卡）分别从 `run.series` 和 `runByStageId.get(id)?.series` 取值传入。
- `app/generation-preview/page.tsx`：新增一个 `useEffect`，在 `view.series` 第一次出现非空值时（`seriesNoticeShownRef` 保证只触发一次，系列归属定了之后不会再变，不需要重复提示），额外调一次 `fetchCourseSeries` 拿 `partCount`，用 `toast.info` 弹一条"材料较长，已拆成 N 门课程依次生成，这是第 M 部分"的提示。没有复用 `view.series` 自带的 `order` 之外的信息，所以这里必须单独请求一次系列总数——和首页徽标是同一个数据缺口，但这两处没有共享同一次请求（场景不同：首页是网格里多张卡同时存在，这里只有一个正在跟随的 run），所以没有强行合并成同一个缓存实例。
- 12 个 locale 文件新增两个 key：`classroom.seriesBadge`（"Part {{order}} of {{total}}"及各语言对应说法）、`classroom.seriesSplitNotice`（超预算拆分提示文案），`en-US.json`/`zh-CN.json` 为基准手写，其余 10 个语言请求模型给出地道翻译后逐一核对占位符一致。

**未覆盖范围（有意不做，避免超出本单元最小改动的目标）**：

- `components/workbench/workspace/WorkspaceRail.tsx` 的课程侧边栏行（`renderCourseRow`/`renderPendingRunRow`）没有加徽标：生成中的行已经没有空间再塞一个徽标进 `meta` 文案槏，已完成课程的行在渲染时作用域里根本拿不到对应的 `run`/`series`（只有 `StageListItem`），要补上得单独按 `stageId` 查一次 `generation_runs`，是比这次"最小穿透"更大的改动，留给后续单元看是否真的需要。
- 没有为 `app/page.tsx`、`app/generation-preview/page.tsx`、`course-series-badge.tsx`、`use-course-series.ts` 写新的单测——这几处目前都没有对应的测试文件（`tests/` 下找不到任何 `*page*`/`*generation-preview*` 的既有测试），新增的是纯前端展示层（取数 → 渲染字符串/条件渲染），逻辑已经在 `reducer.test.ts`（`viewFromSnapshot`/`applyRunEvent`）和服务端契约测试里覆盖过"`series` 字段何时出现、何时不变"这一核心行为；本单元新增代码本身只做类型回归验证（`tsc`）和既有回归套件（`vitest run tests/generation-run-client`，78/78 通过）。

**验证**：
- `tsc --noEmit -p tsconfig.json`：全量通过。
- `node scripts/check-i18n-keys.mjs`：12 个 locale 文件 key 对齐检查通过。
- `eslint`（按改动文件逐一跑，全量 `eslint .` 在本机因仓库过大导致 Node OOM 崩溃，与本次改动无关）：本单元新增/改动的 8 个文件全部无 warning/error（修了两处：`use-course-series.ts` 里一处 `react-hooks/set-state-in-effect` 真错误，`course-card.ts` 里一处未用到的类型导入）。
- `vitest run tests/generation-run-client tests/components/generation tests/app/generation-preview tests/app/page`：后两个目录不存在（预期内，见上）；`tests/generation-run-client` 全量 12 个文件 78 个测试通过。
- 未验证：`tests/server/course-series.pg.test.ts`（本机沙箱无 Postgres/Docker，契约测试全程 `skipIf` 跳过，同单元 5 遗留的风险点）。

**Commit**：本次提交只纳入本单元（6+7）新增/改动的文件；工作树里另有一批与本系列无关、看起来是别的工作在进行中的改动（`README.md`、`package.json`、`.gitignore`、`openmaic.example.yml`、`e2e/tests/home-to-generation.spec.ts`、`lib/server/generation/run/deadline.ts`、`lib/server/generation/run/document.ts`、`packages/docs/content/docs/deployment.zh-cn.mdx`、`.zcode/`、`data/`、`public/tmp-verify/`、`scripts/start-all.mjs`、`tests/audio/cosyvoice-tts.test.ts`、`public/logos/cosyvoice.svg`），不属于 course-series 这条线，本次未touch、未纳入提交。

---
