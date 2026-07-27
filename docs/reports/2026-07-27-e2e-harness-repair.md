# E2E 测试基线修复：基础设施根因记录

日期：2026-07-27

## 已修复的共同根因

E2E 在 CI 中使用 `output: standalone` 启动 Next 服务，但 standalone 输出不会自动携带 `.next/static` 浏览器资源。此前启动命令直接运行 `node .next/standalone/server.js`，导致浏览器 JS chunk 大量 404，页面没有完成 hydration，并表现为认证等待、IndexedDB 播种超时或课堂永久加载。

现在 CI 启动前会复制 `.next/static` 到 `.next/standalone/.next/static`。

此外，浏览器 E2E 不再依赖伪造 Supabase cookie；仅在 CI 的 `E2E_TEST_MODE=1` 构建中，将客户端 `useAuth` 替换为固定教师会话。Vercel 未设置该变量，生产仍使用真实 Supabase Auth。

## IndexedDB 播种

四组直接写入 `MAIC-Database` 的测试统一使用同源测试页预建库，避免与应用 Dexie 初始化竞争。Dexie 逻辑版本 15 对应原生 IndexedDB 版本 150，辅助程序按 150 创建完整当前 schema。

## 本地验证

- E2E 构建：成功，58 个页面。
- `classroom-interaction.spec.ts`：2/2 通过，5.8 秒。
- `recent-video-thumbnail.spec.ts`：已观察到 2/3 通过。

## 未掩盖的遗留失败

基础设施恢复后，部分历史 E2E 断言开始暴露真实 UI 漂移。例如 `interactive-iframe-keepalive-619.spec.ts` 仍等待当前课堂页不存在的 `role="switch"`。这类失败不应通过跳过测试或放宽超时掩盖；后续需逐项将断言更新为当前可访问 UI，并保留原业务覆盖意图。
