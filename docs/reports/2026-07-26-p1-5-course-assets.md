# P1.5 报告：课程资产外置与存量迁移

> 日期：2026-07-26  
> 状态：代码与存量迁移完成；Vercel guard 切换待部署冒烟后执行

## 结果

- 新增公开 Supabase Storage bucket：`course-assets`。
- 对象路径统一为 `courses/{courseId}/{images|audio}/{sha256}.{ext}`，课程 JSON 中只保留 `https` URL 字符串。
- 浏览器先向服务端申请签名上传 URL；服务端验证登录态和已有课程的 owner/admin 权限；资产二进制直接从浏览器写入 Storage，不经过课程 JSON POST。
- `saveStageToCloud` 在上传边界深拷贝并外置 `stage.data.imageMapping`、`action.audioUrl`、`scene.narrationAudioUrl` 的全部 `data:` URI，随后调用 `stripRuntimeOnly()`。
- 本地课程在云端保存成功后也回写成 URL，避免下一次保存重复处理。所有语音发布同样改走该路径，旧的 `classrooms/...` 写路径不再被新代码使用。

## 加载回退

- 移动端 URL 加载失败时，若该语音带有 `audioId` 且 IndexedDB `audioFiles` 有 blob，则切换到本地 object URL。
- 若失败的是可选的 `narrationAudioUrl` 且无本地 blob，则改用已有的逐条 speech-action 音频段播放。

## 存量迁移

脚本：`scripts/migrate-course-assets.js`

- 幂等：仅处理 `data:` URI，已是 URL 的资产跳过；对象名基于 SHA-256，可安全重跑。
- 可续跑：正式迁移把最后成功的课程 id 写入 `checkpoint.json`；dry-run 每次全量审计。
- 报告：每次写 `before.json` 和 `after.json`，记录课程数、资产数、payload 估算字节及失败项。

本次实际执行（已连接当前 `.env.local` 配置的 Supabase 项目）：

| 项目 | 结果 |
|---|---:|
| 扫描课程 | 6 |
| 发现/迁移图片 | 0 |
| 发现/迁移音频 | 0 |
| 更新课程 | 0 |
| 失败 | 0 |
| payload 节省 | 0 B |

详见 `docs/reports/course-assets-migration/before.json` 与 `after.json`；这是正常结果，说明该项目当前存量没有内联 base64 资产。

## 验证

- `npx tsc --noEmit --pretty false`：通过。
- `npx vitest run tests/course-assets/externalize.test.ts tests/dsl/extensions-canary.test.ts`：11/11 通过。
- `node --check scripts/migrate-course-assets.js`：通过。

## 上线收尾

1. 部署本提交，在登录账号下保存一门包含图片和语音的新课程；确认课程 JSON 只包含 `https://` URL，Storage 路径符合 `courses/{courseId}/...`。
2. 让 URL 加载失败时验证本地 `audioFiles` blob 回退；旁白则验证逐段语音回退。
3. 在 Vercel Project Settings → Environment Variables 将 `NEXT_PUBLIC_DSL_ASSET_GUARD_MODE` 设为 `error`，仅修改变量并重新部署。
4. 用 B 账号 DevTools 直接 POST A 的课程，确认仍为 403；并将 `NEXT_PUBLIC_LEGACY_AUTOSAVE=0` 后验证手动保存。
