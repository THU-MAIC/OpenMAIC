# CI E2E 与 Supabase Snapshot 环境修复报告

> 日期：2026-07-27
> 范围：修复 CI E2E WebServer 缺少构建期 Supabase 环境变量的问题；记录 Supabase snapshot 的外部配置前提。

## E2E 根因与修复

GitHub Actions 的 E2E job 在运行 Playwright 前执行 `pnpm build && pnpm start`。构建期会加载服务端 route module，而 `getServiceSupabase()` 会拒绝缺少 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 的环境，因此 WebServer 尚未启动便退出。

E2E job 现仅注入以下不可连接的占位值：

- `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`：`https://ci.invalid.supabase.co`；
- `SUPABASE_ANON_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`：占位字符串；
- `SUPABASE_SERVICE_ROLE_KEY`：占位字符串。

这些值不具备任何 Supabase 权限，也不会影响 Vercel、生产运行时或浏览器生产配置。E2E 对 Supabase-facing 请求使用测试 mock；此改动只让 Next 可以完成模块求值与构建。

使用同一组占位变量的本地 `next build` 通过，生成 57/57 页面，包含此前失败的 `/api/courses/[id]/assignments`。

## Supabase Snapshot 根因

workflow YAML 解析错误修复后，`supabase link` 明确报出：`SUPABASE_ACCESS_TOKEN` 未提供。

这属于 GitHub Repository Secret 缺失，不是应用代码故障。需在 GitHub 仓库的 `Settings → Secrets and variables → Actions` 配置以下三个 Repository Secrets：

- `SUPABASE_ACCESS_TOKEN`；
- `SUPABASE_PROJECT_REF`；
- `SUPABASE_DB_PASSWORD`。

其中本次已确认缺失的是 `SUPABASE_ACCESS_TOKEN`；其余两项会在 link 成功后的后续步骤继续验证。

## 未处理项

- CI ESLint 的历史基线 errors 未在本任务中修改；
- E2E 的具体断言结果需在 GitHub 下次 CI 运行中确认；
- Node 20 deprecation 为 GitHub Actions 依赖的 warning，不是本次失败原因。
