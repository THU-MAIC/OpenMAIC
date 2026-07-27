# B2.1：DocumentStore 本地安全桥接

> 日期：2026-07-27  
> 范围：把已成功读取的 Dexie 课程在后台复制到上游 BrowserDocumentStore；不切换课程读写权威。

## 决策与边界

- 开关：`NEXT_PUBLIC_DOCUMENT_STORE_BRIDGE=0` 为默认。仅值为 `1` 才启用；关闭后完全绕过 DocumentStore，Dexie 继续是唯一读写路径。
- 本期没有 RuntimeStore、learnerKey、Supabase schema/RLS 或云同步语义变更。
- 不修改 `packages/@openmaic/*`。RJ 层注入 `validateSceneExtended`，并在写前执行 `validateStageExtended`。
- 聊天、播放状态、媒体 blob、生成任务仍留在旧 Dexie。DocumentStore 的 opaque outline 保存完整 `stageOutlines` 记录，避免丢失 `generationComplete` 和时间字段。

## 账号隔离

上游 `BrowserDocumentStore` 默认是设备级 `maic-documents`，不会按账号隔离；上游 KVStore 的 scope 不适用于课程文档。

RJ 将数据库名设为：

```text
rj-maic-documents-v1-{SHA-256(user.id) 的前 32 位十六进制字符}
```

32 个十六进制字符等于 128 bit。按 100,000 账号的 birthday-bound 估算，命名空间碰撞概率约 `1.5 × 10^-29`。桥接台账也使用同一账号命名空间，且浏览器中不保存原始 user id。

历史 Dexie 数据没有可靠的创建者字段，无法安全倒推出归属；因此本期只保证**新建的 DocumentStore 副本**按当前登录账号隔离，不宣称修复旧 Dexie 的设备级历史缓存。旧 Dexie 账号隔离/登出清理由后续独立任务处理。

## 失败安全与幂等

每个 `账号 + 课程` 在 RJ 自己的桥接台账里有 `in_progress`、`migrated`、`failed` 三种显式状态，以及源数据 SHA-256 指纹、桥接版本、时间和短错误类别。

- 校验、IndexedDB、配额或身份异常均只将台账标为 `failed`；页面已先从 Dexie 加载，绝不因此白屏或中断编辑。
- 同一指纹的成功或失败不会重复桥接；源数据或桥接版本变化时可安全重试。
- `in_progress` 超过 5 分钟视为中断，可重新执行。
- 写入只复制数据，绝不删除或修改旧 Dexie 数据；DocumentStore 的整门课程写入由上游单个 IndexedDB transaction 原子完成。

## 性能与诊断

桥接不会由课程列表触发，只在课程已从 Dexie 成功打开后以 idle callback（无支持时延迟 250ms）进入单线程队列。用户不等待桥接完成。

新增经过登录校验和每用户每分钟 30 次限流的 `/api/client-diagnostics`：

- 成功：仅上报桥接版本、成功标记、耗时区间；无课程 ID，作为成功率分母。
- 失败：另附课程 ID 和受控错误类别，不发送课程正文、场景内容、音频、堆栈或密钥。
- 数据写入 Vercel 日志，不新增数据库表；诊断请求本身失败会被忽略。

## 后续阶段

1. B2.1 在受控环境开启后，确认桥接失败不影响 Dexie 课程打开。
2. B2.2 另立项：对同一课程的 Dexie 与 DocumentStore 做只读结构指纹比对，收集成功率、失败类型、性能。
3. B2.3 再决定 DocumentStore 是否成为主读写源；该阶段仍必须保留 Dexie 回退与独立开关。

## 本地验收

- `tsc --noEmit`：通过。
- DocumentStore bridge 单测：6/6 通过，覆盖 128-bit 命名空间、成功/失败诊断载荷、正常桥接、DocumentStore 校验失败自动降级、开关关闭完全不访问新存储。
- 与既有防线合跑：DSL extension canary、场景顺序迁移、分享链接读取授权，共 21/21 通过。
- `next build`：Turbopack 编译、类型检查及 58/58 页面生成通过；新增 `/api/client-diagnostics` 路由可被识别。

## 本机依赖工具说明

本机 `pnpm install --lockfile-only` 被 pnpm 10 的签名/registry 网络校验阻断（`EACCES`），没有改写 lockfile。`@openmaic/storage` 是现有 workspace 包，因此手工加入根 importer 的 `workspace:*` link；差异仅为该一条工作区依赖，生产安装仍由 Vercel 的正常 pnpm install 验证。
