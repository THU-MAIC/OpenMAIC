# CI 基线修复：E2E 认证夹具与变更级质量门禁

> 日期：2026-07-27
> 范围：修复 GitHub Actions CI 的既有失败；不改变生产认证、课程、Supabase 或 RuntimeStore 语义。

## 根因

本轮失败不是 `47d723e8` 的场景顺序迁移报告导致的：该提交只新增报告。CI 在每次 push 都运行，因此它暴露了两项既有基线问题：

1. E2E 先往 IndexedDB 写入课堂夹具，但没有建立 Supabase 登录态。课堂页现已正确要求已登录用户，测试会在 `beforeEach` 后停留在认证/跳转路径并超时。
2. 非 Vercel 环境启用 Next standalone 输出；CI 却以 `next start` 启动。该命令不支持 standalone 输出，应运行 `.next/standalone/server.js`。
3. 全仓 `prettier . --check` 和 `eslint` 会扫描大量早于本任务的历史问题，无法作为新增改动的有效门禁；先前 Prettier 已报告 1252 个历史格式问题。

## 修复

- Playwright 基础夹具建立仅用于 E2E 的合成 Supabase cookie，并拦截 CI 的 inert Supabase profile 请求。课堂页仍执行原有 `useAuth()` 和生产认证门禁，未新增生产绕过分支。
- CI 的 standalone 服务改为 `node .next/standalone/server.js`。
- `pnpm check` 与 `pnpm lint` 改为检查当前 push/PR 中新增、修改或重命名的受支持文件；CI checkout 改为完整历史，以便可靠取得 base commit。全仓历史清理另立任务，禁止用全局格式化混入功能提交。
- 生成路由单测在认证保护上线后补齐测试专用的已授权教师 mock；生产认证并未放宽。浏览器型单测在未提供 `.env.local` 时使用 inert Supabase public URL/key。
- Vitest 文件级并发会让旧的全局 mock/计时器型重试测试互相干扰：并发全量运行出现超时，而串行文件运行稳定。因此 `pnpm test` 固定为 `vitest run --no-file-parallelism`。

## 验收

| 检查 | 结果 |
| --- | --- |
| standalone `next build` | ✅ 58/58 pages |
| TypeScript `tsc --noEmit` | ✅ |
| 变更级 Prettier 检查 | ✅ |
| 变更级 ESLint 检查 | ✅ |
| 全量 Vitest（串行文件） | ✅ 251 files / 2017 tests，约 150 秒 |
| 本地 Playwright 浏览器运行 | ⚠️ 未执行：本机未安装 Chromium；GitHub CI 会在运行前执行 `playwright install chromium --with-deps` |

## 回滚

若 CI 后续显示夹具兼容性问题，可单独 `git revert` 本提交；生产代码和本地用户数据均不受本次变更影响。
