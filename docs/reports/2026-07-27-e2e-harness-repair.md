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

基础设施恢复后，5 项 Pro 编辑测试暴露出共同的旧入口假设：当前产品只在 URL 包含 `?editor=1` 时显示“Edit course”开关，旧测试直接进入普通课堂页，因此一直等待不存在的 `role="switch"`。

测试现改为通过正式编辑入口进入，再显式点击“Edit course”进入编辑态。这保留了真实的播放/编辑切换覆盖，不需要跳过测试或放宽超时。

定向复验：

- `quiz-content-surface-657.spec.ts`：2/2 通过。
- `interactive-iframe-keepalive-619.spec.ts`：1/1 通过。
- `slide-content-surface-647.spec.ts`：1/1 通过。
- `slide-scene-creation-gate.spec.ts`：1/1 通过。
